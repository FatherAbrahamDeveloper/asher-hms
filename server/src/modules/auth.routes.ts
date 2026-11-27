import { Router } from "express";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/db";
import { audit } from "../lib/audit";
import { AppError } from "../lib/errors";
import { hashPassword, passwordProblems } from "../lib/password";
import { zEmail, zPhone, zReq } from "../lib/validation";
import { authenticate, changePassword, registerGuest, requestPasswordReset, resendVerification, resetPassword, verifyEmail } from "../services/auth";
import { createSession, destroySession, getGuest, getStaff, guest, meta } from "../core/auth";
import { body, form, h } from "../core/http";
import { unreadCount } from "../lib/notify";

/** Brute-force protection in addition to the per-account lockout recorded in the database. */
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 50, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many attempts. Please wait a few minutes and try again." } });
const pw = z.object({ password: z.string(), confirm: z.string() }).refine((v) => v.password === v.confirm, { message: "Passwords do not match", path: ["confirm"] });

export const authRoutes = Router();

// ───────── Guests ─────────
authRoutes.post("/guest/register", limiter, form, h(async (req, res) => {
  const d = z.object({ firstName: zReq("First name", 60), lastName: zReq("Last name", 60), email: zEmail, phone: zPhone, password: z.string(), confirm: z.string() })
    .refine((v) => v.password === v.confirm, { message: "Passwords do not match", path: ["confirm"] }).parse(body(req));
  const { user } = await registerGuest(d, meta(req));
  await createSession(req, res, user.id, "GUEST");
  return { ok: true, message: "Welcome! Your account is ready." };
}));

authRoutes.post("/guest/login", limiter, form, h(async (req, res) => {
  const d = z.object({ email: zEmail, password: z.string().min(1, "Enter your password") }).parse(body(req));
  const r = await authenticate(d.email, d.password, "GUEST", meta(req));
  if (!r.ok) throw new AppError(r.message);
  await createSession(req, res, r.userId, "GUEST");
  return { ok: true };
}));

authRoutes.post("/guest/logout", form, h(async (req, res) => {
  const g = await getGuest(req);
  if (g) await audit(prisma, g.actor, { action: "auth.logout", module: "security", recordType: "User", recordId: g.user.id });
  await destroySession(req, res, "GUEST");
  return { ok: true };
}));

authRoutes.get("/guest/me", h(async (req) => {
  const g = await getGuest(req);
  if (!g) return { user: null };
  return { user: { ...g.user, name: g.name, guestId: g.guestId }, unread: await unreadCount(g.user.id) };
}));

authRoutes.post("/guest/forgot-password", limiter, form, h(async (req) => {
  const { email } = z.object({ email: zEmail }).parse(body(req));
  await requestPasswordReset(email, "GUEST", meta(req));
  return "If an account exists for that email, a reset link has been sent. Check your inbox.";
}));

authRoutes.post("/reset-password", limiter, form, h(async (req) => {
  const d = z.object({ token: z.string().min(10) }).and(pw).parse(body(req));
  const type = await resetPassword(d.token, d.password, meta(req));
  return { ok: true, message: "Password updated. Please sign in.", data: { portal: type } };
}));

authRoutes.post("/guest/verify-email", form, h(async (req) => {
  const { token } = z.object({ token: z.string().min(10) }).parse(body(req));
  await verifyEmail(token);
  return "Your email address is verified. Thank you!";
}));

authRoutes.post("/guest/resend-verification", form, h(async (req) => {
  const g = await guest(req);
  await resendVerification(g.user.id);
  return "Verification email sent.";
}));

authRoutes.post("/guest/change-password", form, h(async (req) => {
  const g = await guest(req);
  const d = z.object({ current: z.string().min(1, "Enter your current password") }).and(pw).parse(body(req));
  await changePassword(g.actor, d.current, d.password);
  return "Password changed.";
}));

// ───────── Staff ─────────
authRoutes.post("/staff/login", limiter, form, h(async (req, res) => {
  const d = z.object({ email: zEmail, password: z.string().min(1, "Enter your password") }).parse(body(req));
  const r = await authenticate(d.email, d.password, "STAFF", meta(req));
  if (!r.ok) throw new AppError(r.message);
  await createSession(req, res, r.userId, "STAFF");
  return { ok: true, data: { mustChangePassword: r.mustChangePassword } };
}));

authRoutes.post("/staff/logout", form, h(async (req, res) => {
  const s = await getStaff(req);
  if (s) await audit(prisma, s.actor, { action: "auth.logout", module: "security", recordType: "User", recordId: s.user.id });
  await destroySession(req, res, "STAFF");
  return { ok: true };
}));

authRoutes.get("/staff/me", h(async (req) => {
  const s = await getStaff(req);
  if (!s) return { user: null };
  return { user: { ...s.user, name: s.name, roleNames: s.roleNames, roleKeys: s.roleKeys, permissions: [...s.permissions] }, unread: await unreadCount(s.user.id) };
}));

authRoutes.post("/staff/forgot-password", limiter, form, h(async (req) => {
  const { email } = z.object({ email: zEmail }).parse(body(req));
  await requestPasswordReset(email, "STAFF", meta(req));
  return "If a staff account exists for that email, a reset link has been sent. You can also ask an administrator to reset your password.";
}));

authRoutes.post("/staff/change-password", form, h(async (req) => {
  const s = await getStaff(req);
  if (!s) throw new AppError("Please sign in again.");
  const d = z.object({ current: z.string().min(1) }).and(pw).parse(body(req));
  await changePassword(s.actor, d.current, d.password);
  return "Password changed.";
}));

/** One-time creation of the first Super Administrator, protected by SETUP_TOKEN from the server environment. */
authRoutes.post("/staff/setup", limiter, form, h(async (req, res) => {
  const d = z.object({ token: z.string().min(1, "Enter the setup token"), firstName: zReq("First name", 60), lastName: zReq("Last name", 60), email: zEmail }).and(pw).parse(body(req));
  const expected = process.env.SETUP_TOKEN;
  if (!expected || expected === "REPLACE_ME") throw new AppError("SETUP_TOKEN is not configured on the server.");
  const a = Buffer.from(d.token), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new AppError("Invalid setup token.");
  if (await prisma.user.count({ where: { type: "STAFF" } })) throw new AppError("Setup has already been completed.");
  const problem = passwordProblems(d.password, 10);
  if (problem) throw new AppError(problem);
  const role = await prisma.role.findUnique({ where: { key: "super_admin" } });
  if (!role) throw new AppError("Roles are missing. Run the database seed first (npm run db:seed).");
  const m = meta(req);
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({ data: { type: "STAFF", email: d.email, firstName: d.firstName, lastName: d.lastName, jobTitle: "Owner", passwordHash: await hashPassword(d.password), emailVerifiedAt: new Date(), roles: { create: { roleId: role.id } } } });
    await audit(tx, { userId: u.id, name: `${d.firstName} ${d.lastName}`, role: role.name, ip: m.ip, userAgent: m.userAgent, type: "STAFF" }, { action: "staff.create", module: "staff", recordType: "User", recordId: u.id, newValues: { email: d.email, roles: [role.name], source: "initial setup" } });
    return u;
  });
  await createSession(req, res, user.id, "STAFF");
  return "Owner account created.";
}));
