import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { createReservation, cancelReservation, checkIn, checkOut, modifyReservation, markNoShow } from "@/services/reservations";
import { findAvailableRooms as findRooms, nightSpan } from "@/services/availability";
import { DEFAULT_SETTINGS } from "@/lib/settings";
const findAvailableRooms = (a: string, d: string) => findRooms(nightSpan(a, d, DEFAULT_SETTINGS));
import { folioSummary, postCharge, reverseLine } from "@/services/folio";
import { recordPayment, verifyPayment, requestRefund, decideRefund, submitGuestTransfer, rejectPayment } from "@/services/billing";
import { blockRoom, releaseBlock, createTicket, updateTicket, inspectRoom, startHousekeepingTask, completeHousekeepingTask } from "@/services/operations";
import { expireUnpaidHolds } from "@/services/jobs";
import { addDays, todayLagos } from "@/lib/dates";
import { friendlyError } from "@/lib/errors";
import { makeGuest, makeStaff, room, window } from "./helpers";

describe("reservation engine", () => {
  it("creates a booking with unique reference, nightly folio lines and audit + notifications", async () => {
    const fd = await makeStaff("front_desk");
    const { guest, user } = await makeGuest();
    const r301 = await room("301");
    const w = window(3);
    const res = await createReservation(fd.actor, { guestId: guest.id, roomId: r301.id, ...w, adults: 2, children: 0, source: "TELEPHONE", paymentPlan: "PAY_AT_HOTEL", confirmImmediately: true });
    expect(res.reference).toMatch(/^ASH-[A-Z2-9]{6}$/);
    const folio = await folioSummary(res.id);
    expect(folio.lines.filter((l) => l.category === "ROOM")).toHaveLength(3);
    expect(folio.balance.toFixed(2)).toBe(folio.total.toFixed(2));
    expect(await prisma.auditLog.count({ where: { recordId: res.id, action: "reservation.create" } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: user.id, category: "reservation" } })).toBeGreaterThan(0);
    expect(await prisma.reservationHistory.count({ where: { reservationId: res.id } })).toBe(1);
  });

  it("prevents double-booking, including concurrent attempts", async () => {
    const fd = await makeStaff("front_desk");
    const { guest } = await makeGuest();
    const r302 = await room("302");
    const w = window(2);
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () => createReservation(fd.actor, { guestId: guest.id, roomId: r302.id, ...w, adults: 1, children: 0, source: "WALK_IN", paymentPlan: "PAY_AT_HOTEL" })),
    );
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((a) => a.status === "rejected") as PromiseRejectedResult;
    expect(friendlyError(rejected.reason)).toMatch(/already booked/i);
    // overlapping-but-not-identical dates are also refused
    await expect(createReservation(fd.actor, { guestId: guest.id, roomId: r302.id, arrival: addDays(w.arrival, 1), departure: addDays(w.departure, 2), adults: 1, children: 0, source: "WALK_IN", paymentPlan: "PAY_AT_HOTEL" })).rejects.toThrow(/already booked/);
    // back-to-back (departure day = next arrival) is allowed
    await expect(createReservation(fd.actor, { guestId: guest.id, roomId: r302.id, arrival: w.departure, departure: addDays(w.departure, 1), adults: 1, children: 0, source: "WALK_IN", paymentPlan: "PAY_AT_HOTEL" })).resolves.toBeTruthy();
  });

  it("the database itself rejects overlapping active reservations", async () => {
    const existing = await prisma.reservation.findFirstOrThrow({ where: { status: { in: ["PENDING", "CONFIRMED"] } } });
    await expect(prisma.reservation.create({ data: { reference: "ASH-RAWDUP", guestId: existing.guestId, roomId: existing.roomId, arrivalDate: existing.arrivalDate, departureDate: existing.departureDate, startAt: existing.startAt, endAt: existing.endAt, nightlyRate: "1" } })).rejects.toThrow();
  });

  it("validates dates and occupancy", async () => {
    const fd = await makeStaff("front_desk");
    const { guest } = await makeGuest();
    const r = await room("303");
    const w = window(1);
    await expect(createReservation(fd.actor, { guestId: guest.id, roomId: r.id, arrival: w.departure, departure: w.arrival, adults: 1, children: 0, source: "WALK_IN", paymentPlan: "PAY_AT_HOTEL" })).rejects.toThrow(/after the arrival/);
    await expect(createReservation(fd.actor, { guestId: guest.id, roomId: r.id, arrival: addDays(todayLagos(), -2), departure: addDays(todayLagos(), 1), adults: 1, children: 0, source: "WALK_IN", paymentPlan: "PAY_AT_HOTEL" })).rejects.toThrow(/past/);
    await expect(createReservation(fd.actor, { guestId: guest.id, roomId: r.id, ...w, adults: 3, children: 1, source: "WALK_IN", paymentPlan: "PAY_AT_HOTEL" })).rejects.toThrow(/at most/);
  });

  it("blocked rooms cannot be booked and disappear from availability", async () => {
    const ms = await makeStaff("maintenance_supervisor");
    const fd = await makeStaff("front_desk");
    const { guest } = await makeGuest();
    const r = await room("304");
    const w = window(2);
    const { block } = await blockRoom(ms.actor, { roomId: r.id, type: "OUT_OF_ORDER", startDate: w.arrival, endDate: w.departure, reason: "AC compressor" });
    const avail = await findAvailableRooms(w.arrival, w.departure);
    expect(avail.map((a) => a.number)).not.toContain("304");
    await expect(createReservation(fd.actor, { guestId: guest.id, roomId: r.id, ...w, adults: 1, children: 0, source: "WALK_IN", paymentPlan: "PAY_AT_HOTEL" })).rejects.toThrow(/blocked/);
    await releaseBlock(ms.actor, block.id, "Fixed");
    expect((await findAvailableRooms(w.arrival, w.departure)).map((a) => a.number)).toContain("304");
  });

  it("modifies dates by reversing and re-posting charges (folio stays immutable)", async () => {
    const fd = await makeStaff("front_desk");
    const { guest } = await makeGuest();
    const r = await room("306");
    const w = window(2);
    const res = await createReservation(fd.actor, { guestId: guest.id, roomId: r.id, ...w, adults: 1, children: 0, source: "WALK_IN", paymentPlan: "PAY_AT_HOTEL", confirmImmediately: true });
    const before = await folioSummary(res.id);
    await modifyReservation(fd.actor, res.id, { departure: addDays(w.departure, 1) }, "Guest extended");
    const after = await folioSummary(res.id);
    expect(after.total.toFixed(2)).toBe(before.total.div(2).mul(3).toFixed(2));
    expect(after.lines.filter((l) => l.reversalOfId)).toHaveLength(2);
    await expect(prisma.folioCharge.update({ where: { id: after.lines[0].id }, data: { description: "tamper" } })).rejects.toThrow();
    await expect(prisma.folioCharge.delete({ where: { id: after.lines[0].id } })).rejects.toThrow();
  });

  it("applies the late cancellation fee and frees the room", async () => {
    const fd = await makeStaff("front_desk");
    const { guest } = await makeGuest();
    const r = await room("301");
    const arrival = addDays(todayLagos(), 1);
    const res = await createReservation(fd.actor, { guestId: guest.id, roomId: r.id, arrival, departure: addDays(arrival, 2), adults: 1, children: 0, source: "WALK_IN", paymentPlan: "PAY_AT_HOTEL", confirmImmediately: true });
    const { fee } = await cancelReservation(fd.actor, res.id, "Change of plans");
    expect(fee.toFixed(2)).toBe(r.nightlyRate.toFixed(2));
    const folio = await folioSummary(res.id);
    expect(folio.subtotal.toFixed(2)).toBe(fee.toFixed(2));
    expect((await findAvailableRooms(arrival, addDays(arrival, 2))).map((a) => a.number)).toContain("301");
  });
});

describe("payments, refunds and verification", () => {
  it("guest bank transfers stay pending until finance verifies; verification confirms the booking", async () => {
    const acc = await makeStaff("accountant");
    const g = await makeGuest();
    const w = window(2);
    const res = await createReservation(g.actor, { guestId: g.guest.id, roomId: (await room("302")).id, ...w, adults: 1, children: 0, source: "ONLINE", paymentPlan: "DEPOSIT" });
    expect(res.status).toBe("PENDING");
    expect(res.holdExpiresAt).toBeTruthy();
    const folio = await folioSummary(res.id);
    const p = await submitGuestTransfer(g.actor, { reservationId: res.id, amount: folio.total.toFixed(2), externalRef: `TRF${Date.now()}`, payerName: "Ada Guest" });
    expect(p.status).toBe("PENDING");
    expect((await folioSummary(res.id)).netPaid.toFixed(2)).toBe("0.00");
    await verifyPayment(acc.actor, p.id);
    const after = await folioSummary(res.id);
    expect(after.balance.toFixed(2)).toBe("0.00");
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: res.id } })).status).toBe("CONFIRMED");
    expect(await prisma.receipt.count({ where: { paymentId: p.id } })).toBe(1);
    // verified payments are frozen at the database level
    await expect(prisma.payment.update({ where: { id: p.id }, data: { amount: "1.00" } })).rejects.toThrow();
    await expect(prisma.payment.delete({ where: { id: p.id } })).rejects.toThrow();
  });

  it("guests cannot pay against someone else's booking; rejected transfers never count", async () => {
    const acc = await makeStaff("accountant");
    const a = await makeGuest();
    const b = await makeGuest();
    const w = window(1);
    const res = await createReservation(a.actor, { guestId: a.guest.id, roomId: (await room("303")).id, ...w, adults: 1, children: 0, source: "ONLINE", paymentPlan: "DEPOSIT" });
    await expect(submitGuestTransfer(b.actor, { reservationId: res.id, amount: "1000", externalRef: `X${Date.now()}`, payerName: "B" })).rejects.toThrow(/not found/);
    const p = await submitGuestTransfer(a.actor, { reservationId: res.id, amount: "1000", externalRef: `Y${Date.now()}`, payerName: "A" });
    await rejectPayment(acc.actor, p.id, "Not on statement");
    expect((await folioSummary(res.id)).netPaid.toFixed(2)).toBe("0.00");
  });

  it("split payments, refunds capped at the original payment, processed refunds reduce net paid", async () => {
    const fd = await makeStaff("front_desk");
    const acc = await makeStaff("accountant");
    const { guest } = await makeGuest();
    const w = window(1);
    const res = await createReservation(fd.actor, { guestId: guest.id, roomId: (await room("304")).id, ...w, adults: 1, children: 0, source: "WALK_IN", paymentPlan: "PAY_AT_HOTEL", confirmImmediately: true });
    const cash = await recordPayment(fd.actor, { reservationId: res.id, method: "CASH", amount: "20000" });
    const pos = await recordPayment(fd.actor, { reservationId: res.id, method: "POS", amount: "10000" });
    expect(cash.status).toBe("VERIFIED");
    expect((await folioSummary(res.id)).netPaid.toFixed(2)).toBe("30000.00");
    await expect(requestRefund(fd.actor, { paymentId: pos.id, amount: "15000", reason: "x", method: "POS" })).rejects.toThrow(/At most/);
    const rf = await requestRefund(fd.actor, { paymentId: pos.id, amount: "4000", reason: "Overcharge", method: "CASH" });
    expect((await folioSummary(res.id)).netPaid.toFixed(2)).toBe("30000.00");
    await decideRefund(acc.actor, rf.id, "PROCESS", "Paid out in cash");
    expect((await folioSummary(res.id)).netPaid.toFixed(2)).toBe("26000.00");
    // the database enforces the cap even if the service is bypassed
    await expect(prisma.refund.create({ data: { reference: `RFD-RAW${Date.now()}`, paymentId: pos.id, amount: "9000", method: "CASH", reason: "raw" } })).rejects.toThrow();
  });

  it("bank transfers recorded by front desk need verification", async () => {
    const fd = await makeStaff("front_desk");
    const { guest } = await makeGuest();
    const w = window(1);
    const res = await createReservation(fd.actor, { guestId: guest.id, roomId: (await room("306")).id, ...w, adults: 1, children: 0, source: "WALK_IN", paymentPlan: "PAY_AT_HOTEL", confirmImmediately: true });
    await expect(recordPayment(fd.actor, { reservationId: res.id, method: "BANK_TRANSFER", amount: "5000" })).rejects.toThrow(/reference/);
    const p = await recordPayment(fd.actor, { reservationId: res.id, method: "BANK_TRANSFER", amount: "5000", externalRef: `NIP${Date.now()}`, markVerified: true, canVerify: false });
    expect(p.status).toBe("PENDING");
  });
});

describe("front desk, housekeeping and maintenance workflow", () => {
  it("check-in → charges → check-out creates invoice + housekeeping task; room not sellable until inspected", async () => {
    const fd = await makeStaff("front_desk");
    const hs = await makeStaff("housekeeping_supervisor");
    const hk = await makeStaff("housekeeping_staff");
    const { guest } = await makeGuest();
    const r = await room("303");
    const today = todayLagos();
    // make sure no one occupies 303 today
    const res = await createReservation(fd.actor, { guestId: guest.id, roomId: r.id, arrival: today, departure: addDays(today, 1), adults: 1, children: 0, source: "WALK_IN", paymentPlan: "PAY_AT_HOTEL", confirmImmediately: true });
    await expect(checkIn(fd.actor, res.id, {})).rejects.toThrow(/identification/);
    await checkIn(fd.actor, res.id, { idType: "NIN", idNumber: "12345678901" });
    const g = await prisma.guest.findUniqueOrThrow({ where: { id: guest.id } });
    expect(g.idNumberEncrypted).not.toContain("12345678901");
    await prisma.$transaction((tx) => postCharge(tx, fd.actor, { reservationId: res.id, category: "LAUNDRY", description: "Laundry - 3 shirts", quantity: 3, unitPrice: "1500" }));
    await expect(checkOut(fd.actor, res.id)).rejects.toThrow(/Outstanding balance/);
    const folio = await folioSummary(res.id);
    await recordPayment(fd.actor, { reservationId: res.id, method: "POS", amount: folio.balance.toFixed(2) });
    const { invoice, task } = await checkOut(fd.actor, res.id);
    expect(invoice.number).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(Number(invoice.balance)).toBe(0);
    expect((await prisma.room.findUniqueOrThrow({ where: { id: r.id } })).housekeepingStatus).toBe("DIRTY");

    // next guest cannot be checked in until inspection
    const next = await createReservation(fd.actor, { guestId: guest.id, roomId: r.id, arrival: today, departure: addDays(today, 1), adults: 1, children: 0, source: "WALK_IN", paymentPlan: "PAY_AT_HOTEL", confirmImmediately: true });
    await expect(checkIn(fd.actor, next.id, {})).rejects.toThrow(/inspection/);

    // housekeeping staff can only work their own tasks
    await expect(startHousekeepingTask(hk.actor, task.id, false)).rejects.toThrow(/not assigned/);
    await prisma.housekeepingTask.update({ where: { id: task.id }, data: { assignedToId: hk.user.id, assignedToName: "HK" } });
    await startHousekeepingTask(hk.actor, task.id, false);
    await completeHousekeepingTask(hk.actor, task.id, false, { notes: "done" });
    const fail = await inspectRoom(hs.actor, { roomId: r.id, taskId: task.id, passed: false, notes: "Bathroom not cleaned" });
    expect(fail.recleanTask).toBeTruthy();
    await startHousekeepingTask(hk.actor, fail.recleanTask!.id, false);
    await completeHousekeepingTask(hk.actor, fail.recleanTask!.id, false, {});
    await inspectRoom(hs.actor, { roomId: r.id, taskId: fail.recleanTask!.id, passed: true });
    await checkIn(fd.actor, next.id, {});
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: next.id } })).status).toBe("CHECKED_IN");
    await expect(checkIn(fd.actor, next.id, {})).rejects.toThrow();
  });

  it("maintenance ticket with room block; room can only return to service once resolved", async () => {
    const ms = await makeStaff("maintenance_supervisor");
    const tech = await makeStaff("maintenance_staff");
    const r = await room("302");
    const t = await createTicket(ms.actor, { roomId: r.id, category: "Plumbing", description: "Leaking sink", priority: "URGENT", block: "MAINTENANCE", canBlock: true, canAssign: true, assignedToId: tech.user.id });
    const block = await prisma.roomBlock.findFirstOrThrow({ where: { ticketId: t.id } });
    await expect(releaseBlock(ms.actor, block.id, "done")).rejects.toThrow(/Resolve/);
    await expect(updateTicket(tech.actor, t.id, { status: "CLOSED" }, { manage: false })).rejects.toThrow();
    await updateTicket(tech.actor, t.id, { status: "IN_PROGRESS", note: "On it" }, { manage: false });
    await updateTicket(tech.actor, t.id, { status: "RESOLVED", resolution: "Replaced washer" }, { manage: false });
    await releaseBlock(ms.actor, block.id, "Repaired");
    const room302 = await prisma.room.findUniqueOrThrow({ where: { id: r.id } });
    expect(room302.maintenanceState).toBe("OK");
    expect(room302.housekeepingStatus).toBe("DIRTY");
  });

  it("no-show charges the policy fee", async () => {
    const fd = await makeStaff("front_desk");
    const { guest } = await makeGuest();
    const today = todayLagos();
    const res = await createReservation(fd.actor, { guestId: guest.id, roomId: (await room("306")).id, arrival: today, departure: addDays(today, 2), adults: 1, children: 0, source: "TELEPHONE", paymentPlan: "PAY_AT_HOTEL", confirmImmediately: true });
    await markNoShow(fd.actor, res.id, "Did not arrive");
    const f = await folioSummary(res.id);
    expect(f.lines.some((l) => l.category === "NO_SHOW_FEE")).toBe(true);
  });

  it("expires unpaid online holds automatically", async () => {
    const g = await makeGuest();
    const w = window(1);
    const res = await createReservation(g.actor, { guestId: g.guest.id, roomId: (await room("301")).id, ...w, adults: 1, children: 0, source: "ONLINE", paymentPlan: "PAY_NOW" });
    await prisma.reservation.update({ where: { id: res.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    await expireUnpaidHolds();
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: res.id } })).status).toBe("CANCELLED");
  });

  it("folio reversals cannot be repeated", async () => {
    const fd = await makeStaff("front_desk");
    const line = await prisma.folioCharge.findFirstOrThrow({ where: { category: "LAUNDRY" } });
    await prisma.$transaction((tx) => reverseLine(tx, fd.actor, line.id, "posted in error"));
    await expect(prisma.$transaction((tx) => reverseLine(tx, fd.actor, line.id, "again"))).rejects.toThrow(/already been reversed/);
  });
});

describe("short stays and negotiated prices", () => {
  it("books a 2-hour stay, blocks overlapping time but allows a later slot the same day", async () => {
    const fd = await makeStaff("front_desk");
    const { guest } = await makeGuest();
    const r = await room("302");
    const day = addDays(todayLagos(), 40);
    const a = await createReservation(fd.actor, { guestId: guest.id, roomId: r.id, stayType: "SHORT", arrival: day, startTime: "10:00", hours: 2, adults: 1, children: 0, source: "WALK_IN", paymentPlan: "PAY_NOW", confirmImmediately: true });
    expect((await folioSummary(a.id)).total.toFixed(2)).toBe("10000.00");
    await expect(createReservation(fd.actor, { guestId: guest.id, roomId: r.id, stayType: "SHORT", arrival: day, startTime: "11:00", hours: 3, adults: 1, children: 0, source: "WALK_IN", paymentPlan: "PAY_NOW" })).rejects.toThrow(/already booked/);
    const b = await createReservation(fd.actor, { guestId: guest.id, roomId: r.id, stayType: "SHORT", arrival: day, startTime: "18:30", hours: 2, adults: 1, children: 0, source: "WALK_IN", paymentPlan: "PAY_NOW" });
    expect((await folioSummary(b.id)).total.toFixed(2)).toBe("15000.00");
    // a night stay starting that afternoon would clash with the 18:30 short stay
    await expect(createReservation(fd.actor, { guestId: guest.id, roomId: r.id, arrival: day, departure: addDays(day, 1), adults: 1, children: 0, source: "TELEPHONE", paymentPlan: "PAY_AT_HOTEL" })).rejects.toThrow(/already booked/);
  });

  it("room 306 is not offered for short stays", async () => {
    const fd = await makeStaff("front_desk");
    const { guest } = await makeGuest();
    await expect(createReservation(fd.actor, { guestId: guest.id, roomId: (await room("306")).id, stayType: "SHORT", arrival: addDays(todayLagos(), 41), startTime: "10:00", hours: 2, adults: 1, children: 0, source: "WALK_IN", paymentPlan: "PAY_NOW" })).rejects.toThrow(/short stays/);
  });

  it("only managers can negotiate a price, and a reason is required", async () => {
    const fd = await makeStaff("front_desk");
    const gm = await makeStaff("general_manager");
    const { guest } = await makeGuest();
    const w = window(2);
    const base = { guestId: guest.id, roomId: (await room("303")).id, ...w, adults: 1, children: 0, source: "TELEPHONE" as const, paymentPlan: "PAY_AT_HOTEL" as const, rateOverride: "25000" };
    await expect(createReservation(fd.actor, { ...base, canNegotiate: fd.perms.has("pricing.negotiate") })).rejects.toThrow(/Only a manager/);
    await expect(createReservation(gm.actor, { ...base, canNegotiate: gm.perms.has("pricing.negotiate") })).rejects.toThrow(/reason/);
    const r = await createReservation(gm.actor, { ...base, canNegotiate: true, negotiationReason: "Regular corporate guest" });
    expect(r.rateNegotiated).toBe(true);
    expect(r.standardRate?.toFixed(2)).toBe("30000.00");
    expect((await folioSummary(r.id)).total.toFixed(2)).toBe("50000.00");
    expect(await prisma.auditLog.count({ where: { recordId: r.id, action: "pricing.negotiated_rate" } })).toBe(1);
  });

  it("short-stay overtime at check-out moves the bill to the next package", async () => {
    const fd = await makeStaff("front_desk");
    const { guest } = await makeGuest();
    const r = await room("304");
    await prisma.room.update({ where: { id: r.id }, data: { housekeepingStatus: "INSPECTED" } });
    const now = new Date(Date.now() + 3600_000).toISOString().slice(11, 16); // Lagos HH:MM
    const res = await createReservation(fd.actor, { guestId: guest.id, roomId: r.id, stayType: "SHORT", arrival: todayLagos(), startTime: now, hours: 2, adults: 1, children: 0, source: "WALK_IN", paymentPlan: "PAY_NOW", confirmImmediately: true });
    await recordPayment(fd.actor, { reservationId: res.id, method: "CASH", amount: (await folioSummary(res.id)).total.toFixed(2) });
    await checkIn(fd.actor, res.id, { idType: "NIN", idNumber: "99999999999" });
    // simulate the guest having checked in 2h40m ago
    await prisma.reservation.update({ where: { id: res.id }, data: { checkedInAt: new Date(Date.now() - 160 * 60_000) } });
    const booked = (await folioSummary(res.id)).total.toFixed(2);
    if (booked === "10000.00") {
      // daytime: 2h ₦10,000 → 3h ₦15,000, so ₦5,000 more is due before check-out
      await expect(checkOut(fd.actor, res.id)).rejects.toThrow(/Outstanding balance/);
      expect((await folioSummary(res.id)).total.toFixed(2)).toBe("15000.00");
    } else {
      // evening: 2h is already ₦15,000, the same as 3h, so nothing extra is due
      expect(booked).toBe("15000.00");
      await checkOut(fd.actor, res.id);
      expect((await folioSummary(res.id)).total.toFixed(2)).toBe("15000.00");
    }
  });
});
