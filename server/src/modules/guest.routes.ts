import { Router } from "express";
import { decrypt } from "../lib/crypto";
import { statusLink } from "../services/requests";
import { z } from "zod";
import { prisma } from "../lib/db";
import { audit } from "../lib/audit";
import { AppError } from "../lib/errors";
import { toDbDate, todayLagos } from "../lib/dates";
import { zBool, zDate, zInt, zMoney, zOpt, zPhone, zReq } from "../lib/validation";
import { guest } from "../core/auth";
import { NotFound, body, files, form, h } from "../core/http";
import { cancelReservation, createReservation, modifyReservation, requestExpressCheckout, submitPreCheckIn } from "../services/reservations";
import { startCardPayment, submitGuestTransfer } from "../services/billing";
import { cancelServiceRequestByGuest, createServiceRequest, SERVICE_CATEGORIES } from "../services/operations";
import { markConversationRead, removeGuestPreference, sendMessage, startConversation, submitFeedback } from "../services/crm";
import { balancesFor, folioSummary } from "../services/folio";
import { saveUpload } from "../services/files";
import { getSettings } from "../lib/settings";
import { D, round2 } from "../lib/money";

/** Guest portal API. Every query is scoped to the signed-in guest; other guests' records are never reachable. */
export const guestRoutes = Router();

function mapBalances(m: Map<string, { total: unknown; paid: unknown; balance: unknown }>) {
  return Object.fromEntries([...m.entries()]);
}

async function own(req: Parameters<typeof guest>[0], reference: string) {
  const g = await guest(req);
  const r = await prisma.reservation.findUnique({ where: { reference } });
  if (!r || r.guestId !== g.guestId) throw new NotFound("Reservation");
  return { g, r };
}

guestRoutes.get("/overview", h(async (req) => {
  const g = await guest(req);
  const [current, upcoming, openRequests, unreadMsgs] = await Promise.all([
    prisma.reservation.findFirst({ where: { guestId: g.guestId, status: "CHECKED_IN" }, include: { room: { include: { roomType: true, images: { orderBy: { sortOrder: "asc" } } } } } }),
    prisma.reservation.findMany({ where: { guestId: g.guestId, status: { in: ["PENDING", "CONFIRMED"] }, departureDate: { gte: toDbDate(todayLagos()) } }, include: { room: { include: { roomType: true, images: { orderBy: { sortOrder: "asc" } } } } }, orderBy: { startAt: "asc" } }),
    prisma.serviceRequest.count({ where: { guestId: g.guestId, status: { in: ["OPEN", "ASSIGNED", "IN_PROGRESS"] } } }),
    prisma.message.count({ where: { conversation: { guestId: g.guestId }, fromGuest: false, readAt: null } }),
  ]);
  const bal = await balancesFor([...upcoming.map((u) => u.id), ...(current ? [current.id] : [])]);
  return { current, upcoming, openRequests, unreadMsgs, balances: mapBalances(bal), emailVerified: !!g.user.emailVerifiedAt };
}));

guestRoutes.get("/reservations", h(async (req) => {
  const g = await guest(req);
  const all = await prisma.reservation.findMany({ where: { guestId: g.guestId }, include: { room: { include: { roomType: true } } }, orderBy: { startAt: "desc" } });
  return { reservations: all, balances: mapBalances(await balancesFor(all.map((r) => r.id))), today: todayLagos() };
}));

guestRoutes.get("/reservations/:ref", h(async (req) => {
  const g = await guest(req);
  const r = await prisma.reservation.findUnique({ where: { reference: String(req.params.ref) }, include: { room: { include: { roomType: true, images: { orderBy: { sortOrder: "asc" } } } }, invoices: { orderBy: { issuedAt: "desc" } }, review: true, extraGuests: true, guest: true } });
  if (!r || r.guestId !== g.guestId) throw new NotFound("Reservation");
  const [folio, s] = await Promise.all([folioSummary(r.id), getSettings()]);
  const depositDue = round2(folio.total.mul(D(s.finance.depositPercent)).div(100));
  const { idNumberEncrypted: _id, ...safeGuest } = r.guest;
  return { reservation: { ...r, guest: safeGuest }, folio, depositDue };
}));

/** Booking forms sent while signed in (rooms are allocated by the front desk). */
guestRoutes.get("/requests", h(async (req) => {
  const g = await guest(req);
  const rows = await prisma.bookingRequest.findMany({ where: { guestId: g.guestId }, include: { roomType: true, reservation: { include: { room: { include: { images: { orderBy: { sortOrder: "asc" }, take: 1 } } } } } }, orderBy: { createdAt: "desc" }, take: 20 });
  return { requests: rows.map(({ accessTokenHash: _h, accessTokenEnc, ...r }) => ({ ...r, link: statusLink(r.reference, decrypt(accessTokenEnc)!) })) };
}));

guestRoutes.post("/reservations/:ref/cancel", form, h(async (req) => {
  const { g, r } = await own(req, String(req.params.ref));
  const d = z.object({ reason: zReq("Reason", 500) }).parse(body(req));
  const { fee } = await cancelReservation(g.actor, r.id, d.reason);
  return fee.gt(0) ? "Booking cancelled. A late cancellation fee applies per the hotel policy." : "Booking cancelled.";
}));

guestRoutes.post("/reservations/:ref/pre-checkin", form, h(async (req) => {
  const { g, r } = await own(req, String(req.params.ref));
  const d = z.object({
    phone: zPhone, address: zReq("Address", 300), nationality: zReq("Nationality", 60), idType: zReq("ID type", 40), idNumber: zReq("ID number", 40),
    expectedArrival: zReq("Arrival time", 20), specialRequests: zOpt(1000), acceptPolicies: zBool,
  }).parse(body(req));
  const idDocumentPath = await saveUpload(files(req).idDocument?.[0], "ids", { allowPdf: true });
  await submitPreCheckIn(g.actor, r.id, { ...d, specialRequests: d.specialRequests ?? undefined, idDocumentPath });
  return "Pre-arrival check-in complete. See you soon!";
}));

guestRoutes.post("/reservations/:ref/express-checkout", form, h(async (req) => {
  const { g, r } = await own(req, String(req.params.ref));
  await requestExpressCheckout(g.actor, r.id);
  return "Express checkout requested. The front desk will finalise your bill and email your receipt.";
}));

guestRoutes.post("/reservations/:ref/transfer", form, h(async (req) => {
  const { g, r } = await own(req, String(req.params.ref));
  const d = z.object({ amount: zMoney, externalRef: zReq("Transfer reference", 60), payerName: zReq("Payer name", 100) }).parse(body(req));
  const proofPath = await saveUpload(files(req).proof?.[0], "proofs", { allowPdf: true });
  await submitGuestTransfer(g.actor, { reservationId: r.id, ...d, proofPath });
  return "Transfer submitted. We'll notify you once it is verified.";
}));

guestRoutes.post("/reservations/:ref/card", form, h(async (req) => {
  const { g, r } = await own(req, String(req.params.ref));
  const d = z.object({ amount: zMoney }).parse(body(req));
  const url = await startCardPayment(g.actor, r.id, d.amount);
  return { ok: true, data: { redirect: url } };
}));

guestRoutes.get("/billing{/:ref}", h(async (req) => {
  const g = await guest(req);
  const stays = await prisma.reservation.findMany({ where: { guestId: g.guestId }, include: { room: true, invoices: { orderBy: { issuedAt: "desc" } } }, orderBy: { startAt: "desc" } });
  if (!stays.length) return { stays: [], current: null, folio: null };
  const current = stays.find((s) => s.reference === req.params.ref) ?? stays.find((s) => s.status === "CHECKED_IN") ?? stays[0];
  return { stays, current, folio: await folioSummary(current.id) };
}));

guestRoutes.get("/payments", h(async (req) => {
  const g = await guest(req);
  return { payments: await prisma.payment.findMany({ where: { guestId: g.guestId }, include: { reservation: true, receipt: true, refunds: true }, orderBy: { receivedAt: "desc" } }) };
}));

// ───────── Services ─────────
guestRoutes.get("/services", h(async (req) => {
  const g = await guest(req);
  const [stays, requests] = await Promise.all([
    prisma.reservation.findMany({ where: { guestId: g.guestId, status: { in: ["CHECKED_IN", "CONFIRMED", "PENDING"] } }, include: { room: true }, orderBy: { startAt: "asc" } }),
    prisma.serviceRequest.findMany({ where: { guestId: g.guestId }, include: { room: true }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  return { stays, requests, categories: SERVICE_CATEGORIES };
}));

guestRoutes.post("/services", form, h(async (req) => {
  const g = await guest(req);
  const d = z.object({ reservationId: zOpt(50), category: zReq("Category", 60), description: zReq("Description", 1000), priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL") }).parse(body(req));
  const r = await createServiceRequest(g.actor, { ...d, guestId: g.guestId });
  return `Request ${r.reference} sent.`;
}));

guestRoutes.post("/services/:id/cancel", form, h(async (req) => {
  const g = await guest(req);
  await cancelServiceRequestByGuest(g.actor, String(req.params.id));
  return "Request cancelled.";
}));

// ───────── Messages ─────────
guestRoutes.get("/conversations", h(async (req) => {
  const g = await guest(req);
  return { conversations: await prisma.conversation.findMany({ where: { guestId: g.guestId }, orderBy: { lastMessageAt: "desc" }, include: { messages: { orderBy: { createdAt: "desc" }, take: 1 }, _count: { select: { messages: { where: { fromGuest: false, readAt: null } } } } } }) };
}));

guestRoutes.post("/conversations", form, h(async (req) => {
  const g = await guest(req);
  const d = z.object({ channel: z.enum(["FRONT_DESK", "CONCIERGE"]), subject: zReq("Subject", 120), body: zReq("Message", 2000) }).parse(body(req));
  const attachmentPath = await saveUpload(files(req).attachment?.[0], "messages");
  const c = await startConversation(g.actor, g.guestId, { ...d, attachmentPath });
  return { ok: true, message: "Message sent.", data: { id: c.id } };
}));

guestRoutes.get("/conversations/:id", h(async (req) => {
  const g = await guest(req);
  const c = await prisma.conversation.findUnique({ where: { id: String(req.params.id) }, include: { messages: { orderBy: { createdAt: "asc" } } } });
  if (!c || c.guestId !== g.guestId) throw new NotFound("Conversation");
  await markConversationRead(c.id, true);
  return { conversation: c };
}));

guestRoutes.post("/conversations/:id/messages", form, h(async (req) => {
  const g = await guest(req);
  const d = z.object({ body: z.string().trim().max(2000).default("") }).parse(body(req));
  const attachmentPath = await saveUpload(files(req).attachment?.[0], "messages");
  await sendMessage(g.actor, String(req.params.id), d.body, attachmentPath);
  return { ok: true };
}));

// ───────── Feedback ─────────
guestRoutes.get("/reviews", h(async (req) => {
  const g = await guest(req);
  const [eligible, mine] = await Promise.all([
    prisma.reservation.findMany({ where: { guestId: g.guestId, status: "CHECKED_OUT", review: null }, include: { room: true }, orderBy: { departureDate: "desc" } }),
    prisma.review.findMany({ where: { guestId: g.guestId }, orderBy: { createdAt: "desc" }, include: { reservation: true } }),
  ]);
  return { eligible, mine };
}));

guestRoutes.post("/reviews", form, h(async (req) => {
  const g = await guest(req);
  const o = body(req);
  const d = z.object({ kind: z.enum(["REVIEW", "COMPLAINT", "SUGGESTION"]), reservationId: zOpt(50), rating: z.union([z.coerce.number().int().min(1).max(5), z.literal("").transform(() => undefined)]).optional(), title: zOpt(120), body: zReq("Comments", 3000) }).parse(o);
  const serviceRatings: Record<string, number> = {};
  for (const k of ["cleanliness", "staff", "comfort", "value", "food"]) { const v = Number(o[`svc_${k}`]); if (v >= 1 && v <= 5) serviceRatings[k] = v; }
  await submitFeedback(g.actor, { kind: d.kind, reservationId: d.reservationId, rating: d.rating ?? null, title: d.title ?? undefined, body: d.body, serviceRatings });
  return "Thank you for your feedback.";
}));

// ───────── Profile & notifications ─────────
guestRoutes.get("/profile", h(async (req) => {
  const g = await guest(req);
  const p = await prisma.guest.findUniqueOrThrow({ where: { id: g.guestId }, include: { preferences: true } });
  const { idNumberEncrypted: _id, ...safe } = p;
  return { guest: safe, email: g.user.email, prefs: g.user.notificationPrefs ?? {} };
}));

guestRoutes.post("/profile", form, h(async (req) => {
  const g = await guest(req);
  const d = z.object({ firstName: zReq("First name", 60), lastName: zReq("Last name", 60), phone: zPhone, address: zOpt(300), city: zOpt(80), country: zOpt(80), nationality: zOpt(60), emailPrefs: zBool, smsPrefs: zBool, marketingOptIn: zBool }).parse(body(req));
  await prisma.$transaction(async (tx) => {
    const before = await tx.guest.findUniqueOrThrow({ where: { id: g.guestId } });
    await tx.user.update({ where: { id: g.user.id }, data: { firstName: d.firstName, lastName: d.lastName, phone: d.phone, notificationPrefs: { ...(g.user.notificationPrefs as object), email: d.emailPrefs, sms: d.smsPrefs } } });
    await tx.guest.update({ where: { id: g.guestId }, data: { firstName: d.firstName, lastName: d.lastName, phone: d.phone, address: d.address, city: d.city, country: d.country, nationality: d.nationality, marketingOptIn: d.marketingOptIn } });
    await audit(tx, g.actor, { action: "guest.update", module: "guests", recordType: "Guest", recordId: g.guestId, oldValues: { firstName: before.firstName, lastName: before.lastName, phone: before.phone, address: before.address }, newValues: { firstName: d.firstName, lastName: d.lastName, phone: d.phone, address: d.address, emailNotifications: d.emailPrefs, smsNotifications: d.smsPrefs } });
  });
  return "Profile updated.";
}));

guestRoutes.post("/preferences", form, h(async (req) => {
  const g = await guest(req);
  const o = body(req);
  if (o.removeId) { await removeGuestPreference(g.actor, String(o.removeId)); return "Removed."; }
  const d = z.object({ category: zReq("Category", 40), value: zReq("Preference", 200) }).parse(o);
  await prisma.$transaction(async (tx) => {
    await tx.guestPreference.create({ data: { guestId: g.guestId, category: d.category, value: d.value } });
    await audit(tx, g.actor, { action: "guest.preference_add", module: "guests", recordType: "Guest", recordId: g.guestId, newValues: d });
  });
  return "Preference saved.";
}));

guestRoutes.get("/notifications", h(async (req) => {
  const g = await guest(req);
  return { notifications: await prisma.notification.findMany({ where: { userId: g.user.id }, orderBy: { createdAt: "desc" }, take: 100 }) };
}));

guestRoutes.post("/notifications/read", form, h(async (req) => {
  const g = await guest(req);
  const id = body(req).id;
  await prisma.notification.updateMany({ where: { userId: g.user.id, readAt: null, ...(id ? { id: String(id) } : {}) }, data: { readAt: new Date() } });
  return { ok: true };
}));

