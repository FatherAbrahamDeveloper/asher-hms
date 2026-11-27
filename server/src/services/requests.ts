/**
 * Booking requests: the guest fills a short form (website or QR code at reception) and pays.
 * The front desk confirms the payment and allocates a room. Guests never see which rooms are free.
 */
import { prisma, type Tx } from "../lib/db";
import { addDays, fmtDate, fmtDateTime, isDateStr, toDbDate, todayLagos, fromDbDate, type DateStr } from "../lib/dates";
import { D, naira, round2, toDb } from "../lib/money";
import { makeRef } from "../lib/refs";
import { audit, type Actor } from "../lib/audit";
import { AppError } from "../lib/errors";
import { decrypt, encrypt, randomToken, sha256 } from "../lib/crypto";
import { notifyGuest, notifyStaff, queueDelivery } from "../lib/notify";
import { getSettings } from "../lib/settings";
import { quoteForRoom, quoteShortStay, type Quote } from "./pricing";
import { createReservation } from "./reservations";
import { recordPayment } from "./billing";
import { folioSummary } from "./folio";
import type { StayType } from "@/generated/prisma/enums";

export type RequestStay = { roomTypeId: string; stayType: StayType; date: DateStr; time: string; nights?: number | null; hours?: number | null };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const appUrl = () => (process.env.APP_URL ?? "").replace(/\/$/, "");
export const statusLink = (reference: string, token: string) => `/booking/${reference}?t=${token}`;

/** Price for a room type (guests never pick a room). Uses the type's first active room as the price reference. */
export async function quoteForType(db: Tx, s: RequestStay): Promise<{ quote: Quote; departure: DateStr }> {
  const settings = await getSettings(db);
  if (!isDateStr(s.date)) throw new AppError("Choose your check-in date.");
  if (!HHMM.test(s.time)) throw new AppError("Choose your check-in time.");
  const today = todayLagos();
  if (s.date < today) throw new AppError("The check-in date cannot be in the past.");
  if (s.date > addDays(today, settings.reservations.maxAdvanceDays)) throw new AppError(`Bookings can be made at most ${settings.reservations.maxAdvanceDays} days ahead.`);
  const type = await db.roomType.findUnique({ where: { id: s.roomTypeId } });
  if (!type || !type.isActive) throw new AppError("Choose a room type.");
  const short = s.stayType === "SHORT";
  if (short && !settings.shortStay.enabled) throw new AppError("Short stays are not available at the moment.");
  if (short && !settings.shortStay.onlineBooking) throw new AppError("Short stays are booked at reception. Please speak to the front desk.");
  const room = await db.room.findFirst({ where: { roomTypeId: type.id, isActive: true, ...(short ? { allowShortStay: true } : {}) }, orderBy: [{ sortOrder: "asc" }, { number: "asc" }] });
  if (!room) throw new AppError(short ? `${type.name} rooms are not offered for short stays.` : `${type.name} rooms are not available for booking.`);
  if (short) {
    if (!s.hours || !settings.shortStay.tiers.some((t) => t.hours === s.hours)) throw new AppError("Choose a short-stay package.");
    const { quote } = await quoteShortStay(db, room.id, s.date, s.time, s.hours);
    return { quote, departure: s.date };
  }
  const nights = Number(s.nights);
  if (!Number.isInteger(nights) || nights < 1) throw new AppError("Enter the number of nights.");
  if (nights > settings.reservations.maxNights) throw new AppError(`A booking can be at most ${settings.reservations.maxNights} nights.`);
  const departure = addDays(s.date, nights);
  const { quote } = await quoteForRoom(db, room.id, s.date, departure);
  return { quote, departure };
}

export type SubmitInput = RequestStay & {
  fullName: string; phone: string; email?: string | null; address: string; company?: string | null;
  nextOfKinName: string; nextOfKinPhone: string; adults: number; children: number; specialRequests?: string | null;
  paymentMethod: "TRANSFER" | "CASH"; transferRef?: string | null; payerName?: string | null; proofPath?: string | null;
};

export async function submitRequest(actor: Actor, input: SubmitInput, guestId: string | null) {
  const { quote } = await quoteForType(prisma, input);
  const type = await prisma.roomType.findUniqueOrThrow({ where: { id: input.roomTypeId } });
  if (input.adults + input.children > type.maxOccupancy) throw new AppError(`${type.name} rooms take at most ${type.maxOccupancy} guests. Please fill a separate form for extra rooms.`);
  if (guestId) {
    const g = await prisma.guest.findUnique({ where: { id: guestId } });
    if (g?.isBlacklisted) throw new AppError("We are unable to accept this booking online. Please speak to the front desk.");
  }
  const token = randomToken(24);
  const req = await prisma.$transaction(async (tx) => {
    let reference = makeRef("REQ", 6);
    while (await tx.bookingRequest.findUnique({ where: { reference } })) reference = makeRef("REQ", 6);
    const r = await tx.bookingRequest.create({
      data: {
        reference, accessTokenHash: sha256(token), accessTokenEnc: encrypt(token), guestId,
        fullName: input.fullName.trim(), phone: input.phone.trim(), email: input.email?.trim().toLowerCase() || null, address: input.address.trim(),
        company: input.company?.trim() || null, nextOfKinName: input.nextOfKinName.trim(), nextOfKinPhone: input.nextOfKinPhone.trim(),
        stayType: input.stayType, roomTypeId: input.roomTypeId, checkInDate: toDbDate(input.date), checkInTime: input.time,
        nights: input.stayType === "NIGHT" ? Number(input.nights) : null, hours: input.stayType === "SHORT" ? Number(input.hours) : null,
        adults: input.adults, children: input.children, specialRequests: input.specialRequests || null, quotedTotal: toDb(quote.total),
        paymentMethod: input.paymentMethod, transferRef: input.transferRef?.trim() || null, payerName: input.payerName?.trim() || null, proofPath: input.proofPath ?? null,
      },
    });
    await audit(tx, actor, { action: "booking_request.submit", module: "reservations", recordType: "BookingRequest", recordId: r.id, newValues: { reference, name: r.fullName, phone: r.phone, type: type.name, stay: describe(r), total: quote.total.toFixed(2), payment: r.paymentMethod, transferRef: r.transferRef } });
    await notifyStaff(tx, ["requests.allocate"], {
      category: "reservation", priority: "HIGH", title: `New booking form ${reference}`,
      body: `${r.fullName} · ${type.name} · ${describe(r)} · ${naira(quote.total)} · ${r.paymentMethod === "CASH" ? "paying cash at reception" : r.transferRef ? `transfer ref ${r.transferRef}` : "will pay by transfer"}`,
      link: `/manage/requests/${r.id}`, dedupeKey: `req-new:${r.id}`,
    });
    if (r.email) await queueDelivery(tx, { channel: "EMAIL", recipient: r.email, subject: `Booking form received (${reference})`, body: `Dear ${r.fullName},\n\nWe have received your booking form for a ${type.name}, ${describe(r)}. Total: ${naira(quote.total)}.\n\nThe front desk will confirm your payment and allocate your room. Follow your booking here:\n${appUrl()}${statusLink(reference, token)}\n\nAsher Hotel and Suites`, dedupeKey: `req-new:${r.id}` });
    return r;
  });
  return { request: req, token, link: statusLink(req.reference, token) };
}

export function describe(r: { stayType: StayType; checkInDate: Date; checkInTime: string; nights: number | null; hours: number | null }) {
  return r.stayType === "SHORT"
    ? `${fmtDate(r.checkInDate)} from ${r.checkInTime}, ${r.hours} hours`
    : `${fmtDate(r.checkInDate)} from ${r.checkInTime}, ${r.nights} night${r.nights === 1 ? "" : "s"}`;
}

/** Load a request by its private link. Returns null (not an error) when the link is wrong. */
export async function findByToken(reference: string, token: string) {
  if (!token) return null;
  const r = await prisma.bookingRequest.findUnique({ where: { reference: reference.toUpperCase() }, include: { roomType: true } });
  if (!r || r.accessTokenHash !== sha256(token)) return null;
  return r;
}

/** Guest-facing view of a request: never exposes other rooms or availability. */
export async function guestView(id: string) {
  const r = await prisma.bookingRequest.findUniqueOrThrow({
    where: { id },
    include: {
      roomType: true,
      reservation: { include: { room: { include: { roomType: true, images: { orderBy: { sortOrder: "asc" } }, amenities: { include: { amenity: true } } } }, invoices: { orderBy: { issuedAt: "desc" }, take: 1 } } },
    },
  });
  const settings = await getSettings();
  const folio = r.reservation ? await folioSummary(r.reservation.id) : null;
  return {
    reference: r.reference, status: r.status, fullName: r.fullName, phone: r.phone, email: r.email, stayType: r.stayType, roomType: { name: r.roomType.name },
    checkInDate: fromDbDate(r.checkInDate), checkInTime: r.checkInTime, nights: r.nights, hours: r.hours, adults: r.adults, children: r.children,
    quotedTotal: r.quotedTotal, paymentMethod: r.paymentMethod, transferRef: r.transferRef, hasProof: !!r.proofPath, declineReason: r.declineReason,
    createdAt: r.createdAt, handledAt: r.handledAt,
    reservation: r.reservation && {
      reference: r.reservation.reference, status: r.reservation.status, stayType: r.reservation.stayType, startAt: r.reservation.startAt, endAt: r.reservation.endAt,
      arrivalDate: r.reservation.arrivalDate, departureDate: r.reservation.departureDate, shortStayHours: r.reservation.shortStayHours,
      room: { number: r.reservation.room.number, name: r.reservation.room.name, description: r.reservation.room.description, typeName: r.reservation.room.roomType.name, bedConfiguration: r.reservation.room.bedConfiguration, images: r.reservation.room.images.map((i) => ({ path: i.path, caption: i.caption })), amenities: r.reservation.room.amenities.map((a) => a.amenity.name) },
    },
    folio: folio && { total: folio.total, paid: folio.netPaid, pending: folio.pending, balance: folio.balance },
    hotel: { name: settings.hotel.name, phone: settings.hotel.phone, checkInTime: settings.policies.checkInTime, checkOutTime: settings.policies.checkOutTime },
    bank: { bankName: settings.finance.bankName, accountName: settings.finance.accountName, accountNumber: settings.finance.accountNumber, paymentInstructions: settings.finance.paymentInstructions },
  };
}

export async function addTransferDetails(id: string, input: { transferRef: string; payerName?: string | null; proofPath?: string | null }) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.bookingRequest.findUniqueOrThrow({ where: { id } });
    if (r.status !== "NEW") throw new AppError("This booking has already been handled by the front desk.");
    await tx.bookingRequest.update({ where: { id }, data: { paymentMethod: "TRANSFER", transferRef: input.transferRef.trim(), payerName: input.payerName?.trim() || r.payerName, proofPath: input.proofPath ?? r.proofPath } });
    await audit(tx, { userId: null, name: r.fullName, role: "public", type: "GUEST" }, { action: "booking_request.transfer_details", module: "reservations", recordType: "BookingRequest", recordId: id, newValues: { transferRef: input.transferRef, proof: !!input.proofPath } });
    await notifyStaff(tx, ["requests.allocate"], { category: "payment", priority: "HIGH", title: `Transfer details sent for ${r.reference}`, body: `${r.fullName} says they paid by transfer (ref ${input.transferRef}). Confirm it in the bank account, then allocate a room.`, link: `/manage/requests/${id}`, dedupeKey: `req-transfer:${id}:${input.transferRef}` });
  });
}

export async function cancelByGuest(id: string) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.bookingRequest.findUniqueOrThrow({ where: { id } });
    if (r.status !== "NEW") throw new AppError("This booking has already been handled. Please contact the front desk.");
    await tx.bookingRequest.update({ where: { id }, data: { status: "CANCELLED" } });
    await audit(tx, { userId: null, name: r.fullName, role: "public", type: "GUEST" }, { action: "booking_request.cancel", module: "reservations", recordType: "BookingRequest", recordId: id });
  });
}

/** Lost link: reference + phone number gets the private link back. */
export async function lookupLink(reference: string, phone: string) {
  const digits = (v: string) => v.replace(/\D/g, "").slice(-10);
  const r = await prisma.bookingRequest.findUnique({ where: { reference: reference.trim().toUpperCase() } });
  if (!r || digits(r.phone) !== digits(phone)) throw new AppError("We couldn't find a booking with that reference and phone number.");
  return statusLink(r.reference, decrypt(r.accessTokenEnc)!);
}

function splitName(full: string) {
  const parts = full.trim().split(/\s+/);
  return parts.length > 1 ? { firstName: parts[0], lastName: parts.slice(1).join(" ") } : { firstName: parts[0], lastName: "-" };
}

export type AllocateInput = {
  roomId: string; date: DateStr; time: string; nights?: number | null; hours?: number | null;
  paymentMethod: "CASH" | "POS" | "BANK_TRANSFER" | "NONE"; amount?: string | null; externalRef?: string | null; transferConfirmed: boolean;
  rateOverride?: string | null; negotiationReason?: string | null; canNegotiate: boolean; checkInNow: boolean;
};

/**
 * Front desk: confirm the payment and allocate a room. Creates (or reuses) the guest profile, a confirmed reservation,
 * the verified payment, and tells the guest which room they have.
 */
export async function allocateRequest(actor: Actor, id: string, input: AllocateInput) {
  const r = await prisma.bookingRequest.findUniqueOrThrow({ where: { id } });
  if (r.status !== "NEW") throw new AppError(`This booking form is already ${r.status.toLowerCase()}.`);
  const amount = input.paymentMethod === "NONE" ? D(0) : round2(D(input.amount || "0"));
  if (input.paymentMethod !== "NONE" && amount.lte(0)) throw new AppError("Enter the amount received.");
  if (input.paymentMethod === "BANK_TRANSFER") {
    if (!input.externalRef?.trim()) throw new AppError("Enter the bank transfer reference.");
    if (!input.transferConfirmed) throw new AppError("Tick to confirm you have seen this transfer in the hotel account.");
    if (await prisma.payment.findUnique({ where: { externalRef: input.externalRef.trim() } })) throw new AppError("That transfer reference has already been used for another payment.");
  }
  const short = r.stayType === "SHORT";

  // Guest profile: the guest's own account, or an existing profile with the same email/phone, or a new one.
  let guestId = r.guestId;
  if (!guestId) {
    const match = await prisma.guest.findFirst({
      where: { deletedAt: null, OR: [...(r.email ? [{ email: { equals: r.email, mode: "insensitive" as const } }] : []), { phone: r.phone }] },
      orderBy: { updatedAt: "desc" },
    });
    if (match) guestId = match.id;
    else {
      const n = splitName(r.fullName);
      const g = await prisma.guest.create({ data: { ...n, email: r.email, phone: r.phone, address: r.address, company: r.company, nextOfKinName: r.nextOfKinName, nextOfKinPhone: r.nextOfKinPhone } });
      await audit(prisma, actor, { action: "guest.create", module: "guests", recordType: "Guest", recordId: g.id, newValues: { name: r.fullName, phone: r.phone, source: `booking form ${r.reference}` } });
      guestId = g.id;
    }
  }
  const g = await prisma.guest.findUniqueOrThrow({ where: { id: guestId } });
  await prisma.guest.update({ where: { id: g.id }, data: { address: g.address ?? r.address, company: g.company ?? r.company, nextOfKinName: r.nextOfKinName, nextOfKinPhone: r.nextOfKinPhone, phone: g.phone ?? r.phone, email: g.email ?? r.email } });

  const today = todayLagos();
  const startNow = input.checkInNow && input.date === today;
  // Short stays keep the time the guest booked (so the price matches the form) unless that time has already passed.
  const nowHHMM = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(Date.now() - 30 * 60_000));
  const shortStart = input.date === today && input.time < nowHHMM ? "now" : input.time;
  const res = await createReservation(actor, {
    guestId, roomId: input.roomId, stayType: r.stayType, arrival: input.date,
    departure: short ? undefined : addDays(input.date, Number(input.nights ?? r.nights)),
    startTime: short ? shortStart : undefined, hours: short ? Number(input.hours ?? r.hours) : undefined,
    adults: r.adults, children: r.children, source: "ONLINE", paymentPlan: "PAY_NOW", specialRequests: r.specialRequests,
    rateOverride: input.rateOverride, negotiationReason: input.negotiationReason, canNegotiate: input.canNegotiate,
    confirmImmediately: true, expectedArrival: short ? null : input.time,
  });

  if (amount.gt(0)) {
    await recordPayment(actor, {
      reservationId: res.id, method: input.paymentMethod as "CASH" | "POS" | "BANK_TRANSFER", amount, isDeposit: false,
      externalRef: input.externalRef || null, payerName: r.payerName || r.fullName, notes: `Booking form ${r.reference}`, markVerified: true, canVerify: true,
    });
  }

  const room = await prisma.room.findUniqueOrThrow({ where: { id: input.roomId } });
  const token = decrypt(r.accessTokenEnc)!;
  await prisma.$transaction(async (tx) => {
    await tx.bookingRequest.update({ where: { id }, data: { status: "ALLOCATED", guestId, reservationId: res.id, handledById: actor.userId, handledByName: actor.name, handledAt: new Date() } });
    await audit(tx, actor, { action: "booking_request.allocate", module: "reservations", recordType: "BookingRequest", recordId: id, newValues: { reservation: res.reference, room: room.number, payment: input.paymentMethod, amount: amount.toFixed(2), transferRef: input.externalRef } });
    await notifyGuest(tx, guestId!, { category: "reservation", title: `Your room is ready: Room ${room.number}`, body: `Booking ${res.reference} is confirmed. Room ${room.number}, ${fmtDateTime(res.startAt)}.`, link: statusLink(r.reference, token), dedupeKey: `req-alloc:${id}`, sms: true, email: false });
    if (r.email) await queueDelivery(tx, { channel: "EMAIL", recipient: r.email, subject: `Room ${room.number} allocated (${res.reference})`, body: `Dear ${r.fullName},\n\nYour payment has been confirmed and you have been allocated Room ${room.number}.\nBooking reference: ${res.reference}\n\nSee your room and details here:\n${appUrl()}${statusLink(r.reference, token)}\n\nAsher Hotel and Suites`, dedupeKey: `req-alloc:${id}` });
  });
  return { reservation: res, room, goCheckIn: startNow };
}

export async function declineRequest(actor: Actor, id: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.bookingRequest.findUniqueOrThrow({ where: { id } });
    if (r.status !== "NEW") throw new AppError(`This booking form is already ${r.status.toLowerCase()}.`);
    await tx.bookingRequest.update({ where: { id }, data: { status: "DECLINED", declineReason: reason, handledById: actor.userId, handledByName: actor.name, handledAt: new Date() } });
    await audit(tx, actor, { action: "booking_request.decline", module: "reservations", recordType: "BookingRequest", recordId: id, reason });
    if (r.email) await queueDelivery(tx, { channel: "EMAIL", recipient: r.email, subject: `About your booking form ${r.reference}`, body: `Dear ${r.fullName},\n\nWe're sorry, we could not confirm your booking: ${reason}\n\nPlease call the front desk if you have any questions.\n\nAsher Hotel and Suites`, dedupeKey: `req-decline:${id}` });
  });
}

