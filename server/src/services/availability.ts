import { prisma, type Tx } from "../lib/db";
import { addDays, toDbDate, todayLagos, type DateStr } from "../lib/dates";
import type { HotelSettings } from "../lib/settings";
import { AppError } from "../lib/errors";
import { getSettings } from "../lib/settings";

/** Reservation statuses that hold a room. */
export const ACTIVE_STATUSES = ["PENDING", "CONFIRMED", "CHECKED_IN"] as const;

export type OperationalStatus = "AVAILABLE" | "RESERVED" | "OCCUPIED" | "DIRTY" | "CLEANING" | "CLEAN" | "INSPECTED" | "MAINTENANCE" | "OUT_OF_ORDER";

export const OPERATIONAL_LABEL: Record<OperationalStatus, string> = {
  AVAILABLE: "Available", RESERVED: "Reserved", OCCUPIED: "Occupied", DIRTY: "Dirty", CLEANING: "Cleaning", CLEAN: "Clean – awaiting inspection",
  INSPECTED: "Inspected", MAINTENANCE: "Maintenance", OUT_OF_ORDER: "Out of Order",
};

/**
 * Current operational status, derived from real records rather than a manually-set flag:
 * blocks > in-house guest > housekeeping state > arrival today > available.
 */
export function deriveOperationalStatus(r: {
  isActive: boolean; housekeepingStatus: string; activeBlockType: "MAINTENANCE" | "OUT_OF_ORDER" | null; occupied: boolean; arrivingToday: boolean;
}): OperationalStatus {
  if (r.activeBlockType === "OUT_OF_ORDER" || !r.isActive) return "OUT_OF_ORDER";
  if (r.activeBlockType === "MAINTENANCE") return "MAINTENANCE";
  if (r.occupied) return "OCCUPIED";
  if (r.housekeepingStatus === "DIRTY") return "DIRTY";
  if (r.housekeepingStatus === "CLEANING") return "CLEANING";
  if (r.arrivingToday) return "RESERVED";
  if (r.housekeepingStatus === "CLEAN") return "CLEAN";
  return "AVAILABLE";
}

export function validateStayDates(arrival: DateStr, departure: DateStr, opts: { maxNights: number; maxAdvanceDays: number; allowPast?: boolean }) {
  const today = todayLagos();
  if (!(departure > arrival)) throw new AppError("Departure date must be after the arrival date.");
  if (!opts.allowPast && arrival < today) throw new AppError("Arrival date cannot be in the past.");
  if (arrival > addDays(today, opts.maxAdvanceDays)) throw new AppError(`Bookings can be made at most ${opts.maxAdvanceDays} days in advance.`);
  const nights = Math.round((toDbDate(departure).getTime() - toDbDate(arrival).getTime()) / 86_400_000);
  if (nights > opts.maxNights) throw new AppError(`Stays are limited to ${opts.maxNights} nights. Please contact the hotel for longer stays.`);
}

/** A Lagos wall-clock time on a date as a UTC instant (Lagos is UTC+1 all year). */
export function lagosTime(date: DateStr, time: string): Date {
  if (!/^\d{2}:\d{2}$/.test(time)) throw new AppError("Enter a valid time (HH:MM).");
  return new Date(`${date}T${time}:00+01:00`);
}

export type StaySpan = { startAt: Date; endAt: Date; fromDate: DateStr; toDate: DateStr };

/** Night stay occupies the room from check-in time on arrival to check-out time on departure. */
export function nightSpan(arrival: DateStr, departure: DateStr, s: HotelSettings): StaySpan {
  return { startAt: lagosTime(arrival, s.policies.checkInTime), endAt: lagosTime(departure, s.policies.checkOutTime), fromDate: arrival, toDate: departure };
}

/** Short stay occupies the room for exactly the package length. */
export function shortSpan(date: DateStr, startTime: string, hours: number): StaySpan {
  const startAt = lagosTime(date, startTime);
  return { startAt, endAt: new Date(startAt.getTime() + hours * 3600_000), fromDate: date, toDate: addDays(date, 1) };
}

export function spanFromInstants(startAt: Date, endAt: Date): StaySpan {
  const lagosDate = (d: Date) => new Date(d.getTime() + 3600_000).toISOString().slice(0, 10);
  return { startAt, endAt, fromDate: lagosDate(startAt), toDate: addDays(lagosDate(new Date(endAt.getTime() - 1)), 1) };
}

function overlapWhere(span: StaySpan) {
  return { status: { in: [...ACTIVE_STATUSES] }, startAt: { lt: span.endAt }, endAt: { gt: span.startAt } };
}

/** Active (unreleased) blocks overlapping [from, to). */
export function blockOverlapWhere(from: DateStr, to: DateStr) {
  return {
    releasedAt: null,
    startDate: { lt: toDbDate(to) },
    OR: [{ endDate: null }, { endDate: { gt: toDbDate(from) } }],
  };
}

/** Rooms free for the whole time span, considering every active booking (night or short stay) and room blocks. */
export async function findAvailableRooms(span: StaySpan, opts: { guests?: number; excludeReservationId?: string; shortStayOnly?: boolean } = {}, db: Tx = prisma) {
  return db.room.findMany({
    where: {
      isActive: true,
      maxOccupancy: { gte: opts.guests ?? 1 },
      ...(opts.shortStayOnly ? { allowShortStay: true } : {}),
      reservations: { none: { ...overlapWhere(span), ...(opts.excludeReservationId ? { id: { not: opts.excludeReservationId } } : {}) } },
      blocks: { none: blockOverlapWhere(span.fromDate, span.toDate) },
    },
    include: { roomType: true, images: { orderBy: { sortOrder: "asc" } }, amenities: { include: { amenity: true } } },
    orderBy: [{ sortOrder: "asc" }, { number: "asc" }],
  });
}

/**
 * Authoritative check inside a booking transaction. Locks the room row so concurrent bookings for the
 * same room serialize; the database exclusion constraint is the final guard against overlaps.
 */
export async function assertRoomBookable(tx: Tx, roomId: string, span: StaySpan, guests: number, excludeReservationId?: string, opts: { shortStay?: boolean } = {}) {
  await tx.$queryRaw`SELECT "id" FROM "Room" WHERE "id" = ${roomId} FOR UPDATE`;
  const room = await tx.room.findUnique({ where: { id: roomId } });
  if (!room) throw new AppError("Room not found.");
  if (!room.isActive) throw new AppError(`Room ${room.number} is not available for booking.`);
  if (opts.shortStay && !room.allowShortStay) throw new AppError(`Room ${room.number} is not offered for short stays.`);
  if (guests > room.maxOccupancy) throw new AppError(`Room ${room.number} accommodates at most ${room.maxOccupancy} guests.`);
  const block = await tx.roomBlock.findFirst({ where: { roomId, ...blockOverlapWhere(span.fromDate, span.toDate) } });
  if (block) throw new AppError(`Room ${room.number} is blocked (${block.type === "OUT_OF_ORDER" ? "out of order" : "maintenance"}) for that time.`);
  const clash = await tx.reservation.findFirst({ where: { roomId, ...overlapWhere(span), ...(excludeReservationId ? { id: { not: excludeReservationId } } : {}) } });
  if (clash) throw new AppError(`Room ${room.number} is already booked for part of that time (${clash.reference}).`);
  return room;
}

/** Live room board: every room with its derived operational status for today. */
export async function roomBoard(db: Tx = prisma) {
  const today = todayLagos();
  const tomorrow = addDays(today, 1);
  const rooms = await db.room.findMany({
    include: {
      roomType: true,
      blocks: { where: blockOverlapWhere(today, tomorrow) },
      reservations: {
        where: { OR: [{ status: "CHECKED_IN" }, { status: { in: ["PENDING", "CONFIRMED"] }, arrivalDate: toDbDate(today) }] },
        include: { guest: true },
      },
    },
    orderBy: [{ sortOrder: "asc" }, { number: "asc" }],
  });
  return rooms.map((r) => {
    const inHouse = r.reservations.find((x) => x.status === "CHECKED_IN") ?? null;
    const arriving = r.reservations.find((x) => x.status !== "CHECKED_IN") ?? null;
    const block = r.blocks.find((b) => b.type === "OUT_OF_ORDER") ?? r.blocks[0] ?? null;
    const status = deriveOperationalStatus({ isActive: r.isActive, housekeepingStatus: r.housekeepingStatus, activeBlockType: block?.type ?? null, occupied: !!inHouse, arrivingToday: !!arriving });
    return { room: r, status, inHouse, arriving, block };
  });
}

export async function bookingRules(db: Tx = prisma) {
  const s = await getSettings(db);
  return { maxNights: s.reservations.maxNights, maxAdvanceDays: s.reservations.maxAdvanceDays };
}
