import { prisma } from "../lib/db";
import { addDays, lagosDayStart, nightsBetween, toDbDate, todayLagos, type DateStr } from "../lib/dates";
import { D, sum, type Decimal } from "../lib/money";
import { balancesFor } from "./folio";
import { roomBoard } from "./availability";

export type Range = { from: DateStr; to: DateStr }; // inclusive

const EARNED_STATUSES = ["CHECKED_IN", "CHECKED_OUT"];
const FEE_CATEGORIES = ["CANCELLATION_FEE", "NO_SHOW_FEE"];

/**
 * Financial report. Definitions (kept deliberately separate, never added together):
 *  - Revenue earned: folio charges (net of reversals/discounts, excluding tax) for nights/services that
 *    actually took place in the period (in-house or departed stays), plus cancellation / no-show fees.
 *  - Payments received: verified money in, by the date it was received.
 *  - Refunds: processed refunds in the period.
 *  - Expenses: non-voided expenses in the period.
 *  - Outstanding: current folio balances (charges − net payments) on live and departed stays.
 */
export async function financialReport(range: Range) {
  const from = toDbDate(range.from), to = toDbDate(range.to);
  const today = todayLagos();
  const earnedTo = toDbDate(range.to < today ? range.to : today);
  const days = nightsBetween(range.from, addDays(range.to, 1));

  const [byCategory, roomNights, byRoom, daily, payments, refunds, expenses, activeRooms] = await Promise.all([
    prisma.$queryRaw<{ category: string; amount: string; tax: string; sc: string }[]>`
      SELECT fc."category"::text AS category, SUM(fc."amount")::text AS amount, SUM(fc."tax")::text AS tax, SUM(fc."serviceCharge")::text AS sc
      FROM "FolioCharge" fc JOIN "Reservation" r ON r."id" = fc."reservationId"
      WHERE fc."serviceDate" BETWEEN ${from} AND ${earnedTo}
        AND (r."status"::text = ANY(${EARNED_STATUSES}) OR fc."category"::text = ANY(${FEE_CATEGORIES}))
      GROUP BY fc."category"`,
    prisma.$queryRaw<{ nights: bigint }[]>`
      SELECT COUNT(*) AS nights FROM "FolioCharge" fc JOIN "Reservation" r ON r."id" = fc."reservationId"
      WHERE fc."category" = 'ROOM' AND fc."reversalOfId" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "FolioCharge" x WHERE x."reversalOfId" = fc."id")
        AND fc."serviceDate" BETWEEN ${from} AND ${earnedTo} AND r."status"::text = ANY(${EARNED_STATUSES})`,
    prisma.$queryRaw<{ number: string; amount: string; nights: bigint }[]>`
      SELECT rm."number", COALESCE(SUM(fc."amount"),0)::text AS amount,
        COUNT(*) FILTER (WHERE fc."category" = 'ROOM' AND fc."reversalOfId" IS NULL AND NOT EXISTS (SELECT 1 FROM "FolioCharge" x WHERE x."reversalOfId" = fc."id")) AS nights
      FROM "FolioCharge" fc JOIN "Reservation" r ON r."id" = fc."reservationId" JOIN "Room" rm ON rm."id" = r."roomId"
      WHERE fc."serviceDate" BETWEEN ${from} AND ${earnedTo}
        AND (r."status"::text = ANY(${EARNED_STATUSES}) OR fc."category"::text = ANY(${FEE_CATEGORIES}))
      GROUP BY rm."number" ORDER BY rm."number"`,
    prisma.$queryRaw<{ day: Date; amount: string }[]>`
      SELECT fc."serviceDate" AS day, SUM(fc."amount")::text AS amount
      FROM "FolioCharge" fc JOIN "Reservation" r ON r."id" = fc."reservationId"
      WHERE fc."serviceDate" BETWEEN ${from} AND ${earnedTo}
        AND (r."status"::text = ANY(${EARNED_STATUSES}) OR fc."category"::text = ANY(${FEE_CATEGORIES}))
      GROUP BY fc."serviceDate" ORDER BY fc."serviceDate"`,
    prisma.payment.findMany({ where: { status: "VERIFIED", receivedAt: { gte: lagosDayStart(range.from), lt: lagosDayStart(addDays(range.to, 1)) } }, select: { amount: true, method: true, isDeposit: true, receivedAt: true } }),
    prisma.refund.findMany({ where: { status: "PROCESSED", processedAt: { gte: lagosDayStart(range.from), lt: lagosDayStart(addDays(range.to, 1)) } }, select: { amount: true, method: true } }),
    prisma.expense.findMany({ where: { voidedAt: null, expenseDate: { gte: from, lte: to } }, select: { amount: true, category: true } }),
    prisma.room.count({ where: { isActive: true } }),
  ]);

  const cat = new Map(byCategory.map((c) => [c.category, c]));
  const shortCount = await prisma.reservation.count({ where: { stayType: "SHORT", status: { in: ["CHECKED_IN", "CHECKED_OUT"] }, arrivalDate: { gte: from, lte: earnedTo } } });
  const revenue = sum(byCategory.map((c) => c.amount));
  const taxCollected = sum(byCategory.map((c) => c.tax));
  const serviceCharges = sum(byCategory.map((c) => c.sc));
  const nightRevenue = D(cat.get("ROOM")?.amount);
  const shortStayRevenue = D(cat.get("SHORT_STAY")?.amount);
  const roomRevenue = nightRevenue.plus(shortStayRevenue).plus(D(cat.get("DISCOUNT")?.amount));
  const soldNights = Number(roomNights[0]?.nights ?? 0);
  const earnedDays = range.from > today ? 0 : nightsBetween(range.from, addDays(range.to < today ? range.to : today, 1));
  const availableNights = activeRooms * earnedDays;

  const group = <T,>(rows: T[], key: (r: T) => string, val: (r: T) => Decimal.Value) => {
    const m = new Map<string, Decimal>();
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? D(0)).plus(D(val(r))));
    return [...m.entries()].map(([k, v]) => ({ key: k, amount: v })).sort((a, b) => b.amount.cmp(a.amount));
  };
  const paymentsTotal = sum(payments.map((p) => p.amount.toString()));
  const refundsTotal = sum(refunds.map((r) => r.amount.toString()));
  const expensesTotal = sum(expenses.map((e) => e.amount.toString()));

  return {
    range, days,
    revenue, roomRevenue, otherRevenue: revenue.minus(roomRevenue), taxCollected, serviceCharges,
    revenueByCategory: byCategory.map((c) => ({ key: c.category, amount: D(c.amount) })).sort((a, b) => b.amount.cmp(a.amount)),
    revenueByRoom: byRoom.map((r) => ({ key: r.number, amount: D(r.amount), nights: Number(r.nights) })),
    dailyRevenue: daily.map((d) => ({ day: d.day.toISOString().slice(0, 10), amount: D(d.amount) })),
    soldNights, availableNights,
    occupancy: availableNights ? (soldNights / availableNights) * 100 : 0,
    // ADR is per room-night sold (night stays); RevPAR includes short-stay income earned from the same rooms.
    adr: soldNights ? nightRevenue.div(soldNights) : D(0),
    revpar: availableNights ? roomRevenue.div(availableNights) : D(0),
    nightRevenue, shortStayRevenue, shortStays: shortCount,
    paymentsTotal, paymentsByMethod: group(payments, (p) => p.method, (p) => p.amount.toString()),
    depositsTotal: sum(payments.filter((p) => p.isDeposit).map((p) => p.amount.toString())),
    refundsTotal, netCash: paymentsTotal.minus(refundsTotal),
    expensesTotal, expensesByCategory: group(expenses, (e) => e.category, (e) => e.amount.toString()),
    netOperating: revenue.minus(expensesTotal),
  };
}

export async function outstandingBalances() {
  const res = await prisma.reservation.findMany({
    where: { status: { in: ["PENDING", "CONFIRMED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED", "NO_SHOW"] } },
    select: { id: true, reference: true, status: true, arrivalDate: true, departureDate: true, guest: { select: { firstName: true, lastName: true, phone: true } }, room: { select: { number: true } } },
    orderBy: { arrivalDate: "desc" }, take: 2000,
  });
  const bal = await balancesFor(res.map((r) => r.id));
  return res
    .map((r) => ({ ...r, ...bal.get(r.id)! }))
    .filter((r) => !r.balance.isZero() && (r.balance.gt(0) ? ["CHECKED_IN", "CHECKED_OUT", "CONFIRMED", "PENDING", "NO_SHOW", "CANCELLED"].includes(r.status) : true));
}

export async function bookingReport(range: Range) {
  const from = lagosDayStart(range.from), to = lagosDayStart(addDays(range.to, 1));
  const [created, cancelled, noShows, bySource, newGuests, repeat] = await Promise.all([
    prisma.reservation.count({ where: { createdAt: { gte: from, lt: to } } }),
    prisma.reservation.count({ where: { status: "CANCELLED", cancelledAt: { gte: from, lt: to } } }),
    prisma.reservation.count({ where: { status: "NO_SHOW", arrivalDate: { gte: toDbDate(range.from), lte: toDbDate(range.to) } } }),
    prisma.reservation.groupBy({ by: ["source"], where: { createdAt: { gte: from, lt: to } }, _count: true }),
    prisma.guest.count({ where: { createdAt: { gte: from, lt: to }, deletedAt: null } }),
    prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM (SELECT "guestId" FROM "Reservation" WHERE "status" IN ('CHECKED_OUT','CHECKED_IN') GROUP BY "guestId" HAVING COUNT(*) > 1) t`,
  ]);
  const stays = await prisma.reservation.findMany({ where: { status: { in: ["CHECKED_IN", "CHECKED_OUT"] }, arrivalDate: { lte: toDbDate(range.to) }, departureDate: { gte: toDbDate(range.from) } }, select: { adults: true, children: true, arrivalDate: true, departureDate: true, guestId: true, stayType: true } });
  const nightStays = stays.filter((s) => s.stayType === "NIGHT");
  return {
    created, cancelled, noShows, cancellationRate: created ? (cancelled / created) * 100 : 0,
    bySource: bySource.map((s) => ({ key: s.source, count: s._count })).sort((a, b) => b.count - a.count),
    newGuests, repeatGuests: Number(repeat[0]?.n ?? 0), staysInPeriod: stays.length, uniqueGuests: new Set(stays.map((s) => s.guestId)).size,
    guestsServed: stays.reduce((a, s) => a + s.adults + s.children, 0),
    shortStaysInPeriod: stays.length - nightStays.length,
    avgLengthOfStay: nightStays.length ? nightStays.reduce((a, s) => a + nightsBetween(s.arrivalDate.toISOString().slice(0, 10), s.departureDate.toISOString().slice(0, 10)), 0) / nightStays.length : 0,
  };
}

/** Live dashboard metrics — all from real records. */
export async function dashboardStats() {
  const today = todayLagos();
  const monthStart = today.slice(0, 8) + "01";
  const [board, arrivals, departures, pendingRes, pendingPayments, hkPending, mtPending, unreadMsgs, srOpen, todayFin, monthFin, inHouseRes] = await Promise.all([
    roomBoard(),
    prisma.reservation.findMany({ where: { arrivalDate: toDbDate(today), status: { in: ["PENDING", "CONFIRMED", "CHECKED_IN"] } }, include: { guest: true, room: true }, orderBy: { createdAt: "asc" } }),
    prisma.reservation.findMany({ where: { departureDate: toDbDate(today), status: { in: ["CHECKED_IN", "CHECKED_OUT"] } }, include: { guest: true, room: true }, orderBy: { endAt: "asc" } }),
    prisma.reservation.count({ where: { status: "PENDING" } }),
    prisma.payment.count({ where: { status: "PENDING" } }),
    prisma.housekeepingTask.count({ where: { status: { in: ["PENDING", "IN_PROGRESS", "COMPLETED", "FAILED_INSPECTION"] } } }),
    prisma.maintenanceTicket.count({ where: { status: { in: ["OPEN", "ASSIGNED", "IN_PROGRESS", "AWAITING_PARTS"] } } }),
    prisma.message.count({ where: { fromGuest: true, readAt: null } }),
    prisma.serviceRequest.count({ where: { status: { in: ["OPEN", "ASSIGNED", "IN_PROGRESS"] } } }),
    financialReport({ from: today, to: today }),
    financialReport({ from: monthStart, to: today }),
    prisma.reservation.findMany({ where: { status: "CHECKED_IN" }, select: { id: true, adults: true, children: true } }),
  ]);
  const counts: Record<string, number> = {};
  for (const b of board) counts[b.status] = (counts[b.status] ?? 0) + 1;
  const newForms = await prisma.bookingRequest.count({ where: { status: "NEW" } });
  const reservedFuture = await prisma.reservation.count({ where: { status: { in: ["PENDING", "CONFIRMED"] }, departureDate: { gt: toDbDate(today) } } });
  const outstanding = await outstandingBalances();
  const activeRooms = board.filter((b) => b.room.isActive).length;
  const occupied = board.filter((b) => b.status === "OCCUPIED").length;
  return {
    board, counts, totalRooms: board.length, activeRooms, occupied,
    occupancyPct: activeRooms ? (occupied / activeRooms) * 100 : 0,
    arrivals, departures, inHouse: inHouseRes.length, inHouseGuests: inHouseRes.reduce((a, r) => a + r.adults + r.children, 0),
    pendingRes, pendingPayments, hkPending, mtPending, unreadMsgs, srOpen, reservedFuture, newForms,
    todayRevenue: todayFin.revenue, todayPayments: todayFin.paymentsTotal, monthRevenue: monthFin.revenue, monthPayments: monthFin.paymentsTotal,
    outstandingTotal: sum(outstanding.filter((o) => o.balance.gt(0)).map((o) => o.balance)), outstandingCount: outstanding.filter((o) => o.balance.gt(0)).length,
  };
}
