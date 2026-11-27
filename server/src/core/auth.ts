import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/db";
import { randomToken, sha256 } from "../lib/crypto";
import { getSettings } from "../lib/settings";
import { audit, type Actor } from "../lib/audit";
import { ForbiddenError } from "../lib/errors";
import type { PermissionKey } from "../lib/permissions";
import { isProd } from "../config/env";

/** Separate cookies so a guest session and a staff session never mix. */
export const COOKIE = { STAFF: "asher_staff", GUEST: "asher_guest" } as const;
type Portal = keyof typeof COOKIE;

export type StaffCtx = {
  user: { id: string; email: string; firstName: string; lastName: string; mustChangePassword: boolean; jobTitle: string | null };
  name: string; roleNames: string[]; roleKeys: string[]; permissions: Set<PermissionKey>; actor: Actor; can: (p: PermissionKey) => boolean;
};
export type GuestCtx = {
  user: { id: string; email: string; firstName: string; lastName: string; phone: string | null; emailVerifiedAt: Date | null; notificationPrefs: unknown };
  guestId: string; name: string; actor: Actor;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { staff?: StaffCtx | null; guest?: GuestCtx | null }
  }
}

export function meta(req: Request) {
  return { ip: req.ip ?? null, userAgent: req.get("user-agent") ?? null };
}

function cookieOpts(expires?: Date) {
  return { httpOnly: true, sameSite: "lax" as const, secure: isProd(), path: "/", expires, ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}) };
}

export async function createSession(req: Request, res: Response, userId: string, portal: Portal) {
  const s = await getSettings();
  const hours = portal === "STAFF" ? s.security.staffSessionHours : s.security.guestSessionHours;
  const token = randomToken();
  const expiresAt = new Date(Date.now() + hours * 3600_000);
  const m = meta(req);
  await prisma.session.create({ data: { tokenHash: sha256(token), userId, portal, ipAddress: m.ip, userAgent: m.userAgent?.slice(0, 300), expiresAt } });
  res.cookie(COOKIE[portal], token, cookieOpts(expiresAt));
}

export async function destroySession(req: Request, res: Response, portal: Portal) {
  const token = req.cookies?.[COOKIE[portal]];
  if (token) await prisma.session.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
  res.clearCookie(COOKIE[portal], cookieOpts());
}

async function loadSession(req: Request, portal: Portal) {
  const token = req.cookies?.[COOKIE[portal]];
  if (!token) return null;
  const s = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } }, guest: true } } },
  });
  if (!s || s.revokedAt || s.expiresAt < new Date() || s.portal !== portal || !s.user.isActive || s.user.type !== portal) return null;
  if (Date.now() - s.lastSeenAt.getTime() > 60_000) await prisma.session.update({ where: { id: s.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  return s;
}

export async function getStaff(req: Request): Promise<StaffCtx | null> {
  if (req.staff !== undefined) return req.staff;
  const s = await loadSession(req, "STAFF");
  if (!s) return (req.staff = null);
  const permissions = new Set<PermissionKey>();
  for (const ur of s.user.roles) for (const rp of ur.role.permissions) permissions.add(rp.permission.key as PermissionKey);
  const roleNames = s.user.roles.map((r) => r.role.name);
  const name = `${s.user.firstName} ${s.user.lastName}`;
  const m = meta(req);
  return (req.staff = {
    user: { id: s.user.id, email: s.user.email, firstName: s.user.firstName, lastName: s.user.lastName, mustChangePassword: s.user.mustChangePassword, jobTitle: s.user.jobTitle },
    name, roleNames, roleKeys: s.user.roles.map((r) => r.role.key), permissions,
    actor: { userId: s.user.id, name, role: roleNames.join(", ") || null, ip: m.ip, userAgent: m.userAgent, type: "STAFF" },
    can: (p) => permissions.has(p),
  });
}

export async function getGuest(req: Request): Promise<GuestCtx | null> {
  if (req.guest !== undefined) return req.guest;
  const s = await loadSession(req, "GUEST");
  if (!s || !s.user.guest) return (req.guest = null);
  const name = `${s.user.firstName} ${s.user.lastName}`;
  const m = meta(req);
  return (req.guest = {
    user: { id: s.user.id, email: s.user.email, firstName: s.user.firstName, lastName: s.user.lastName, phone: s.user.phone, emailVerifiedAt: s.user.emailVerifiedAt, notificationPrefs: s.user.notificationPrefs },
    guestId: s.user.guest.id, name,
    actor: { userId: s.user.id, name, role: "guest", ip: m.ip, userAgent: m.userAgent, type: "GUEST", guestId: s.user.guest.id },
  });
}

/** Throws unless a staff member with ANY of the given permissions is signed in. Denials are audited. */
export async function staff(req: Request, ...anyOf: PermissionKey[]): Promise<StaffCtx> {
  const s = await getStaff(req);
  if (!s) throw new ForbiddenError("Your session has expired. Please sign in again.");
  if (s.user.mustChangePassword && !req.path.startsWith("/auth") && !req.path.startsWith("/me")) throw new ForbiddenError("Please change your temporary password first.");
  if (anyOf.length && !anyOf.some((p) => s.can(p))) {
    await audit(prisma, s.actor, { action: "permission.denied", module: "security", newValues: { required: anyOf, path: req.originalUrl }, outcome: "DENIED" }).catch(() => {});
    throw new ForbiddenError();
  }
  return s;
}

export async function guest(req: Request): Promise<GuestCtx> {
  const g = await getGuest(req);
  if (!g) throw new ForbiddenError("Your session has expired. Please sign in again.");
  return g;
}

/**
 * CSRF defence for cookie sessions: state-changing requests must come from an allowed origin and carry the
 * custom header the client sets (browsers will not add it cross-site without a CORS pre-flight we refuse).
 */
export function csrfGuard(origins: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.path.startsWith("/api/payments/paystack/webhook") || req.path === "/api/cron") return next();
    const origin = req.get("origin");
    const sameHost = origin && new URL(origin).host === req.get("host");
    if (req.get("x-requested-with") !== "asher-client" || (origin && !sameHost && !origins.includes(origin))) {
      return res.status(403).json({ ok: false, message: "Request blocked (cross-site)." });
    }
    next();
  };
}
