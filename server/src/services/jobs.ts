import { prisma } from "../lib/db";
import { SYSTEM_ACTOR, audit } from "../lib/audit";
import { addDays, fromDbDate, toDbDate, todayLagos } from "../lib/dates";
import { naira } from "../lib/money";
import { notifyGuest, notifyStaff } from "../lib/notify";
import { getSettings } from "../lib/settings";
import { blockOverlapWhere } from "./availability";
import { processOutbox } from "./delivery";
import { cancelReservation } from "./reservations";
import { balancesFor } from "./folio";

/** Release unpaid online bookings whose payment hold has expired (verified payments confirm them first). */
export async function expireUnpaidHolds() {
  const expired = await prisma.reservation.findMany({ where: { status: "PENDING", holdExpiresAt: { lt: new Date() } }, select: { id: true } });
  let count = 0;
  for (const r of expired) {
    const pending = await prisma.payment.count({ where: { reservationId: r.id, status: "PENDING" } });
    if (pending) continue; // a transfer is awaiting verification — let finance decide
    try {
      await cancelReservation(SYSTEM_ACTOR, r.id, "Payment not received before the hold expired", { system: true });
      count++;
    } catch (e) {
      console.error("[jobs] expire hold failed", r.id, e);
    }
  }
  return count;
}

export async function sendArrivalAndDepartureReminders() {
  const s = await getSettings();
  const today = todayLagos(), tomorrow = addDays(today, 1);
  const arrivals = await prisma.reservation.findMany({ where: { status: { in: ["CONFIRMED", "PENDING"] }, arrivalDate: { in: [toDbDate(today), toDbDate(tomorrow)] } }, include: { room: true } });
  for (const r of arrivals) {
    await notifyGuest(prisma, r.guestId, {
      category: "reminder", title: `Your stay ${fromDbDate(r.arrivalDate) === today ? "starts today" : "starts tomorrow"}`,
      body: `Room ${r.room.number}, check-in from ${s.policies.checkInTime}.${r.preCheckInAt ? "" : " Save time at the desk: complete digital check-in now."}`,
      link: `/account/reservations/${r.reference}${r.preCheckInAt ? "" : "/check-in"}`, dedupeKey: `arrival-reminder:${r.id}:${fromDbDate(r.arrivalDate)}`, sms: true,
    });
  }
  const departures = await prisma.reservation.findMany({ where: { status: "CHECKED_IN", departureDate: toDbDate(today) }, include: { room: true } });
  for (const r of departures) {
    await notifyGuest(prisma, r.guestId, { category: "reminder", title: "Check-out today", body: `Check-out time is ${s.policies.checkOutTime}. Review your bill and request express checkout in the app.`, link: `/account/billing?ref=${r.reference}`, dedupeKey: `departure-reminder:${r.id}`, email: false, sms: true });
  }
  return arrivals.length + departures.length;
}

export async function flagOverdueHousekeeping() {
  const overdue = await prisma.housekeepingTask.findMany({ where: { status: { in: ["PENDING", "IN_PROGRESS"] }, dueAt: { lt: new Date() } }, include: { room: true } });
  for (const t of overdue) {
    await notifyStaff(prisma, ["housekeeping.manage"], { category: "housekeeping", priority: "HIGH", title: `Overdue: Room ${t.room.number}`, body: `Task ${t.reference} (${t.type.replace(/_/g, " ").toLowerCase()}) is overdue${t.assignedToName ? ` — assigned to ${t.assignedToName}` : " and unassigned"}.`, link: "/manage/housekeeping", dedupeKey: `hk-overdue:${t.id}` }, { alsoUserIds: [t.assignedToId] });
  }
  return overdue.length;
}

/** Keep the room maintenance flag in step with date-ranged blocks (a block can start in the future). */
export async function syncRoomMaintenanceState() {
  const today = todayLagos();
  const rooms = await prisma.room.findMany({ include: { blocks: { where: blockOverlapWhere(today, addDays(today, 1)) } } });
  for (const r of rooms) {
    const state = r.blocks.some((b) => b.type === "OUT_OF_ORDER") ? "OUT_OF_ORDER" : r.blocks.length ? "MAINTENANCE" : "OK";
    if (state !== r.maintenanceState) {
      await prisma.$transaction(async (tx) => {
        await tx.room.update({ where: { id: r.id }, data: { maintenanceState: state } });
        await audit(tx, SYSTEM_ACTOR, { action: "room.status_change", module: "rooms", recordType: "Room", recordId: r.id, oldValues: { maintenanceState: r.maintenanceState }, newValues: { maintenanceState: state }, reason: "Scheduled block date reached" });
      });
    }
  }
}

export async function flagOutstandingBalances() {
  const recent = await prisma.reservation.findMany({ where: { status: "CHECKED_OUT", checkedOutAt: { gte: new Date(Date.now() - 30 * 86400_000) } }, select: { id: true, reference: true } });
  const balances = await balancesFor(recent.map((r) => r.id));
  for (const r of recent) {
    const b = balances.get(r.id)!;
    if (b.balance.gt(0)) await notifyStaff(prisma, ["payments.verify"], { category: "billing", title: `Outstanding balance: ${r.reference}`, body: `${naira(b.balance)} still owed after check-out.`, link: `/manage/reservations/${r.id}`, dedupeKey: `balance-week:${r.id}:${todayLagos().slice(0, 8)}` });
  }
}

const JOBS: { name: string; everyMinutes: number; run: () => Promise<unknown> }[] = [
  { name: "outbox", everyMinutes: 1, run: () => processOutbox() },
  { name: "expire-holds", everyMinutes: 5, run: expireUnpaidHolds },
  { name: "reminders", everyMinutes: 60, run: sendArrivalAndDepartureReminders },
  { name: "housekeeping-overdue", everyMinutes: 15, run: flagOverdueHousekeeping },
  { name: "room-blocks", everyMinutes: 30, run: syncRoomMaintenanceState },
  { name: "balances", everyMinutes: 24 * 60, run: flagOutstandingBalances },
];

/** Run whichever jobs are due. Safe to call often (cron, or opportunistically from page loads). */
export async function runDueJobs(force = false) {
  const results: Record<string, unknown> = {};
  for (const job of JOBS) {
    const last = await prisma.jobRun.findUnique({ where: { name: job.name } });
    if (!force && last && Date.now() - last.lastRunAt.getTime() < job.everyMinutes * 60_000) continue;
    // claim the slot first so concurrent callers don't double-run
    const claimed = await prisma.jobRun.upsert({ where: { name: job.name }, create: { name: job.name, lastRunAt: new Date() }, update: { lastRunAt: new Date() } });
    if (!claimed) continue;
    try { results[job.name] = await job.run(); } catch (e) { results[job.name] = `error: ${(e as Error).message}`; console.error(`[jobs] ${job.name}`, e); }
  }
  return results;
}

let lastKick = 0;
/** Fire-and-forget trigger used by layouts so jobs run even without an external cron. */
export function kickJobs() {
  if (Date.now() - lastKick < 60_000) return;
  lastKick = Date.now();
  runDueJobs().catch((e) => console.error("[jobs]", e));
}
