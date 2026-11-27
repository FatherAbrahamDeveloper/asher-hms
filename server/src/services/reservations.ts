import { prisma, type Tx } from "../lib/db";
import { addDays, fmtDate, fmtDateTime, fmtTime, fromDbDate, nightsBetween, toDbDate, todayLagos, type DateStr } from "../lib/dates";
import { D, naira, round2, toDb, type Decimal } from "../lib/money";
import { randomCode, makeRef } from "../lib/refs";
import { audit, type Actor } from "../lib/audit";
import { AppError } from "../lib/errors";
import { notifyGuest, notifyStaff } from "../lib/notify";
import { getSettings, type HotelSettings } from "../lib/settings";
import { encrypt } from "../lib/crypto";
import { assertRoomBookable, nightSpan, shortSpan, validateStayDates, type StaySpan } from "./availability";
import { overtimeOutcome, priceLine, quoteForRoom, quoteShortStay, shortStayPrice, type Quote } from "./pricing";
import { folioSummary, postLine, reverseActiveLines } from "./folio";
import { issueInvoice } from "./billing";
import type { BookingSource, PaymentPlan, ReservationStatus, StayType } from "@/generated/prisma/enums";

const TX_OPTS = { timeout: 20_000, maxWait: 10_000 };

async function uniqueBookingRef(tx: Tx, prefix: string) {
  for (let i = 0; i < 10; i++) {
    const ref = `${prefix}-${randomCode(6)}`;
    if (!(await tx.reservation.findUnique({ where: { reference: ref }, select: { id: true } }))) return ref;
  }
  throw new AppError("Could not allocate a booking reference. Please try again.");
}

export async function logHistory(tx: Tx, actor: Actor, reservationId: string, action: string, opts: { from?: ReservationStatus | null; to?: ReservationStatus | null; details?: unknown } = {}) {
  await tx.reservationHistory.create({
    data: { reservationId, action, fromStatus: opts.from ?? null, toStatus: opts.to ?? null, details: (opts.details ?? undefined) as never, actorId: actor.userId, actorName: actor.name },
  });
}

/** Lagos HH:MM for an instant. */
function lagosHHMM(d: Date) {
  return new Date(d.getTime() + 3600_000).toISOString().slice(11, 16);
}

/** Post the priced lines of a quote: one ROOM line per night, or one SHORT_STAY line, plus a discount line if any. */
async function postQuote(tx: Tx, actor: Actor, reservationId: string, roomNumber: string, quote: Quote, discountCode: string | null, note?: string) {
  for (const n of quote.nights) {
    await postLine(tx, actor, {
      reservationId, category: quote.stayType === "SHORT" ? "SHORT_STAY" : "ROOM",
      description: quote.stayType === "SHORT"
        ? `Room ${roomNumber} — short stay, ${quote.label}${quote.rate.toFixed(2) !== quote.standardRate.toFixed(2) ? " (negotiated rate)" : ""}${note ? ` — ${note}` : ""}`
        : `Room ${roomNumber} — night of ${fmtDate(n.date)}${n.seasonal ? ` (${n.seasonal})` : ""}${quote.rate.toFixed(2) !== quote.standardRate.toFixed(2) ? " (negotiated rate)" : ""}`,
      serviceDate: n.date, unitPrice: n.amount.toFixed(2), tax: n.tax.toFixed(2), serviceCharge: n.serviceCharge.toFixed(2),
    });
  }
  if (quote.discount) {
    await postLine(tx, actor, {
      reservationId, category: "DISCOUNT", description: `Discount ${discountCode} (${quote.discountPercent.toString()}%)`, serviceDate: quote.nights[0].date,
      unitPrice: quote.discount.amount.neg().toFixed(2), tax: quote.discount.tax.neg().toFixed(2), serviceCharge: quote.discount.serviceCharge.neg().toFixed(2),
    });
  }
}

/** Only managers (pricing.negotiate) may set a price; it must be lower or higher than standard with a recorded reason. */
function checkNegotiation(input: { rateOverride?: string | null; negotiationReason?: string | null }, canNegotiate: boolean) {
  if (!input.rateOverride) return null;
  if (!canNegotiate) throw new AppError("Only a manager can set a negotiated price.");
  if (!input.negotiationReason?.trim()) throw new AppError("Give a reason for the negotiated price.");
  const v = D(input.rateOverride);
  if (v.lte(0)) throw new AppError("The negotiated price must be greater than zero.");
  return v.toFixed(2);
}

function stayLabel(r: { stayType: StayType; arrivalDate: Date; departureDate: Date; startAt: Date; endAt: Date; shortStayHours: number | null }) {
  return r.stayType === "SHORT"
    ? `${fmtDate(r.arrivalDate)}, ${fmtTime(r.startAt)}–${fmtTime(r.endAt)} (${r.shortStayHours} hours)`
    : `${fmtDate(r.arrivalDate)} to ${fmtDate(r.departureDate)}`;
}

export type CreateReservationInput = {
  guestId: string; roomId: string; stayType?: StayType;
  /** Night stays */
  arrival: DateStr; departure?: DateStr;
  /** Short stays: date = arrival, start time (Lagos HH:MM; "now" for walk-ins) and package hours */
  startTime?: string; hours?: number;
  adults: number; children: number;
  source: BookingSource; paymentPlan: PaymentPlan; specialRequests?: string | null; discountCode?: string | null;
  rateOverride?: string | null; negotiationReason?: string | null; canNegotiate?: boolean;
  confirmImmediately?: boolean; expectedArrival?: string | null; extraGuests?: string[];
};

async function quoteFor(tx: Tx, settings: HotelSettings, input: { stayType: StayType; roomId: string; arrival: DateStr; departure?: DateStr; startTime?: string; hours?: number; discountCode?: string | null; rateOverride?: string | null }): Promise<{ quote: Quote; span: StaySpan }> {
  if (input.stayType === "SHORT") {
    if (!input.startTime || !input.hours) throw new AppError("Choose a start time and a short-stay package.");
    const span = shortSpan(input.arrival, input.startTime, input.hours);
    const { quote } = await quoteShortStay(tx, input.roomId, input.arrival, input.startTime, input.hours, input.discountCode, input.rateOverride);
    return { quote, span };
  }
  if (!input.departure) throw new AppError("Choose a departure date.");
  const span = nightSpan(input.arrival, input.departure, settings);
  const { quote } = await quoteForRoom(tx, input.roomId, input.arrival, input.departure, input.discountCode, input.rateOverride);
  return { quote, span };
}

export async function createReservation(actor: Actor, input: CreateReservationInput) {
  const settings = await getSettings();
  const stayType: StayType = input.stayType ?? "NIGHT";
  const override = checkNegotiation(input, !!input.canNegotiate);
  if (input.adults < 1) throw new AppError("At least one adult is required.");
  if (input.paymentPlan === "PAY_AT_HOTEL" && actor.type === "GUEST" && !settings.reservations.allowPayAtHotel) throw new AppError("Pay-at-hotel is not currently available. Please choose a payment option.");
  if (stayType === "SHORT") {
    if (!settings.shortStay.enabled) throw new AppError("Short stays are not available.");
    if (actor.type === "GUEST" && !settings.shortStay.onlineBooking) throw new AppError("Short stays can only be booked at the front desk.");
    if (input.startTime === "now") input.startTime = lagosHHMM(new Date());
    const today = todayLagos();
    if (input.arrival < today) throw new AppError("The date cannot be in the past.");
    if (input.arrival === today && input.startTime && input.startTime < lagosHHMM(new Date(Date.now() - 30 * 60_000))) throw new AppError("That start time has already passed.");
    if (input.arrival > addDays(today, settings.reservations.maxAdvanceDays)) throw new AppError(`Bookings can be made at most ${settings.reservations.maxAdvanceDays} days in advance.`);
  } else {
    if (!input.departure) throw new AppError("Choose a departure date.");
    validateStayDates(input.arrival, input.departure, { maxNights: settings.reservations.maxNights, maxAdvanceDays: settings.reservations.maxAdvanceDays });
  }

  return prisma.$transaction(async (tx) => {
    const guest = await tx.guest.findUnique({ where: { id: input.guestId } });
    if (!guest || guest.deletedAt) throw new AppError("Guest not found.");
    if (guest.isBlacklisted && actor.type === "GUEST") throw new AppError("We are unable to accept this booking online. Please contact the hotel.");
    const { quote, span } = await quoteFor(tx, settings, { ...input, stayType, rateOverride: override });
    const room = await assertRoomBookable(tx, input.roomId, span, input.adults + input.children, undefined, { shortStay: stayType === "SHORT" });

    const reference = await uniqueBookingRef(tx, settings.reservations.bookingRefPrefix);
    const holdExpiresAt = actor.type === "GUEST" && input.paymentPlan !== "PAY_AT_HOTEL" ? new Date(Math.min(Date.now() + settings.reservations.holdHours * 3600_000, stayType === "SHORT" ? span.startAt.getTime() : Infinity)) : null;
    const status: ReservationStatus = input.confirmImmediately ? "CONFIRMED" : "PENDING";
    const departure = stayType === "SHORT" ? input.arrival : input.departure!;
    const r = await tx.reservation.create({
      data: {
        reference, guestId: guest.id, roomId: room.id, stayType, arrivalDate: toDbDate(input.arrival), departureDate: toDbDate(departure),
        startAt: span.startAt, endAt: span.endAt, shortStayHours: stayType === "SHORT" ? input.hours! : null,
        adults: input.adults, children: input.children, nightlyRate: toDb(quote.rate), standardRate: toDb(quote.standardRate),
        rateNegotiated: !!override, negotiationReason: override ? input.negotiationReason : null,
        status, source: input.source, paymentPlan: input.paymentPlan, specialRequests: input.specialRequests || null,
        discountCode: input.discountCode?.trim().toUpperCase() || null, holdExpiresAt, createdById: actor.type === "STAFF" ? actor.userId : null,
        confirmedAt: status === "CONFIRMED" ? new Date() : null, expectedArrival: input.expectedArrival || (stayType === "SHORT" ? input.startTime : null) || null,
        extraGuests: input.extraGuests?.length ? { create: input.extraGuests.filter(Boolean).map((fullName) => ({ fullName })) } : undefined,
      },
    });
    await postQuote(tx, actor, r.id, room.number, quote, r.discountCode);
    const when = stayLabel(r);
    await logHistory(tx, actor, r.id, "created", { to: status, details: { room: room.number, stayType, when, total: quote.total.toFixed(2), source: input.source, negotiated: override ? { standard: quote.standardRate.toFixed(2), agreed: override, reason: input.negotiationReason } : null } });
    await audit(tx, actor, {
      action: "reservation.create", module: "reservations", recordType: "Reservation", recordId: r.id,
      newValues: { reference, guest: `${guest.firstName} ${guest.lastName}`, room: room.number, stayType, when, adults: input.adults, children: input.children, status, source: input.source, total: quote.total.toFixed(2) },
    });
    if (override) {
      await audit(tx, actor, { action: "pricing.negotiated_rate", module: "reservations", recordType: "Reservation", recordId: r.id, oldValues: { standardRate: quote.standardRate.toFixed(2) }, newValues: { agreedRate: override }, reason: input.negotiationReason });
    }
    await notifyGuest(tx, guest.id, {
      category: "reservation", title: status === "CONFIRMED" ? `Booking ${reference} confirmed` : `Booking ${reference} received`,
      body: `Room ${room.number}, ${when}. Total ${naira(quote.total)}.${holdExpiresAt ? ` Please complete payment by ${fmtDateTime(holdExpiresAt)} to keep this booking.` : ""}`,
      link: `/account/reservations/${reference}`, dedupeKey: `res-created:${r.id}`, sms: true,
    });
    await notifyStaff(tx, ["reservations.view"], {
      category: "reservation", priority: status === "PENDING" ? "HIGH" : "NORMAL",
      title: status === "PENDING" ? `New booking ${reference} needs confirmation` : `New booking ${reference}`,
      body: `${guest.firstName} ${guest.lastName} · Room ${room.number} · ${when} · ${input.source.replace("_", " ").toLowerCase()}`,
      link: `/manage/reservations/${r.id}`, dedupeKey: `res-created:${r.id}`,
    }, { exclude: actor.userId });
    return r;
  }, TX_OPTS);
}

export type ModifyInput = {
  arrival?: DateStr; departure?: DateStr; roomId?: string; adults?: number; children?: number; specialRequests?: string | null;
  rateOverride?: string | null; negotiationReason?: string | null; canNegotiate?: boolean; expectedArrival?: string | null;
  /** Short stays */
  startTime?: string; hours?: number;
  /** Turn a short stay into an overnight stay (departure required). */
  convertToNight?: boolean;
};

/**
 * Change dates/times, room, occupancy or price. Charges are reversed and re-posted so the folio stays
 * immutable and accurate. In-house night stays keep the nights already stayed.
 */
export async function modifyReservation(actor: Actor, reservationId: string, input: ModifyInput, reason: string | null) {
  const settings = await getSettings();
  const override = checkNegotiation(input, !!input.canNegotiate);
  return prisma.$transaction(async (tx) => {
    const r = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId }, include: { room: true, guest: true } });
    if (!["PENDING", "CONFIRMED", "CHECKED_IN"].includes(r.status)) throw new AppError(`A ${r.status.toLowerCase().replace("_", " ")} reservation cannot be modified.`);
    const today = todayLagos();
    const curArrival = fromDbDate(r.arrivalDate), curDeparture = fromDbDate(r.departureDate);
    const roomId = input.roomId ?? r.roomId;
    const adults = input.adults ?? r.adults, children = input.children ?? r.children;
    const inHouse = r.status === "CHECKED_IN";

    if (actor.type === "GUEST") {
      if (inHouse) throw new AppError("Please contact the front desk to change an in-house stay.");
      if (r.stayType === "SHORT") throw new AppError("Please contact the front desk to change a short stay.");
      const hoursToArrival = (r.startAt.getTime() - Date.now()) / 3600_000;
      if (hoursToArrival < settings.policies.guestModificationHours) throw new AppError(`Online changes are allowed up to ${settings.policies.guestModificationHours} hours before arrival. Please contact the hotel.`);
    }

    const before = { stayType: r.stayType, when: stayLabel(r), room: r.room.number, adults: r.adults, children: r.children, specialRequests: r.specialRequests, rate: r.nightlyRate.toFixed(2) };
    const newType: StayType = input.convertToNight ? "NIGHT" : r.stayType;
    let span: StaySpan, quote: Quote | null = null, arrival = input.arrival ?? curArrival, departure = input.departure ?? curDeparture;
    let hours = r.shortStayHours, rate = r.nightlyRate.toFixed(2), standard = r.standardRate?.toFixed(2) ?? rate;
    const keepRate = !override && r.rateNegotiated && roomId === r.roomId ? r.nightlyRate.toFixed(2) : null;

    if (newType === "SHORT") {
      if (inHouse && ((input.startTime && input.startTime !== lagosHHMM(r.startAt)) || (input.arrival && input.arrival !== curArrival))) throw new AppError("The start of an in-house short stay cannot change. Change the package length or convert to an overnight stay.");
      const startTime = input.startTime ?? lagosHHMM(r.startAt);
      hours = input.hours ?? r.shortStayHours!;
      departure = arrival;
      span = inHouse ? { startAt: r.startAt, endAt: new Date(r.startAt.getTime() + hours * 3600_000), fromDate: arrival, toDate: addDays(arrival, 1) } : shortSpan(arrival, startTime, hours);
      const priced = await quoteShortStay(tx, roomId, arrival, startTime, hours, null, override ?? keepRate);
      quote = priced.quote;
    } else {
      if (input.convertToNight) {
        if (!input.departure || input.departure <= arrival) throw new AppError("Choose a departure date after the stay date to convert to an overnight stay.");
      }
      if (inHouse && arrival !== curArrival) throw new AppError("The arrival date of an in-house guest cannot change.");
      if (inHouse && departure <= today && departure !== curDeparture) throw new AppError("To end the stay today, use Check-out.");
      if (!inHouse) validateStayDates(arrival, departure, { maxNights: settings.reservations.maxNights, maxAdvanceDays: settings.reservations.maxAdvanceDays, allowPast: actor.type === "STAFF" && arrival === curArrival });
      else if (!(departure > arrival)) throw new AppError("Departure must be after arrival.");
      const ns = nightSpan(arrival, departure, settings);
      span = inHouse ? { ...ns, startAt: r.startAt < ns.startAt ? r.startAt : ns.startAt } : ns;
      hours = null;
    }
    const newRoom = await assertRoomBookable(tx, roomId, span, adults + children, r.id, { shortStay: newType === "SHORT" });

    const changed = newType !== r.stayType || arrival !== curArrival || departure !== curDeparture || roomId !== r.roomId || hours !== r.shortStayHours
      || span.startAt.getTime() !== r.startAt.getTime() || !!override;
    if (changed) {
      const why = `Stay changed from ${before.when} (Room ${r.room.number})${reason ? `: ${reason}` : ""}`;
      if (newType === "SHORT") {
        await reverseActiveLines(tx, actor, r.id, ["SHORT_STAY", "ROOM", "DISCOUNT"], why);
        await postQuote(tx, actor, r.id, newRoom.number, quote!, null, inHouse ? "updated during stay" : undefined);
        rate = quote!.rate.toFixed(2); standard = quote!.standardRate.toFixed(2);
      } else if (inHouse) {
        // Keep nights already stayed; re-price from tonight. A converted short stay keeps its package charge for the day.
        if (input.convertToNight) await reverseActiveLines(tx, actor, r.id, ["SHORT_STAY", "DISCOUNT"], why);
        else await reverseActiveLines(tx, actor, r.id, ["ROOM"], why, (d) => d >= today);
        const from = input.convertToNight ? arrival : today > arrival ? today : arrival;
        if (from < departure) {
          const { quote: q } = await quoteForRoom(tx, roomId, from, departure, null, override ?? keepRate);
          await postQuote(tx, actor, r.id, newRoom.number, q, null);
          rate = q.rate.toFixed(2); standard = q.standardRate.toFixed(2);
        }
        if (roomId !== r.roomId) {
          await tx.room.update({ where: { id: r.roomId }, data: { housekeepingStatus: "DIRTY" } });
          await tx.housekeepingTask.create({ data: { reference: makeRef("HK", 6), roomId: r.roomId, reservationId: r.id, type: "CHECKOUT_CLEAN", priority: "HIGH", notes: `Guest moved to Room ${newRoom.number}`, createdById: actor.userId } });
        }
      } else {
        await reverseActiveLines(tx, actor, r.id, ["ROOM", "SHORT_STAY", "DISCOUNT"], why);
        const { quote: q } = await quoteForRoom(tx, roomId, arrival, departure, input.convertToNight ? null : r.discountCode, override ?? keepRate);
        await postQuote(tx, actor, r.id, newRoom.number, q, r.discountCode);
        rate = q.rate.toFixed(2); standard = q.standardRate.toFixed(2);
      }
    }
    const updated = await tx.reservation.update({
      where: { id: r.id },
      data: {
        stayType: newType, arrivalDate: toDbDate(arrival), departureDate: toDbDate(departure), startAt: span.startAt, endAt: span.endAt, shortStayHours: hours,
        roomId, adults, children, nightlyRate: rate, standardRate: standard,
        rateNegotiated: override ? true : r.rateNegotiated && roomId === r.roomId, negotiationReason: override ? input.negotiationReason : r.negotiationReason,
        specialRequests: input.specialRequests !== undefined ? input.specialRequests : r.specialRequests,
        expectedArrival: input.expectedArrival !== undefined ? input.expectedArrival : r.expectedArrival,
      },
    });
    const after = { stayType: newType, when: stayLabel(updated), room: newRoom.number, adults, children, specialRequests: updated.specialRequests, rate };
    await logHistory(tx, actor, r.id, input.convertToNight ? "converted_to_overnight" : roomId !== r.roomId ? "room_changed" : "modified", { details: { before, after, reason } });
    await audit(tx, actor, { action: roomId !== r.roomId ? "reservation.room_change" : "reservation.modify", module: "reservations", recordType: "Reservation", recordId: r.id, oldValues: before, newValues: after, reason });
    if (override) await audit(tx, actor, { action: "pricing.negotiated_rate", module: "reservations", recordType: "Reservation", recordId: r.id, oldValues: { standardRate: standard }, newValues: { agreedRate: override }, reason: input.negotiationReason });
    await notifyGuest(tx, r.guestId, { category: "reservation", title: `Booking ${r.reference} updated`, body: `Your stay is now Room ${newRoom.number}, ${after.when}.`, link: `/account/reservations/${r.reference}`, dedupeKey: `res-mod:${r.id}:${Date.now()}` });
    await notifyStaff(tx, ["reservations.view"], { category: "reservation", title: `Booking ${r.reference} modified`, body: `${r.guest.firstName} ${r.guest.lastName}: ${actor.type === "GUEST" ? "guest changed the booking online" : `changed by ${actor.name}`}.`, link: `/manage/reservations/${r.id}` }, { exclude: actor.userId });
    return updated;
  }, TX_OPTS);
}

export async function confirmReservation(actor: Actor, reservationId: string, db?: Tx) {
  const run = async (tx: Tx) => {
    const r = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId }, include: { room: true } });
    if (r.status !== "PENDING") throw new AppError("Only pending reservations can be confirmed.");
    await tx.reservation.update({ where: { id: r.id }, data: { status: "CONFIRMED", confirmedAt: new Date(), holdExpiresAt: null } });
    await logHistory(tx, actor, r.id, "confirmed", { from: "PENDING", to: "CONFIRMED" });
    await audit(tx, actor, { action: "reservation.confirm", module: "reservations", recordType: "Reservation", recordId: r.id, oldValues: { status: "PENDING" }, newValues: { status: "CONFIRMED" } });
    await notifyGuest(tx, r.guestId, { category: "reservation", title: `Booking ${r.reference} confirmed`, body: `Your stay in Room ${r.room.number} (${stayLabel(r)}) is confirmed. We look forward to welcoming you.`, link: `/account/reservations/${r.reference}`, dedupeKey: `res-confirmed:${r.id}`, sms: true });
  };
  return db ? run(db) : prisma.$transaction(run, TX_OPTS);
}

/** Cancel with the hotel's cancellation policy. Late cancellations of night stays post a fee unless waived by staff. */
export async function cancelReservation(actor: Actor, reservationId: string, reason: string, opts: { waiveFee?: boolean; system?: boolean } = {}) {
  if (!reason?.trim()) throw new AppError("Please give a reason for the cancellation.");
  const settings = await getSettings();
  return prisma.$transaction(async (tx) => {
    const r = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId }, include: { room: true, guest: true } });
    if (!["PENDING", "CONFIRMED"].includes(r.status)) throw new AppError(r.status === "CHECKED_IN" ? "The guest is checked in — use check-out instead." : "This reservation can no longer be cancelled.");
    const hoursToArrival = (r.startAt.getTime() - Date.now()) / 3600_000;
    const late = hoursToArrival < settings.policies.freeCancellationHours;
    const feeNights = r.stayType === "SHORT" ? 0 : Math.min(settings.policies.cancellationFeeNights, nightsBetween(fromDbDate(r.arrivalDate), fromDbDate(r.departureDate)));
    const applyFee = late && feeNights > 0 && r.status === "CONFIRMED" && !opts.waiveFee && !opts.system;
    if (opts.waiveFee && actor.type !== "STAFF") throw new AppError("Only staff can waive cancellation fees.");

    await reverseActiveLines(tx, actor, r.id, ["ROOM", "SHORT_STAY", "DISCOUNT"], `Cancelled: ${reason}`);
    let fee = D(0);
    if (applyFee) {
      fee = round2(D(r.nightlyRate).mul(feeNights));
      await postLine(tx, actor, { reservationId: r.id, category: "CANCELLATION_FEE", description: `Late cancellation fee (${feeNights} night${feeNights > 1 ? "s" : ""})`, serviceDate: todayLagos(), unitPrice: fee.toFixed(2), reason: "Cancellation policy" });
    }
    await tx.reservation.update({ where: { id: r.id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason, holdExpiresAt: null } });
    await logHistory(tx, actor, r.id, "cancelled", { from: r.status, to: "CANCELLED", details: { reason, fee: fee.toFixed(2), waived: !!opts.waiveFee && late } });
    await audit(tx, actor, { action: "reservation.cancel", module: "reservations", recordType: "Reservation", recordId: r.id, oldValues: { status: r.status }, newValues: { status: "CANCELLED", fee: fee.toFixed(2), feeWaived: !!opts.waiveFee && late }, reason });
    const folio = await folioSummary(r.id, tx);
    await notifyGuest(tx, r.guestId, {
      category: "reservation", title: `Booking ${r.reference} cancelled`,
      body: `${opts.system ? "Your unpaid booking expired and has been released. " : ""}${fee.gt(0) ? `A late cancellation fee of ${naira(fee)} applies. ` : ""}${folio.balance.lt(0) ? `A refund of ${naira(folio.balance.abs())} will be processed by our finance team.` : ""}`.trim() || "Your booking has been cancelled.",
      link: `/account/reservations/${r.reference}`, dedupeKey: `res-cancel:${r.id}`, sms: true,
    });
    await notifyStaff(tx, ["reservations.view"], { category: "reservation", title: `Booking ${r.reference} cancelled`, body: `${r.guest.firstName} ${r.guest.lastName} · Room ${r.room.number} · ${reason}`, link: `/manage/reservations/${r.id}`, dedupeKey: `res-cancel:${r.id}` }, { exclude: actor.userId });
    if (folio.balance.lt(0)) {
      await notifyStaff(tx, ["refunds.process"], { category: "refund", priority: "HIGH", title: `Refund due on ${r.reference}`, body: `Guest has ${naira(folio.balance.abs())} in credit after cancellation.`, link: `/manage/reservations/${r.id}`, dedupeKey: `refund-due:${r.id}` });
    }
    return { fee };
  }, TX_OPTS);
}

export async function markNoShow(actor: Actor, reservationId: string, reason: string) {
  const settings = await getSettings();
  return prisma.$transaction(async (tx) => {
    const r = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId }, include: { guest: true } });
    if (!["PENDING", "CONFIRMED"].includes(r.status)) throw new AppError("Only pending or confirmed bookings can be marked as no-show.");
    if (fromDbDate(r.arrivalDate) > todayLagos()) throw new AppError("A booking can only be marked as no-show on or after its arrival date.");
    await reverseActiveLines(tx, actor, r.id, ["ROOM", "SHORT_STAY", "DISCOUNT"], "No-show");
    const nights = r.stayType === "SHORT" ? 0 : Math.min(settings.policies.noShowFeeNights, nightsBetween(fromDbDate(r.arrivalDate), fromDbDate(r.departureDate)));
    if (nights > 0 && r.status === "CONFIRMED") {
      await postLine(tx, actor, { reservationId: r.id, category: "NO_SHOW_FEE", description: `No-show fee (${nights} night${nights > 1 ? "s" : ""})`, serviceDate: fromDbDate(r.arrivalDate), unitPrice: round2(D(r.nightlyRate).mul(nights)).toFixed(2), reason: "No-show policy" });
    }
    await tx.reservation.update({ where: { id: r.id }, data: { status: "NO_SHOW", cancelReason: reason } });
    await logHistory(tx, actor, r.id, "no_show", { from: r.status, to: "NO_SHOW", details: { reason } });
    await audit(tx, actor, { action: "reservation.no_show", module: "reservations", recordType: "Reservation", recordId: r.id, oldValues: { status: r.status }, newValues: { status: "NO_SHOW" }, reason });
  }, TX_OPTS);
}

/** Guest-side digital pre-arrival check-in. ID number is encrypted at rest. */
export async function submitPreCheckIn(actor: Actor, reservationId: string, input: { phone: string; address: string; nationality: string; idType: string; idNumber: string; expectedArrival: string; specialRequests?: string; acceptPolicies: boolean; idDocumentPath?: string | null }) {
  if (!input.acceptPolicies) throw new AppError("Please accept the hotel policies to continue.");
  return prisma.$transaction(async (tx) => {
    const r = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    if (r.guestId !== actor.guestId) throw new AppError("Reservation not found.");
    if (!["PENDING", "CONFIRMED"].includes(r.status)) throw new AppError("Pre-arrival check-in is only available for upcoming bookings.");
    await tx.guest.update({
      where: { id: r.guestId },
      data: { phone: input.phone, address: input.address, nationality: input.nationality, idType: input.idType, idNumberEncrypted: encrypt(input.idNumber), ...(input.idDocumentPath ? { idDocumentPath: input.idDocumentPath } : {}) },
    });
    await tx.reservation.update({ where: { id: r.id }, data: { preCheckInAt: new Date(), policiesAccepted: true, expectedArrival: input.expectedArrival, specialRequests: input.specialRequests || r.specialRequests } });
    await logHistory(tx, actor, r.id, "pre_checkin_submitted", { details: { expectedArrival: input.expectedArrival, idType: input.idType } });
    await audit(tx, actor, { action: "reservation.pre_checkin", module: "reservations", recordType: "Reservation", recordId: r.id, newValues: { expectedArrival: input.expectedArrival, idType: input.idType, idDocument: !!input.idDocumentPath } });
    await notifyStaff(tx, ["frontdesk.checkin"], { category: "checkin", title: `Pre-arrival check-in: ${r.reference}`, body: `Guest completed digital check-in. Expected arrival ${input.expectedArrival}.`, link: `/manage/reservations/${r.id}`, dedupeKey: `precheckin:${r.id}` });
  }, TX_OPTS);
}

export async function checkIn(actor: Actor, reservationId: string, input: { idType?: string; idNumber?: string; notes?: string; allowUnpaid?: boolean }) {
  const settings = await getSettings();
  return prisma.$transaction(async (tx) => {
    const r = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId }, include: { room: true, guest: true } });
    const today = todayLagos();
    if (!["PENDING", "CONFIRMED"].includes(r.status)) throw new AppError(`Cannot check in a ${r.status.toLowerCase().replace("_", " ")} reservation.`);
    if (fromDbDate(r.arrivalDate) > today) throw new AppError(`This booking starts on ${fmtDate(r.arrivalDate)}. Change the date to check in early.`);
    if (r.stayType === "NIGHT" && fromDbDate(r.departureDate) <= today) throw new AppError("The departure date has passed. Update the dates before checking in.");
    if (r.guest.isBlacklisted) throw new AppError("This guest is flagged. A manager must review before check-in.");
    await tx.$queryRaw`SELECT "id" FROM "Room" WHERE "id" = ${r.roomId} FOR UPDATE`;
    const room = await tx.room.findUniqueOrThrow({ where: { id: r.roomId } });
    if (!room.isActive) throw new AppError(`Room ${room.number} is inactive. Move the guest to another room.`);
    const block = await tx.roomBlock.findFirst({ where: { roomId: room.id, releasedAt: null, startDate: { lte: toDbDate(today) }, OR: [{ endDate: null }, { endDate: { gt: toDbDate(today) } }] } });
    if (block) throw new AppError(`Room ${room.number} is blocked (${block.reason}). Move the guest to another room.`);
    const occupied = await tx.reservation.findFirst({ where: { roomId: room.id, status: "CHECKED_IN", id: { not: r.id } } });
    if (occupied) throw new AppError(`Room ${room.number} is still occupied by booking ${occupied.reference}.`);
    if (settings.reservations.requireInspectionBeforeCheckIn && room.housekeepingStatus !== "INSPECTED") {
      throw new AppError(`Room ${room.number} is ${room.housekeepingStatus.toLowerCase()} and has not passed inspection. Housekeeping must inspect it first, or move the guest.`);
    }
    const hasId = !!(input.idNumber || r.guest.idNumberEncrypted);
    if (!hasId) throw new AppError("Record the guest's identification before check-in.");
    const folio = await folioSummary(r.id, tx);
    const depositDue = r.stayType === "SHORT" ? folio.total : round2(folio.total.mul(D(settings.finance.depositPercent)).div(100));
    if (r.paymentPlan !== "PAY_AT_HOTEL" && folio.netPaid.lt(depositDue) && !input.allowUnpaid) {
      throw new AppError(r.stayType === "SHORT"
        ? `Short stays are paid in full at check-in: ${naira(folio.balance)} outstanding. Record the payment first.`
        : `A deposit of ${naira(depositDue)} is required (received ${naira(folio.netPaid)}). Record a payment first, or tick "check in without deposit" if a manager approved it.`);
    }
    // A short stay's clock starts at check-in; the database refuses it if that would run into the next booking.
    let timing = {};
    if (r.stayType === "SHORT") {
      const startAt = new Date();
      timing = { startAt, endAt: new Date(startAt.getTime() + r.shortStayHours! * 3600_000) };
    }
    if (input.idNumber) await tx.guest.update({ where: { id: r.guestId }, data: { idType: input.idType || r.guest.idType, idNumberEncrypted: encrypt(input.idNumber) } });
    const updated = await tx.reservation.update({ where: { id: r.id }, data: { status: "CHECKED_IN", checkedInAt: new Date(), checkedInById: actor.userId, idVerifiedAt: new Date(), idVerifiedById: actor.userId, confirmedAt: r.confirmedAt ?? new Date(), holdExpiresAt: null, ...timing } });
    await logHistory(tx, actor, r.id, "checked_in", { from: r.status, to: "CHECKED_IN", details: { room: room.number, notes: input.notes, until: fmtDateTime(updated.endAt), withoutDeposit: !!input.allowUnpaid && folio.netPaid.lt(depositDue) } });
    await audit(tx, actor, { action: "frontdesk.checkin", module: "frontdesk", recordType: "Reservation", recordId: r.id, oldValues: { status: r.status }, newValues: { status: "CHECKED_IN", room: room.number, idRecorded: !!input.idNumber, withoutDeposit: !!input.allowUnpaid && folio.netPaid.lt(depositDue) }, reason: input.notes || null });
    const until = r.stayType === "SHORT" ? `today at ${fmtTime(updated.endAt)}` : `${fmtDate(r.departureDate)} by ${settings.policies.checkOutTime}`;
    await notifyGuest(tx, r.guestId, { category: "checkin", title: `Welcome to ${settings.hotel.name}`, body: `You are checked in to Room ${room.number}. Check-out is ${until}. Use the app for room service, housekeeping and messages.`, link: `/account/reservations/${r.reference}`, dedupeKey: `checkin:${r.id}` });
    await notifyStaff(tx, ["housekeeping.view", "services.view"], { category: "checkin", title: `Checked in: Room ${room.number}`, body: `${r.guest.firstName} ${r.guest.lastName} (${r.reference}) until ${until}.`, link: `/manage/reservations/${r.id}`, dedupeKey: `checkin:${r.id}` }, { exclude: actor.userId });
  }, TX_OPTS);
}

/** What check-out will do to a short stay that ran over its package (shown to staff before they confirm). */
export async function shortStayOvertime(reservationId: string, at: Date = new Date()) {
  const r = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId }, include: { room: true } });
  if (r.stayType !== "SHORT" || r.status !== "CHECKED_IN" || !r.checkedInAt) return null;
  const s = await getSettings();
  const minutesUsed = Math.ceil((at.getTime() - r.checkedInAt.getTime()) / 60_000);
  const outcome = overtimeOutcome(s.shortStay.tiers, r.shortStayHours!, minutesUsed, s.shortStay.graceMinutes);
  let newPrice: Decimal | null = null;
  if (outcome.kind === "UPGRADE") newPrice = shortStayPrice(s.shortStay.tiers, outcome.hours, lagosHHMM(r.checkedInAt), s.shortStay.eveningFrom).price;
  if (outcome.kind === "OVERNIGHT") newPrice = round2(r.room.nightlyRate);
  return { minutesUsed, outcome, newPrice, bookedHours: r.shortStayHours };
}


/**
 * Short-stay overtime: re-price the stay to the package that covers the time actually used, or to the overnight
 * rate beyond the longest package. Posted immediately (and again if the guest stays even longer) so the front desk
 * can collect the right amount before check-out. Safe to call repeatedly.
 */
export async function applyShortStayOvertime(actor: Actor, reservationId: string) {
  const settings = await getSettings();
  return prisma.$transaction(async (tx) => {
    const r = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId }, include: { room: true } });
    if (r.stayType !== "SHORT" || r.status !== "CHECKED_IN" || !r.checkedInAt) return null;
    const convertedToNight = await tx.folioCharge.count({ where: { reservationId: r.id, category: "ROOM", reversalOfId: null, reversedBy: null } });
    if (convertedToNight) return null;
    const minutesUsed = Math.ceil((Date.now() - r.checkedInAt.getTime()) / 60_000);
    const outcome = overtimeOutcome(settings.shortStay.tiers, r.shortStayHours!, minutesUsed, settings.shortStay.graceMinutes);
    if (outcome.kind === "WITHIN") return null;
    const why = `Overtime: ${Math.floor(minutesUsed / 60)}h ${minutesUsed % 60}m used of ${r.shortStayHours}h`;
    await reverseActiveLines(tx, actor, r.id, ["SHORT_STAY", "DISCOUNT"], why);
    if (outcome.kind === "UPGRADE") {
      const { price, tier } = shortStayPrice(settings.shortStay.tiers, outcome.hours, lagosHHMM(r.checkedInAt), settings.shortStay.eveningFrom);
      const line = priceLine(price, settings.finance.taxRate, settings.finance.serviceChargeRate, settings.finance.taxInclusive !== false);
      await postLine(tx, actor, { reservationId: r.id, category: "SHORT_STAY", description: `Room ${r.room.number} — short stay, ${tier.label} (overtime from ${r.shortStayHours} hours)`, serviceDate: fromDbDate(r.arrivalDate), unitPrice: line.amount.toFixed(2), tax: line.tax.toFixed(2), serviceCharge: line.serviceCharge.toFixed(2), reason: why });
      await tx.reservation.update({ where: { id: r.id }, data: { shortStayHours: outcome.hours, nightlyRate: toDb(price), standardRate: toDb(price) } });
    } else {
      const line = priceLine(r.room.nightlyRate.toString(), settings.finance.taxRate, settings.finance.serviceChargeRate, settings.finance.taxInclusive !== false);
      await postLine(tx, actor, { reservationId: r.id, category: "ROOM", description: `Room ${r.room.number} — overnight rate (short stay exceeded ${settings.shortStay.tiers.reduce((m, t) => Math.max(m, t.hours), 0)} hours)`, serviceDate: fromDbDate(r.arrivalDate), unitPrice: line.amount.toFixed(2), tax: line.tax.toFixed(2), serviceCharge: line.serviceCharge.toFixed(2), reason: why });
      await tx.reservation.update({ where: { id: r.id }, data: { nightlyRate: r.room.nightlyRate, standardRate: r.room.nightlyRate } });
    }
    await logHistory(tx, actor, r.id, "overtime_charged", { details: { minutesUsed, outcome } });
    await audit(tx, actor, { action: "reservation.overtime", module: "frontdesk", recordType: "Reservation", recordId: r.id, oldValues: { hours: r.shortStayHours }, newValues: { outcome, minutesUsed } });
    return { minutesUsed, outcome };
  }, TX_OPTS);
}

/**
 * Check-out: early departures are re-priced, short-stay overtime moves the bill to the next package (or a night),
 * the final invoice is issued, the room goes to DIRTY and a housekeeping task is created. The room is not
 * available for the next check-in until it is cleaned and inspected.
 */
export async function checkOut(actor: Actor, reservationId: string, opts: { allowBalance?: boolean; reason?: string | null } = {}) {
  const today = todayLagos();
  const settings = await getSettings();
  await applyShortStayOvertime(actor, reservationId);
  return prisma.$transaction(async (tx) => {
    const r = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId }, include: { room: true, guest: true } });
    if (r.status !== "CHECKED_IN") throw new AppError("Only checked-in guests can be checked out.");
    const now = new Date();
    if (r.stayType === "SHORT") {
      await tx.reservation.update({ where: { id: r.id }, data: { endAt: now > r.startAt ? now : new Date(r.startAt.getTime() + 60_000) } });
    } else {
      const departure = fromDbDate(r.departureDate);
      if (departure > today) {
        const newDeparture = today > fromDbDate(r.arrivalDate) ? today : addDays(fromDbDate(r.arrivalDate), 1);
        await reverseActiveLines(tx, actor, r.id, ["ROOM", "DISCOUNT"], `Early departure on ${today}`, (d) => d >= newDeparture);
        await tx.reservation.update({ where: { id: r.id }, data: { departureDate: toDbDate(newDeparture), endAt: now > r.startAt ? now : r.endAt } });
        await logHistory(tx, actor, r.id, "early_departure", { details: { originalDeparture: departure, newDeparture } });
      }
    }
    const folio = await folioSummary(r.id, tx);
    if (folio.balance.gt(0) && !opts.allowBalance) throw new AppError(`Outstanding balance of ${naira(folio.balance)}. Record payment before check-out.`);
    if (folio.balance.gt(0) && !opts.reason?.trim()) throw new AppError("A reason is required to check out with an outstanding balance.");

    await tx.reservation.update({ where: { id: r.id }, data: { status: "CHECKED_OUT", checkedOutAt: now, checkedOutById: actor.userId } });
    await tx.room.update({ where: { id: r.roomId }, data: { housekeepingStatus: "DIRTY" } });
    const task = await tx.housekeepingTask.create({
      data: { reference: makeRef("HK", 6), roomId: r.roomId, reservationId: r.id, type: "CHECKOUT_CLEAN", priority: "HIGH", createdById: actor.userId, dueAt: new Date(Date.now() + settings.reservations.housekeepingOverdueHours * 3600_000), notes: `Check-out of ${r.reference}` },
    });
    const invoice = await issueInvoice(tx, actor, r.id, { final: true });
    await logHistory(tx, actor, r.id, "checked_out", { from: "CHECKED_IN", to: "CHECKED_OUT", details: { balance: folio.balance.toFixed(2), invoice: invoice.number } });
    await audit(tx, actor, { action: "frontdesk.checkout", module: "frontdesk", recordType: "Reservation", recordId: r.id, oldValues: { status: "CHECKED_IN" }, newValues: { status: "CHECKED_OUT", balance: folio.balance.toFixed(2), invoice: invoice.number, housekeepingTask: task.reference }, reason: opts.reason ?? null });
    await audit(tx, actor, { action: "room.status_change", module: "rooms", recordType: "Room", recordId: r.roomId, oldValues: { housekeepingStatus: r.room.housekeepingStatus }, newValues: { housekeepingStatus: "DIRTY" }, reason: "Check-out" });
    await notifyGuest(tx, r.guestId, { category: "checkout", title: "Thank you for staying with us", body: `You have checked out of Room ${r.room.number}. Your final invoice ${invoice.number} is available in your account. We would love your feedback.`, link: `/account/reservations/${r.reference}`, dedupeKey: `checkout:${r.id}` });
    await notifyStaff(tx, ["housekeeping.manage"], { category: "housekeeping", priority: "HIGH", title: `Room ${r.room.number} needs cleaning`, body: `Check-out completed for ${r.reference}. Task ${task.reference} created.`, link: `/manage/housekeeping`, dedupeKey: `hk-task:${task.id}` });
    await notifyStaff(tx, ["reservations.view"], { category: "checkout", title: `Checked out: Room ${r.room.number}`, body: `${r.guest.firstName} ${r.guest.lastName} (${r.reference}).`, link: `/manage/reservations/${r.id}`, dedupeKey: `checkout:${r.id}` }, { exclude: actor.userId });
    if (folio.balance.gt(0)) {
      await notifyStaff(tx, ["payments.verify", "refunds.process"], { category: "billing", priority: "HIGH", title: `Checked out with balance: ${r.reference}`, body: `${naira(folio.balance)} outstanding. Reason: ${opts.reason}`, link: `/manage/reservations/${r.id}`, dedupeKey: `checkout-balance:${r.id}` });
    }
    return { invoice, task };
  }, TX_OPTS);
}

export async function requestExpressCheckout(actor: Actor, reservationId: string) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId }, include: { room: true } });
    if (r.guestId !== actor.guestId) throw new AppError("Reservation not found.");
    if (r.status !== "CHECKED_IN") throw new AppError("Express checkout is available during your stay.");
    if (r.checkoutRequestedAt) throw new AppError("You have already requested express checkout.");
    await tx.reservation.update({ where: { id: r.id }, data: { checkoutRequestedAt: new Date() } });
    await logHistory(tx, actor, r.id, "express_checkout_requested");
    await audit(tx, actor, { action: "reservation.express_checkout_request", module: "frontdesk", recordType: "Reservation", recordId: r.id });
    await notifyStaff(tx, ["frontdesk.checkout"], { category: "checkout", priority: "HIGH", title: `Express checkout requested — Room ${r.room.number}`, body: `Guest on ${r.reference} has confirmed their bill and requested express checkout.`, link: `/manage/front-desk/check-out?id=${r.id}`, dedupeKey: `express:${r.id}` });
  });
}

export const STATUS_LABEL: Record<ReservationStatus, string> = {
  PENDING: "Pending", CONFIRMED: "Confirmed", CHECKED_IN: "Checked In", CHECKED_OUT: "Checked Out", CANCELLED: "Cancelled", NO_SHOW: "No Show",
};
