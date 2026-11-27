import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/db";
import { addDays, fromDbDate, isDateStr, nightsBetween, toDbDate, todayLagos } from "../../lib/dates";
import { D, round2 } from "../../lib/money";
import { decrypt, maskId } from "../../lib/crypto";
import { audit } from "../../lib/audit";
import { getSettings } from "../../lib/settings";
import { AppError } from "../../lib/errors";
import { zBool, zDate, zEmail, zInt, zOpt, zOptDate, zReq } from "../../lib/validation";
import { staff } from "../../core/auth";
import { body, form, found, h, page, q } from "../../core/http";
import { applyShortStayOvertime, cancelReservation, checkIn, checkOut, confirmReservation, createReservation, markNoShow, modifyReservation, shortStayOvertime } from "../../services/reservations";
import { findAvailableRooms, nightSpan, shortSpan } from "../../services/availability";
import { quoteForRoom, quoteShortStay } from "../../services/pricing";
import { balancesFor, folioSummary, POSTABLE_CATEGORIES } from "../../services/folio";
import { issueInvoice } from "../../services/billing";
import { addGuestNote, addGuestPreference, createGuest, removeGuestPreference, setGuestFlags, updateGuest } from "../../services/crm";
import { dashboardStats } from "../../services/reports";
import { allocateRequest, declineRequest, describe as describeRequest } from "../../services/requests";
import { sum } from "../../lib/money";
import type { Prisma } from "@/generated/prisma/client";

export const frontOffice = Router();
const asObj = (m: Map<string, unknown>) => Object.fromEntries(m.entries());

frontOffice.get("/dashboard", h(async (req) => {
  await staff(req, "dashboard.view");
  return dashboardStats();
}));

// ───────── Reservations ─────────
frontOffice.get("/reservations", h(async (req) => {
  await staff(req, "reservations.view");
  const { take, skip, page: p } = page(req);
  const s = q(req, "q");
  const where: Prisma.ReservationWhereInput = {
    ...(q(req, "status") ? { status: q(req, "status") as never } : {}),
    ...(q(req, "source") ? { source: q(req, "source") as never } : {}),
    ...(q(req, "stayType") ? { stayType: q(req, "stayType") as never } : {}),
    ...(isDateStr(q(req, "from")) ? { departureDate: { gte: toDbDate(q(req, "from")!) } } : {}),
    ...(isDateStr(q(req, "to")) ? { arrivalDate: { lte: toDbDate(q(req, "to")!) } } : {}),
    ...(s ? { OR: [{ reference: { contains: s, mode: "insensitive" } }, { guest: { OR: [{ firstName: { contains: s, mode: "insensitive" } }, { lastName: { contains: s, mode: "insensitive" } }, { phone: { contains: s } }, { email: { contains: s, mode: "insensitive" } }] } }, { room: { number: s } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.reservation.findMany({ where, include: { guest: true, room: true }, orderBy: [{ startAt: q(req, "sort") === "asc" ? "asc" : "desc" }], take, skip }),
    prisma.reservation.count({ where }),
  ]);
  return { rows, total, page: p, pages: Math.ceil(total / take), balances: asObj(await balancesFor(rows.map((r) => r.id))) };
}));

frontOffice.get("/reservations/:id", h(async (req) => {
  const s = await staff(req, "reservations.view");
  const r = found(await prisma.reservation.findUnique({
    where: { id: String(req.params.id) },
    include: { guest: true, room: { include: { roomType: true } }, history: { orderBy: { createdAt: "desc" } }, invoices: { orderBy: { issuedAt: "desc" } }, extraGuests: true, serviceRequests: { orderBy: { createdAt: "desc" }, take: 5 } },
  }), "Reservation");
  const canMoney = s.can("payments.view") || s.can("payments.record") || s.can("frontdesk.checkout");
  const [folio, rooms, creator, overtime] = await Promise.all([
    canMoney ? folioSummary(r.id) : null,
    s.can("reservations.edit") ? prisma.room.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { number: "asc" }] }) : [],
    r.createdById ? prisma.user.findUnique({ where: { id: r.createdById }, select: { firstName: true, lastName: true } }) : null,
    shortStayOvertime(r.id),
  ]);
  const { idNumberEncrypted, ...guest } = r.guest;
  return { reservation: { ...r, guest: { ...guest, hasId: !!idNumberEncrypted } }, folio, rooms, creator, overtime, categories: POSTABLE_CATEGORIES };
}));

const createSchema = z.object({
  guestMode: z.enum(["existing", "new"]), guestId: zOpt(50), firstName: zOpt(60), lastName: zOpt(60), email: z.string().trim().optional(), phone: zOpt(30),
  stayType: z.enum(["NIGHT", "SHORT"]).default("NIGHT"), roomId: zReq("Room"), arrival: zDate, departure: z.string().optional(), startTime: z.string().optional(), hours: z.coerce.number().int().optional(),
  adults: zInt(1, 10, "Adults"), children: zInt(0, 10, "Children"),
  source: z.enum(["WALK_IN", "TELEPHONE", "EMAIL", "AGENT", "ONLINE", "OTHER"]), paymentPlan: z.enum(["PAY_NOW", "DEPOSIT", "PAY_AT_HOTEL"]),
  status: z.enum(["PENDING", "CONFIRMED"]), specialRequests: zOpt(1000), discountCode: zOpt(30), rateOverride: zOpt(20), negotiationReason: zOpt(500), expectedArrival: zOpt(20),
  extraGuests: z.array(z.string().trim().max(100)).optional(), checkInNow: zBool,
});

frontOffice.post("/reservations", form, h(async (req) => {
  const s = await staff(req, "reservations.create");
  const d = createSchema.parse(body(req, ["extraGuests"]));
  let guestId = d.guestId;
  if (d.guestMode === "new") {
    if (!s.can("guests.manage")) throw new AppError("You are not permitted to register guests.");
    if (!d.firstName || !d.lastName || !d.phone) throw new AppError("New guests need a first name, last name and phone number.");
    guestId = (await createGuest(s.actor, { firstName: d.firstName, lastName: d.lastName, email: d.email ? zEmail.parse(d.email) : null, phone: d.phone })).id;
  }
  if (!guestId) throw new AppError("Select a guest.");
  const rateOverride = d.rateOverride?.replace(/[₦,\s]/g, "") || null;
  if (rateOverride && !/^\d+(\.\d{1,2})?$/.test(rateOverride)) throw new AppError("Enter a valid negotiated price.");
  const r = await createReservation(s.actor, {
    guestId, roomId: d.roomId, stayType: d.stayType, arrival: d.arrival, departure: d.departure || undefined, startTime: d.startTime, hours: d.hours,
    adults: d.adults, children: d.children, source: d.source, paymentPlan: d.paymentPlan, specialRequests: d.specialRequests, discountCode: d.discountCode,
    rateOverride, negotiationReason: d.negotiationReason, canNegotiate: s.can("pricing.negotiate"), confirmImmediately: d.status === "CONFIRMED",
    expectedArrival: d.expectedArrival, extraGuests: d.extraGuests?.filter(Boolean),
  });
  const goCheckIn = d.checkInNow && d.arrival === todayLagos();
  return { ok: true, message: `Reservation ${r.reference} created.`, data: { id: r.id, redirect: goCheckIn ? `/manage/front-desk/check-in?id=${r.id}` : `/manage/reservations/${r.id}` } };
}));

frontOffice.post("/reservations/:id/modify", form, h(async (req) => {
  const s = await staff(req, "reservations.edit");
  const d = z.object({
    arrival: zDate, departure: z.string().optional(), roomId: zReq("Room"), adults: zInt(1, 10, "Adults"), children: zInt(0, 10, "Children"), specialRequests: zOpt(1000),
    rateOverride: zOpt(20), negotiationReason: zOpt(500), expectedArrival: zOpt(20), reason: zOpt(500), startTime: zOpt(5), hours: z.coerce.number().int().optional(), convertToNight: zBool,
  }).parse(body(req));
  await modifyReservation(s.actor, String(req.params.id), {
    arrival: d.arrival, departure: d.departure || undefined, roomId: d.roomId, adults: d.adults, children: d.children, specialRequests: d.specialRequests,
    rateOverride: d.rateOverride?.replace(/[₦,\s]/g, "") || null, negotiationReason: d.negotiationReason, canNegotiate: s.can("pricing.negotiate"),
    expectedArrival: d.expectedArrival, startTime: d.startTime ?? undefined, hours: d.hours || undefined, convertToNight: d.convertToNight,
  }, d.reason);
  return d.convertToNight ? "Converted to an overnight stay." : "Reservation updated.";
}));

frontOffice.post("/reservations/:id/confirm", form, h(async (req) => {
  const s = await staff(req, "reservations.edit");
  await confirmReservation(s.actor, String(req.params.id));
  return "Reservation confirmed.";
}));

frontOffice.post("/reservations/:id/cancel", form, h(async (req) => {
  const s = await staff(req, "reservations.cancel");
  const d = z.object({ reason: zReq("Reason", 500), waiveFee: zBool }).parse(body(req));
  const { fee } = await cancelReservation(s.actor, String(req.params.id), d.reason, { waiveFee: d.waiveFee });
  return fee.gt(0) ? `Cancelled. Late cancellation fee of ₦${fee.toFixed(2)} posted.` : "Reservation cancelled.";
}));

frontOffice.post("/reservations/:id/no-show", form, h(async (req) => {
  const s = await staff(req, "reservations.cancel");
  const d = z.object({ reason: zReq("Reason", 500) }).parse(body(req));
  await markNoShow(s.actor, String(req.params.id), d.reason);
  return "Marked as no-show.";
}));

frontOffice.post("/reservations/:id/check-in", form, h(async (req) => {
  const s = await staff(req, "frontdesk.checkin");
  const d = z.object({ idType: zOpt(40), idNumber: zOpt(40), notes: zOpt(500), allowUnpaid: zBool }).parse(body(req));
  const id = String(req.params.id);
  await checkIn(s.actor, id, { idType: d.idType ?? undefined, idNumber: d.idNumber ?? undefined, notes: d.notes ?? undefined, allowUnpaid: d.allowUnpaid });
  const r = await prisma.reservation.findUniqueOrThrow({ where: { id }, include: { room: true } });
  return { ok: true, message: `Checked in to Room ${r.room.number}.`, data: { redirect: `/manage/reservations/${id}` } };
}));

frontOffice.post("/reservations/:id/overtime", form, h(async (req) => {
  const s = await staff(req, "frontdesk.checkout", "folio.charge");
  const r = await applyShortStayOvertime(s.actor, String(req.params.id));
  return r ? "Overtime charge applied. Collect the new balance before check-out." : "No overtime to charge.";
}));

frontOffice.post("/reservations/:id/check-out", form, h(async (req) => {
  const s = await staff(req, "frontdesk.checkout");
  const d = z.object({ allowBalance: zBool, reason: zOpt(500) }).parse(body(req));
  if (d.allowBalance && !s.can("folio.adjust") && !s.can("payments.verify")) throw new AppError("Only managers or finance can check out a guest with an unpaid balance.");
  const id = String(req.params.id);
  const { invoice } = await checkOut(s.actor, id, { allowBalance: d.allowBalance, reason: d.reason });
  return { ok: true, message: `Checked out. Invoice ${invoice.number} issued; housekeeping notified.`, data: { redirect: `/manage/reservations/${id}` } };
}));

frontOffice.post("/reservations/:id/invoice", form, h(async (req) => {
  const s = await staff(req, "invoices.issue");
  const inv = await prisma.$transaction((tx) => issueInvoice(tx, s.actor, String(req.params.id)));
  return `Invoice ${inv.number} generated.`;
}));

// ───────── New-booking helper: free rooms with prices ─────────
frontOffice.get("/booking-options", h(async (req) => {
  await staff(req, "reservations.create", "reservations.view");
  const settings = await getSettings();
  const today = todayLagos();
  const type = q(req, "type") === "SHORT" ? "SHORT" : "NIGHT";
  const guests = Math.max(1, Number(q(req, "adults") ?? 1)) + Math.max(0, Number(q(req, "children") ?? 0));
  const arrival = isDateStr(q(req, "arrival")) ? q(req, "arrival")! : today;
  if (type === "SHORT") {
    const hours = Number(q(req, "hours") ?? settings.shortStay.tiers[0]?.hours ?? 2);
    const nowHHMM = new Date(Date.now() + 3600_000).toISOString().slice(11, 16);
    const start = q(req, "start") ?? nowHHMM;
    const rooms = await findAvailableRooms(shortSpan(arrival, start, hours), { guests, shortStayOnly: true });
    const quotes = await Promise.all(rooms.map((r) => quoteShortStay(prisma, r.id, arrival, start, hours)));
    return { type, arrival, start, hours, rooms: rooms.map((r, i) => ({ ...r, quote: quotes[i].quote })), tiers: settings.shortStay.tiers, eveningFrom: settings.shortStay.eveningFrom };
  }
  const departure = isDateStr(q(req, "departure")) && q(req, "departure")! > arrival ? q(req, "departure")! : addDays(arrival, 1);
  if (arrival < today) throw new AppError("Arrival date is in the past.");
  const rooms = await findAvailableRooms(nightSpan(arrival, departure, settings), { guests });
  const quotes = await Promise.all(rooms.map((r) => quoteForRoom(prisma, r.id, arrival, departure)));
  return { type, arrival, departure, nights: nightsBetween(arrival, departure), rooms: rooms.map((r, i) => ({ ...r, quote: quotes[i].quote })), tiers: settings.shortStay.tiers };
}));

// ───────── Calendar ─────────
frontOffice.get("/calendar", h(async (req) => {
  await staff(req, "reservations.view");
  const today = todayLagos();
  const days = [7, 14, 21, 31].includes(Number(q(req, "days"))) ? Number(q(req, "days")) : 14;
  const start = isDateStr(q(req, "start")) ? q(req, "start")! : addDays(today, -1);
  const end = addDays(start, days);
  const rooms = await prisma.room.findMany({
    orderBy: [{ sortOrder: "asc" }, { number: "asc" }],
    include: {
      reservations: { where: { status: { in: ["PENDING", "CONFIRMED", "CHECKED_IN", "CHECKED_OUT"] }, arrivalDate: { lt: toDbDate(end) }, departureDate: { gte: toDbDate(start) } }, include: { guest: { select: { firstName: true, lastName: true } } }, orderBy: { startAt: "asc" } },
      blocks: { where: { releasedAt: null, startDate: { lt: toDbDate(end) }, OR: [{ endDate: null }, { endDate: { gt: toDbDate(start) } }] } },
    },
  });
  return { start, days, today, rooms };
}));

// ───────── Front desk queues ─────────
frontOffice.get("/front-desk/arrivals", h(async (req) => {
  await staff(req, "frontdesk.checkin");
  const today = todayLagos();
  const s = q(req, "q");
  const where: Prisma.ReservationWhereInput = s
    ? { status: { in: ["PENDING", "CONFIRMED"] }, OR: [{ reference: { equals: s.toUpperCase() } }, { guest: { OR: [{ firstName: { contains: s, mode: "insensitive" } }, { lastName: { contains: s, mode: "insensitive" } }, { phone: { contains: s } }] } }] }
    : { status: { in: ["PENDING", "CONFIRMED"] }, arrivalDate: { lte: toDbDate(today) }, departureDate: { gte: toDbDate(today) } };
  return { today, list: await prisma.reservation.findMany({ where, include: { guest: true, room: true }, orderBy: { startAt: "asc" }, take: 30 }) };
}));

frontOffice.get("/front-desk/in-house", h(async (req) => {
  await staff(req, "frontdesk.checkout", "payments.record");
  const s = q(req, "q");
  const payMode = q(req, "mode") === "pay";
  const where: Prisma.ReservationWhereInput = {
    status: payMode ? { in: ["CHECKED_IN", "CONFIRMED", "PENDING", "CHECKED_OUT"] } : "CHECKED_IN",
    ...(s ? { OR: [{ reference: { equals: s.toUpperCase() } }, { room: { number: s } }, { guest: { OR: [{ firstName: { contains: s, mode: "insensitive" } }, { lastName: { contains: s, mode: "insensitive" } }, { phone: { contains: s } }] } }] } : payMode ? { status: "CHECKED_IN" } : {}),
  };
  return { today: todayLagos(), list: await prisma.reservation.findMany({ where, include: { guest: true, room: true }, orderBy: { endAt: "asc" }, take: 40 }) };
}));

/** Everything the front desk needs about one booking at check-in or check-out (ID shown masked). */
frontOffice.get("/front-desk/:id", h(async (req) => {
  const s = await staff(req, "frontdesk.checkin", "frontdesk.checkout", "payments.record");
  const r = found(await prisma.reservation.findUnique({ where: { id: String(req.params.id) }, include: { guest: true, room: { include: { roomType: true } } } }), "Reservation");
  const [folio, settings, overtime] = await Promise.all([folioSummary(r.id), getSettings(), shortStayOvertime(r.id)]);
  const idNum = decrypt(r.guest.idNumberEncrypted);
  const { idNumberEncrypted: _x, ...g } = r.guest;
  const depositDue = r.stayType === "SHORT" ? folio.total : round2(folio.total.mul(D(settings.finance.depositPercent)).div(100));
  return { reservation: { ...r, guest: { ...g, idOnFile: idNum ? (s.can("guests.view_sensitive") ? idNum : maskId(idNum)) : null } }, folio, depositDue, depositPercent: settings.finance.depositPercent, overtime, categories: POSTABLE_CATEGORIES };
}));

// ───────── Availability ─────────
frontOffice.get("/availability", h(async (req) => {
  await staff(req, "reservations.view", "rooms.view");
  const settings = await getSettings();
  const today = todayLagos();
  const arrival = isDateStr(q(req, "arrival")) ? q(req, "arrival")! : today;
  const departure = isDateStr(q(req, "departure")) && q(req, "departure")! > arrival ? q(req, "departure")! : addDays(arrival, 1);
  const guests = Math.max(1, Number(q(req, "guests")) || 1);
  const rooms = await findAvailableRooms(nightSpan(arrival, departure, settings), { guests });
  const quotes = await Promise.all(rooms.map((r) => quoteForRoom(prisma, r.id, arrival, departure)));
  return { arrival, departure, guests, nights: nightsBetween(arrival, departure), rooms: rooms.map((r, i) => ({ ...r, quote: quotes[i].quote })) };
}));

// ───────── Guests (CRM) ─────────
frontOffice.get("/guests", h(async (req) => {
  await staff(req, "guests.view");
  const { take, skip, page: p } = page(req, 30);
  const s = q(req, "q"), f = q(req, "filter");
  const where: Prisma.GuestWhereInput = {
    deletedAt: null,
    ...(s ? { OR: [{ firstName: { contains: s, mode: "insensitive" } }, { lastName: { contains: s, mode: "insensitive" } }, { phone: { contains: s } }, { email: { contains: s, mode: "insensitive" } }] } : {}),
    ...(f === "vip" ? { isVip: true } : f === "flagged" ? { isBlacklisted: true } : f === "inhouse" ? { reservations: { some: { status: "CHECKED_IN" } } } : {}),
  };
  const [guests, total] = await Promise.all([
    prisma.guest.findMany({ where, select: { id: true, firstName: true, lastName: true, phone: true, email: true, isVip: true, isBlacklisted: true, userId: true, _count: { select: { reservations: { where: { status: "CHECKED_OUT" } } } }, reservations: { orderBy: { startAt: "desc" }, take: 1, select: { arrivalDate: true } } }, orderBy: { updatedAt: "desc" }, take, skip }),
    prisma.guest.count({ where }),
  ]);
  return { guests, total, page: p, pages: Math.ceil(total / take) };
}));

frontOffice.get("/guests/search", h(async (req) => {
  await staff(req, "reservations.create", "guests.view");
  const s = q(req, "q");
  if (!s) return { guests: [] };
  return { guests: await prisma.guest.findMany({ where: { deletedAt: null, OR: [{ firstName: { contains: s, mode: "insensitive" } }, { lastName: { contains: s, mode: "insensitive" } }, { phone: { contains: s } }, { email: { contains: s, mode: "insensitive" } }] }, select: { id: true, firstName: true, lastName: true, phone: true, email: true, isVip: true, isBlacklisted: true }, take: 10, orderBy: { updatedAt: "desc" } }) };
}));

frontOffice.get("/guests/:id", h(async (req) => {
  const s = await staff(req, "guests.view");
  const g = found(await prisma.guest.findUnique({
    where: { id: String(req.params.id) },
    include: {
      preferences: true, notes: s.can("guests.notes") ? { orderBy: { createdAt: "desc" } } : false,
      reservations: { include: { room: true }, orderBy: { startAt: "desc" } },
      payments: s.can("payments.view") ? { orderBy: { receivedAt: "desc" }, take: 30 } : false,
      serviceRequests: { orderBy: { createdAt: "desc" }, take: 20 }, reviews: { orderBy: { createdAt: "desc" } },
    },
  }), "Guest");
  const bal = await balancesFor(g.reservations.map((r) => r.id));
  const idNum = decrypt(g.idNumberEncrypted);
  const { idNumberEncrypted: _x, ...rest } = g;
  const finance = s.can("payments.view");
  return {
    guest: { ...rest, idMasked: idNum ? maskId(idNum) : null, hasIdDocument: !!g.idDocumentPath },
    balances: finance ? asObj(bal) : {},
    stats: {
      stays: g.reservations.filter((r) => r.status === "CHECKED_OUT").length, bookings: g.reservations.length,
      lifetime: finance ? sum(g.reservations.filter((r) => ["CHECKED_OUT", "CHECKED_IN"].includes(r.status)).map((r) => bal.get(r.id)!.total)) : null,
      outstanding: finance ? sum([...bal.values()].filter((b) => b.balance.gt(0)).map((b) => b.balance)) : null,
    },
  };
}));

const guestSchema = z.object({
  firstName: zReq("First name", 60), lastName: zReq("Last name", 60), email: z.string().trim().toLowerCase().email("Enter a valid email").optional().or(z.literal("")).transform((v) => v || null),
  phone: zOpt(30), address: zOpt(300), city: zOpt(80), country: zOpt(80), nationality: zOpt(60), dateOfBirth: zOptDate, idType: zOpt(40), idNumber: zOpt(40),
});

frontOffice.post("/guests", form, h(async (req) => {
  const s = await staff(req, "guests.manage");
  const d = guestSchema.parse(body(req));
  if (d.idNumber && !s.can("guests.view_sensitive")) throw new AppError("You are not permitted to record ID numbers.");
  const g = await createGuest(s.actor, d);
  return { ok: true, message: "Guest registered.", data: { id: g.id, redirect: `/manage/guests/${g.id}` } };
}));

frontOffice.post("/guests/:id", form, h(async (req) => {
  const s = await staff(req, "guests.manage");
  const d = guestSchema.parse(body(req));
  if (d.idNumber && !s.can("guests.view_sensitive")) throw new AppError("You are not permitted to change ID numbers.");
  await updateGuest(s.actor, String(req.params.id), d);
  return "Guest updated.";
}));

frontOffice.post("/guests/:id/flags", form, h(async (req) => {
  const s = await staff(req, "guests.vip");
  const d = z.object({ isVip: zBool, isBlacklisted: zBool, reason: zReq("Reason", 500) }).parse(body(req));
  await setGuestFlags(s.actor, String(req.params.id), { isVip: d.isVip, isBlacklisted: d.isBlacklisted }, d.reason);
  return "Guest flags updated.";
}));

frontOffice.post("/guests/:id/notes", form, h(async (req) => {
  const s = await staff(req, "guests.notes");
  const d = z.object({ body: zReq("Note", 2000) }).parse(body(req));
  await addGuestNote(s.actor, String(req.params.id), d.body);
  return "Note added.";
}));

frontOffice.post("/guests/:id/preferences", form, h(async (req) => {
  const s = await staff(req, "guests.manage");
  const o = body(req);
  if (o.removeId) { await removeGuestPreference(s.actor, String(o.removeId)); return "Removed."; }
  const d = z.object({ category: zReq("Category", 40), value: zReq("Value", 200) }).parse(o);
  await addGuestPreference(s.actor, String(req.params.id), d.category, d.value);
  return "Preference recorded.";
}));

frontOffice.post("/guests/:id/reveal-id", form, h(async (req) => {
  const s = await staff(req, "guests.view_sensitive");
  const g = found(await prisma.guest.findUnique({ where: { id: String(req.params.id) } }), "Guest");
  await audit(prisma, s.actor, { action: "guest.id_viewed", module: "guests", recordType: "Guest", recordId: g.id });
  return { ok: true, message: `${g.idType ?? "ID"}: ${decrypt(g.idNumberEncrypted) ?? "not recorded"}` };
}));

// ───────── Booking forms (guests never pick rooms; the front desk allocates) ─────────
frontOffice.get("/requests", h(async (req) => {
  await staff(req, "requests.allocate");
  const open = q(req, "status") !== "done";
  const rows = await prisma.bookingRequest.findMany({
    where: open ? { status: "NEW" } : { status: { not: "NEW" } },
    include: { roomType: true, reservation: { select: { id: true, reference: true, room: { select: { number: true } } } } },
    orderBy: open ? [{ checkInDate: "asc" }, { createdAt: "asc" }] : { updatedAt: "desc" }, take: 100,
  });
  return { requests: rows.map(({ accessTokenHash: _h, accessTokenEnc: _e, ...r }) => ({ ...r, when: describeRequest(r) })) };
}));

frontOffice.get("/requests/:id", h(async (req) => {
  await staff(req, "requests.allocate");
  const settings = await getSettings();
  const r = found(await prisma.bookingRequest.findUnique({ where: { id: String(req.params.id) }, include: { roomType: true, guest: true, reservation: { include: { room: true } } } }), "Booking form");
  const { accessTokenHash: _h, accessTokenEnc: _e, ...safe } = r;
  const date = q(req, "date") && isDateStr(q(req, "date")) ? q(req, "date")! : fromDbDate(r.checkInDate);
  const time = q(req, "time") ?? r.checkInTime;
  const nights = Number(q(req, "nights") ?? r.nights ?? 1), hours = Number(q(req, "hours") ?? r.hours ?? settings.shortStay.tiers[0]?.hours ?? 2);
  let rooms: Awaited<ReturnType<typeof findAvailableRooms>> = [];
  let roomsError: string | null = null;
  if (r.status === "NEW") {
    try {
      const span = r.stayType === "SHORT" ? shortSpan(date, time, hours) : nightSpan(date, addDays(date, nights), settings);
      rooms = await findAvailableRooms(span, { guests: r.adults + r.children, shortStayOnly: r.stayType === "SHORT" });
    } catch (e) { roomsError = (e as Error).message; }
  }
  const quotes = await Promise.all(rooms.map((rm) => (r.stayType === "SHORT" ? quoteShortStay(prisma, rm.id, date, time, hours) : quoteForRoom(prisma, rm.id, date, addDays(date, nights))).then((x) => x.quote.total).catch(() => null)));
  const guestFlags = r.guest ? { isVip: r.guest.isVip, isBlacklisted: r.guest.isBlacklisted } : await prisma.guest.findFirst({ where: { deletedAt: null, OR: [{ phone: r.phone }, ...(r.email ? [{ email: { equals: r.email, mode: "insensitive" as const } }] : [])] }, select: { id: true, isVip: true, isBlacklisted: true, firstName: true, lastName: true } });
  return {
    request: { ...safe, when: describeRequest(r) }, stay: { date, time, nights, hours }, today: todayLagos(), tiers: settings.shortStay.tiers,
    rooms: rooms.map((rm, i) => ({ id: rm.id, number: rm.number, typeName: rm.roomType.name, roomTypeId: rm.roomTypeId, housekeepingStatus: rm.housekeepingStatus, total: quotes[i] })),
    roomsError, knownGuest: guestFlags,
  };
}));

frontOffice.post("/requests/:id/allocate", form, h(async (req) => {
  const s = await staff(req, "requests.allocate");
  const d = z.object({
    roomId: zReq("Room"), date: zDate, time: z.string().regex(/^\d{2}:\d{2}$/, "Enter a time"), nights: z.coerce.number().int().optional(), hours: z.coerce.number().int().optional(),
    paymentMethod: z.enum(["CASH", "POS", "BANK_TRANSFER", "NONE"]), amount: zOpt(20), externalRef: zOpt(80), transferConfirmed: zBool,
    rateOverride: zOpt(20), negotiationReason: zOpt(500), checkInNow: zBool,
  }).parse(body(req));
  if (d.paymentMethod === "NONE" && !s.can("pricing.negotiate") && !s.can("payments.verify")) throw new AppError("Payment must be confirmed before a room is allocated. A manager can allocate without payment.");
  const { reservation, room, goCheckIn } = await allocateRequest(s.actor, String(req.params.id), {
    ...d, amount: d.amount?.replace(/[₦,\s]/g, ""), rateOverride: d.rateOverride?.replace(/[₦,\s]/g, "") || null, canNegotiate: s.can("pricing.negotiate"),
  });
  return { ok: true, message: `Room ${room.number} allocated. Booking ${reservation.reference} confirmed and the guest can now see their room.`, data: { redirect: goCheckIn && s.can("frontdesk.checkin") ? `/manage/front-desk/check-in?id=${reservation.id}` : `/manage/reservations/${reservation.id}` } };
}));

frontOffice.post("/requests/:id/decline", form, h(async (req) => {
  const s = await staff(req, "requests.allocate");
  const d = z.object({ reason: zReq("Reason", 500) }).parse(body(req));
  await declineRequest(s.actor, String(req.params.id), d.reason);
  return { ok: true, message: "Booking form declined.", data: { redirect: "/manage/requests" } };
}));
