import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/db";
import { audit } from "../../lib/audit";
import { AppError } from "../../lib/errors";
import { fmtDateTime } from "../../lib/dates";
import { toCsv } from "../../lib/csv";
import { NOTIFICATION_CATEGORIES } from "../../lib/notify";
import { PERMISSIONS } from "../../lib/permissions";
import { DEFAULT_SETTINGS, getSettings, type HotelSettings } from "../../lib/settings";
import { zBool, zDate, zEmail, zInt, zOpt, zOptDate, zReq } from "../../lib/validation";
import { staff } from "../../core/auth";
import { body, files, form, found, h, page, q } from "../../core/http";
import { addSeasonalRate, adminResetPassword, createStaff, saveRole, setStaffActive, toggleSeasonalRate, updateSettingsSection, updateStaff, upsertDiscountCode } from "../../services/admin";
import { auditWhere } from "../../services/audit-query";
import { saveUpload } from "../../services/files";
import { deliveryConfig } from "../../services/delivery";
import { cardGatewayConfigured } from "../../services/billing";

export const admin = Router();

// ───────── Staff ─────────
admin.get("/staff", h(async (req) => {
  await staff(req, "staff.view");
  return { users: await prisma.user.findMany({ where: { type: "STAFF" }, select: { id: true, firstName: true, lastName: true, email: true, jobTitle: true, isActive: true, mustChangePassword: true, roles: { include: { role: true } }, sessions: { orderBy: { lastSeenAt: "desc" }, take: 1, select: { lastSeenAt: true } } }, orderBy: [{ isActive: "desc" }, { firstName: "asc" }] }) };
}));

admin.get("/staff/:id", h(async (req) => {
  const me = await staff(req, "staff.view");
  const u = found(await prisma.user.findFirst({ where: { id: String(req.params.id), type: "STAFF" }, select: { id: true, firstName: true, lastName: true, email: true, phone: true, jobTitle: true, isActive: true, mustChangePassword: true, createdAt: true, roles: { include: { role: true } } } }), "Staff member");
  const [roles, logins, activity] = await Promise.all([
    prisma.role.findMany({ orderBy: { name: "asc" } }),
    prisma.loginAttempt.findMany({ where: { OR: [{ userId: u.id }, { identifier: u.email }], portal: "STAFF" }, orderBy: { createdAt: "desc" }, take: 25 }),
    me.can("audit.view") ? prisma.auditLog.findMany({ where: { userId: u.id }, orderBy: { createdAt: "desc" }, take: 30 }) : [],
  ]);
  return { user: u, roles, logins, activity, self: me.user.id === u.id };
}));

admin.post("/staff", form, h(async (req) => {
  const s = await staff(req, "staff.manage");
  const d = z.object({ firstName: zReq("First name", 60), lastName: zReq("Last name", 60), email: zEmail, phone: zOpt(30), jobTitle: zOpt(80), roleIds: z.array(z.string()).min(1, "Assign at least one role"), tempPassword: z.string().min(1, "Set a temporary password") }).parse(body(req, ["roleIds"]));
  const u = await createStaff(s.actor, s.permissions, d);
  return { ok: true, message: "Staff account created. They must change the temporary password at first sign-in.", data: { id: u.id, redirect: `/manage/staff/${u.id}` } };
}));

admin.post("/staff/:id", form, h(async (req) => {
  const s = await staff(req, "staff.manage");
  const d = z.object({ firstName: zReq("First name", 60), lastName: zReq("Last name", 60), phone: zOpt(30), jobTitle: zOpt(80), roleIds: z.array(z.string()) }).parse(body(req, ["roleIds"]));
  await updateStaff(s.actor, s.permissions, String(req.params.id), d);
  return "Staff account updated.";
}));

admin.post("/staff/:id/active", form, h(async (req) => {
  const s = await staff(req, "staff.manage");
  const d = z.object({ active: zBool, reason: zReq("Reason", 500) }).parse(body(req));
  await setStaffActive(s.actor, String(req.params.id), d.active, d.reason);
  return d.active ? "Account reactivated." : "Account deactivated and signed out.";
}));

admin.post("/staff/:id/reset-password", form, h(async (req) => {
  const s = await staff(req, "staff.manage");
  const d = z.object({ tempPassword: z.string().min(1), reason: zReq("Reason", 500) }).parse(body(req));
  await adminResetPassword(s.actor, String(req.params.id), d.tempPassword, d.reason);
  return "Password reset. Share the temporary password securely; they must change it at next sign-in.";
}));

// ───────── Roles ─────────
admin.get("/roles", h(async (req) => {
  await staff(req, "roles.manage", "staff.view");
  const roles = await prisma.role.findMany({ include: { permissions: { include: { permission: true } }, _count: { select: { users: true } } }, orderBy: { name: "asc" } });
  return { roles: roles.map((r) => ({ ...r, permissions: r.permissions.map((p) => p.permission.key) })), catalog: Object.entries(PERMISSIONS).map(([key, [module, description]]) => ({ key, module, description })) };
}));

admin.post("/roles", form, h(async (req) => {
  const s = await staff(req, "roles.manage");
  const d = z.object({ id: zOpt(50), name: zReq("Role name", 80), description: zOpt(300), permissions: z.array(z.string()) }).parse(body(req, ["permissions"]));
  await saveRole(s.actor, s.permissions, { ...d, id: d.id ?? undefined, description: d.description ?? undefined });
  return "Role saved. Affected staff get the new permissions on their next request.";
}));

// ───────── Audit ─────────
admin.get("/audit", h(async (req) => {
  await staff(req, "audit.view");
  const { take, skip, page: p } = page(req, 50);
  const sp = req.query as Record<string, string | undefined>;
  const where = auditWhere(sp);
  const [rows, total, users, modules] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, take, skip }),
    prisma.auditLog.count({ where }),
    prisma.user.findMany({ where: { type: "STAFF" }, select: { id: true, firstName: true, lastName: true }, orderBy: { firstName: "asc" } }),
    prisma.auditLog.findMany({ distinct: ["module"], select: { module: true }, orderBy: { module: "asc" } }),
  ]);
  return { rows, total, page: p, pages: Math.ceil(total / take), users, modules: modules.map((m) => m.module) };
}));

admin.get("/audit/export", h(async (req, res) => {
  const s = await staff(req, "audit.export");
  const sp = req.query as Record<string, string | undefined>;
  const rows = await prisma.auditLog.findMany({ where: auditWhere(sp), orderBy: { createdAt: "desc" }, take: 50_000 });
  await audit(prisma, s.actor, { action: "audit.export", module: "audit", newValues: { filters: sp, rows: rows.length } });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="asher-audit-log.csv"`);
  res.send(toCsv(["Audit ID", "Time (Lagos)", "User ID", "User", "Role", "Action", "Module", "Record type", "Record ID", "Old values", "New values", "Reason", "Outcome", "IP", "Device"],
    rows.map((a) => [a.id, fmtDateTime(a.createdAt), a.userId, a.actorName, a.actorRole, a.action, a.module, a.recordType, a.recordId, a.oldValues ? JSON.stringify(a.oldValues) : "", a.newValues ? JSON.stringify(a.newValues) : "", a.reason, a.outcome, a.ipAddress, a.userAgent])));
}));

// ───────── Settings ─────────
admin.get("/settings", h(async (req) => {
  await staff(req, "settings.view", "settings.manage", "rooms.rates");
  const [settings, seasons, codes, types] = await Promise.all([
    getSettings(), prisma.seasonalRate.findMany({ include: { roomType: true }, orderBy: { startDate: "desc" } }),
    prisma.discountCode.findMany({ orderBy: { createdAt: "desc" } }), prisma.roomType.findMany({ orderBy: { name: "asc" } }),
  ]);
  const env = deliveryConfig();
  return {
    settings, seasons, codes, types,
    integrations: [
      { name: "Card payments (Paystack)", ok: cardGatewayConfigured(), env: "PAYSTACK_SECRET_KEY, API_URL; webhook: /api/payments/paystack/webhook" },
      { name: "Email (SMTP)", ok: env.email, env: "SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM" },
      { name: "SMS (Termii)", ok: env.sms, env: "TERMII_API_KEY, TERMII_SENDER_ID" },
      { name: "Background jobs", ok: !!process.env.CRON_SECRET, env: "CRON_SECRET; POST /api/cron every minute with 'Authorization: Bearer <CRON_SECRET>'" },
      { name: "Data encryption", ok: !!process.env.DATA_ENCRYPTION_KEY, env: "DATA_ENCRYPTION_KEY (32 bytes, base64)" },
    ],
  };
}));

admin.post("/settings/:section", form, h(async (req) => {
  const s = await staff(req, "settings.manage");
  const o = body(req, ["facilities", "acceptedMethods", "tierHours", "tierPrice", "tierEveningPrice", "tierLabel"]);
  const section = String(req.params.section) as keyof HotelSettings;
  if (!(section in DEFAULT_SETTINGS)) throw new AppError("Unknown settings section.");
  const cur = await getSettings();
  const pct = z.string().trim().regex(/^\d{1,3}(\.\d{1,2})?$/, "Enter a percentage").refine((v) => Number(v) <= 100, "Must be 100% or less");
  const time = z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM");
  const money = z.string().trim().transform((v) => v.replace(/[₦,\s]/g, "")).refine((v) => /^\d+(\.\d{1,2})?$/.test(v), "Enter a valid amount");
  let value: unknown;
  switch (section) {
    case "hotel": {
      const v = z.object({ name: zReq("Hotel name", 120), tagline: z.string().max(200), address: z.string().max(300), city: z.string().max(80), state: z.string().max(80), country: z.string().max(80), phone: z.string().max(40), email: z.string().max(120), website: z.string().max(200) }).parse(o);
      const logo = await saveUpload(files(req).logo?.[0], "branding");
      value = { ...cur.hotel, ...v, logoPath: logo ?? cur.hotel.logoPath };
      break;
    }
    case "policies":
      value = z.object({ checkInTime: time, checkOutTime: time, houseRules: z.string().max(5000), cancellationPolicy: z.string().max(3000), childPolicy: z.string().max(2000), freeCancellationHours: zInt(0, 720, "Free cancellation hours"), cancellationFeeNights: zInt(0, 30, "Cancellation fee nights"), noShowFeeNights: zInt(0, 30, "No-show fee nights"), guestModificationHours: zInt(0, 720, "Modification hours") }).parse(o);
      break;
    case "finance":
      value = { ...z.object({ taxLabel: zReq("Tax label", 30), taxRate: pct, serviceChargeRate: pct, depositPercent: pct, taxInclusive: zBool, paymentInstructions: z.string().max(2000), bankName: z.string().max(100), accountName: z.string().max(120), accountNumber: z.string().max(20) }).parse(o), currency: "NGN", acceptedMethods: (o.acceptedMethods as string[]).filter((m) => ["CASH", "BANK_TRANSFER", "POS", "CARD_ONLINE"].includes(m)) };
      break;
    case "shortStay": {
      const base = z.object({ enabled: zBool, onlineBooking: zBool, eveningFrom: time, graceMinutes: zInt(0, 120, "Grace minutes") }).parse(o);
      const hours = o.tierHours as string[], prices = o.tierPrice as string[], eve = o.tierEveningPrice as string[], labels = o.tierLabel as string[];
      const tiers = hours.map((hh, i) => ({ hours: Number(hh), price: prices[i], eveningPrice: eve[i], label: labels[i] }))
        .filter((t) => t.hours && t.price)
        .map((t) => ({ hours: zInt(1, 23, "Package hours").parse(t.hours), price: Number(money.parse(t.price)).toFixed(2), eveningPrice: t.eveningPrice?.trim() ? Number(money.parse(t.eveningPrice)).toFixed(2) : null, label: t.label?.trim() || `${t.hours} hours` }))
        .sort((a, b) => a.hours - b.hours);
      if (new Set(tiers.map((t) => t.hours)).size !== tiers.length) throw new AppError("Each package must have a different number of hours.");
      if (base.enabled && !tiers.length) throw new AppError("Add at least one short-stay package.");
      value = { ...base, tiers };
      break;
    }
    case "reservations":
      value = z.object({ holdHours: zInt(1, 168, "Hold hours"), maxAdvanceDays: zInt(1, 1000, "Advance days"), maxNights: zInt(1, 365, "Max nights"), bookingRefPrefix: z.string().regex(/^[A-Z]{2,5}$/, "2–5 capital letters"), invoicePrefix: z.string().regex(/^[A-Z]{2,5}$/, "2–5 capital letters"), receiptPrefix: z.string().regex(/^[A-Z]{2,5}$/, "2–5 capital letters"), requireInspectionBeforeCheckIn: zBool, housekeepingOverdueHours: zInt(1, 48, "Overdue hours"), allowPayAtHotel: zBool, requireDepositForOnline: zBool }).parse(o);
      break;
    case "notifications":
      value = z.object({ emailEnabled: zBool, smsEnabled: zBool, arrivalReminderHours: zInt(1, 168, "Reminder hours"), departureReminderHours: zInt(1, 48, "Reminder hours") }).parse(o);
      break;
    case "security":
      value = z.object({ staffSessionHours: zInt(1, 24, "Staff session hours"), guestSessionHours: zInt(1, 720, "Guest session hours"), maxFailedLogins: zInt(3, 20, "Max failed logins"), lockoutMinutes: zInt(1, 1440, "Lockout minutes"), passwordMinLength: zInt(8, 64, "Password length") }).parse(o);
      break;
    case "facilities":
      value = (o.facilities as string[]).map((f) => f.trim()).filter(Boolean).slice(0, 30);
      break;
    default:
      throw new AppError("Unknown settings section.");
  }
  await updateSettingsSection(s.actor, section, value as never);
  return "Settings saved.";
}));

admin.post("/pricing/seasonal", form, h(async (req) => {
  const s = await staff(req, "rooms.rates");
  const o = body(req);
  if (o.toggleId) { await toggleSeasonalRate(s.actor, String(o.toggleId)); return "Updated."; }
  const d = z.object({ name: zReq("Name", 80), roomTypeId: zOpt(50), startDate: zDate, endDate: zDate, adjustmentPercent: z.string().regex(/^-?\d+(\.\d{1,2})?$/, "Enter a percentage") }).parse(o);
  await addSeasonalRate(s.actor, d);
  return "Seasonal rate added.";
}));

admin.post("/pricing/discount-codes", form, h(async (req) => {
  const s = await staff(req, "rooms.rates");
  const d = z.object({ code: zReq("Code", 20), description: z.string().optional(), percent: z.string().regex(/^\d+(\.\d{1,2})?$/, "Enter a percentage"), validFrom: zOptDate, validTo: zOptDate, isActive: zBool }).parse(body(req));
  await upsertDiscountCode(s.actor, d);
  return "Discount code saved.";
}));

// ───────── Notifications & profile ─────────
admin.get("/notifications", h(async (req) => {
  const s = await staff(req);
  const { take, skip, page: p } = page(req, 50);
  const where = { userId: s.user.id, ...(q(req, "category") ? { category: q(req, "category") } : {}), ...(q(req, "unread") ? { readAt: null } : {}), ...(q(req, "priority") ? { priority: q(req, "priority") as never } : {}) };
  const [items, total, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, take, skip }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId: s.user.id, readAt: null } }),
  ]);
  return { items, total, unread, page: p, pages: Math.ceil(total / take), categories: NOTIFICATION_CATEGORIES };
}));

admin.post("/notifications/read", form, h(async (req) => {
  const s = await staff(req);
  const id = body(req).id;
  await prisma.notification.updateMany({ where: { userId: s.user.id, readAt: null, ...(id ? { id: String(id) } : {}) }, data: { readAt: new Date() } });
  return { ok: true };
}));

admin.get("/me/profile", h(async (req) => {
  const s = await staff(req);
  const [u, logins] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: s.user.id }, select: { email: true, jobTitle: true, createdAt: true, notificationPrefs: true, mustChangePassword: true } }),
    prisma.loginAttempt.findMany({ where: { userId: s.user.id }, orderBy: { createdAt: "desc" }, take: 10 }),
  ]);
  return { user: u, roles: s.roleNames, permissionCount: s.permissions.size, logins, categories: NOTIFICATION_CATEGORIES };
}));

admin.post("/me/notification-prefs", form, h(async (req) => {
  const s = await staff(req);
  const muted = body(req, ["muted"]).muted as string[];
  const u = await prisma.user.findUniqueOrThrow({ where: { id: s.user.id } });
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: u.id }, data: { notificationPrefs: { ...(u.notificationPrefs as object), muted } } });
    await audit(tx, s.actor, { action: "user.notification_prefs", module: "staff", recordType: "User", recordId: u.id, newValues: { muted } });
  });
  return "Preferences saved. Urgent alerts are always delivered.";
}));

/** Sidebar badge counts. */
admin.get("/me/badges", h(async (req) => {
  const s = await staff(req);
  const [unread, messages, payments, requests, housekeeping, bookingForms] = await Promise.all([
    prisma.notification.count({ where: { userId: s.user.id, readAt: null } }),
    s.can("messages.view") ? prisma.message.count({ where: { fromGuest: true, readAt: null } }) : 0,
    s.can("payments.verify") ? prisma.payment.count({ where: { status: "PENDING" } }) : 0,
    s.can("services.view") ? prisma.serviceRequest.count({ where: { status: "OPEN" } }) : 0,
    s.can("housekeeping.manage") ? prisma.housekeepingTask.count({ where: { status: { in: ["PENDING", "FAILED_INSPECTION"] } } }) : s.can("housekeeping.work") ? prisma.housekeepingTask.count({ where: { assignedToId: s.user.id, status: { in: ["PENDING", "IN_PROGRESS"] } } }) : 0,
    s.can("requests.allocate") ? prisma.bookingRequest.count({ where: { status: "NEW" } }) : 0,
  ]);
  const settings = await getSettings();
  return { unread, messages, payments, requests, housekeeping, bookingForms, hotelName: settings.hotel.name };
}));
