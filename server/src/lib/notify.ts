import { prisma, type Tx } from "./db";
import type { PermissionKey } from "./permissions";
import { getSettings } from "./settings";

export type Priority = "LOW" | "NORMAL" | "HIGH" | "URGENT";

export type NotificationInput = {
  category: string;
  title: string;
  body: string;
  link?: string;
  priority?: Priority;
  /** Same dedupeKey for the same recipient is only delivered once. */
  dedupeKey?: string;
};

type Prefs = { email?: boolean; sms?: boolean; muted?: string[] };

export const NOTIFICATION_CATEGORIES = [
  "reservation", "payment", "checkin", "checkout", "message", "service", "housekeeping", "maintenance", "room", "refund", "staff", "settings", "security", "billing", "reminder",
] as const;

/** In-app notification to specific users. Muted categories are skipped unless URGENT. */
export async function notifyUsers(db: Tx, userIds: string[], n: NotificationInput) {
  const unique = [...new Set(userIds)];
  if (!unique.length) return;
  const users = await db.user.findMany({ where: { id: { in: unique }, isActive: true }, select: { id: true, notificationPrefs: true } });
  const data = users
    .filter((u) => n.priority === "URGENT" || !((u.notificationPrefs as Prefs)?.muted ?? []).includes(n.category))
    .map((u) => ({
      userId: u.id, category: n.category, priority: n.priority ?? "NORMAL", title: n.title, body: n.body, link: n.link ?? null,
      dedupeKey: n.dedupeKey ?? null,
    }));
  if (data.length) await db.notification.createMany({ data, skipDuplicates: true });
}

/** Role-based delivery: every active staff member holding any of the given permissions. */
export async function notifyStaff(db: Tx, permissions: PermissionKey[], n: NotificationInput, opts: { exclude?: string | null; alsoUserIds?: (string | null | undefined)[] } = {}) {
  const users = await db.user.findMany({
    where: {
      type: "STAFF", isActive: true,
      roles: { some: { role: { permissions: { some: { permission: { key: { in: permissions } } } } } } },
    },
    select: { id: true },
  });
  const ids = users.map((u) => u.id).concat((opts.alsoUserIds ?? []).filter((x): x is string => !!x));
  await notifyUsers(db, ids.filter((id) => id !== opts.exclude), n);
}

/**
 * Notify a guest in-app (if they have an account) and queue email / SMS per hotel settings and
 * the guest's own preferences. External delivery happens in the background outbox processor.
 */
export async function notifyGuest(db: Tx, guestId: string, n: NotificationInput & { email?: boolean; sms?: boolean }) {
  const guest = await db.guest.findUnique({ where: { id: guestId }, include: { user: true } });
  if (!guest) return;
  if (guest.user && guest.user.isActive) await notifyUsers(db, [guest.user.id], n);
  const settings = await getSettings(db);
  const prefs = (guest.user?.notificationPrefs ?? {}) as Prefs;
  const email = guest.email ?? guest.user?.email;
  if (n.email !== false && settings.notifications.emailEnabled && email && prefs.email !== false) {
    await queueDelivery(db, {
      channel: "EMAIL", recipient: email, subject: `${n.title} — ${settings.hotel.name}`,
      body: `Dear ${guest.firstName},\n\n${n.body}\n\n${n.link ? `View details: ${(process.env.APP_URL ?? "") + n.link}\n\n` : ""}${settings.hotel.name}${settings.hotel.phone ? "\n" + settings.hotel.phone : ""}`,
      dedupeKey: n.dedupeKey ? `email:${guestId}:${n.dedupeKey}` : undefined,
    });
  }
  const phone = guest.phone ?? guest.user?.phone;
  if (n.sms && settings.notifications.smsEnabled && phone && prefs.sms !== false) {
    await queueDelivery(db, {
      channel: "SMS", recipient: phone, body: `${settings.hotel.name}: ${n.title}. ${n.body}`.slice(0, 300),
      dedupeKey: n.dedupeKey ? `sms:${guestId}:${n.dedupeKey}` : undefined,
    });
  }
}

export async function queueDelivery(db: Tx, d: { channel: "EMAIL" | "SMS"; recipient: string; subject?: string; body: string; dedupeKey?: string }) {
  if (d.dedupeKey) {
    const exists = await db.notificationDelivery.findUnique({ where: { dedupeKey: d.dedupeKey } });
    if (exists) return;
  }
  await db.notificationDelivery.create({ data: { channel: d.channel, recipient: d.recipient, subject: d.subject, body: d.body, dedupeKey: d.dedupeKey } });
}

export async function unreadCount(userId: string) {
  return prisma.notification.count({ where: { userId, readAt: null } });
}
