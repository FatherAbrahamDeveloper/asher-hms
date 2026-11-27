import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/db";
import { audit } from "../../lib/audit";
import { AppError } from "../../lib/errors";
import { addDays, fmtDateTime, fromDbDate, isDateStr, lagosDayStart, toDbDate, todayLagos } from "../../lib/dates";
import { sum } from "../../lib/money";
import { toCsv } from "../../lib/csv";
import { zBool, zDate, zInt, zMoney, zOpt, zReq } from "../../lib/validation";
import { staff } from "../../core/auth";
import { body, form, h, page, q } from "../../core/http";
import { decideRefund, recordPayment, rejectPayment, requestRefund, verifyPayment } from "../../services/billing";
import { postAdjustment, postCharge, reverseLine, POSTABLE_CATEGORIES } from "../../services/folio";
import { EXPENSE_CATEGORIES, recordExpense, voidExpense } from "../../services/admin";
import { bookingReport, financialReport, outstandingBalances } from "../../services/reports";
import type { Prisma } from "@/generated/prisma/client";

export const finance = Router();

// ───────── Payments ─────────
finance.get("/payments", h(async (req) => {
  await staff(req, "payments.view");
  const { take, skip, page: p } = page(req, 30);
  const from = q(req, "from"), to = q(req, "to"), text = q(req, "q");
  const where: Prisma.PaymentWhereInput = {
    ...(q(req, "status") ? { status: q(req, "status") as never } : {}),
    ...(q(req, "method") ? { method: q(req, "method") as never } : {}),
    ...(isDateStr(from) || isDateStr(to) ? { receivedAt: { ...(isDateStr(from) ? { gte: lagosDayStart(from) } : {}), ...(isDateStr(to) ? { lt: lagosDayStart(addDays(to, 1)) } : {}) } } : {}),
    ...(text ? { OR: [{ reference: { contains: text, mode: "insensitive" } }, { externalRef: { contains: text, mode: "insensitive" } }, { reservation: { reference: { contains: text, mode: "insensitive" } } }, { guest: { lastName: { contains: text, mode: "insensitive" } } }] } : {}),
  };
  const [rows, total, verified] = await Promise.all([
    prisma.payment.findMany({ where, include: { guest: { select: { firstName: true, lastName: true } }, reservation: { select: { id: true, reference: true } }, receipt: true }, orderBy: { receivedAt: "desc" }, take, skip }),
    prisma.payment.count({ where }),
    prisma.payment.findMany({ where: { ...where, status: "VERIFIED" }, select: { amount: true } }),
  ]);
  return { rows, total, page: p, pages: Math.ceil(total / take), verifiedTotal: sum(verified.map((v) => v.amount.toString())) };
}));

finance.post("/payments", form, h(async (req) => {
  const s = await staff(req, "payments.record");
  const d = z.object({ reservationId: zReq("Reservation"), method: z.enum(["CASH", "BANK_TRANSFER", "POS"]), amount: zMoney, isDeposit: zBool, externalRef: zOpt(80), payerName: zOpt(100), notes: zOpt(500), markVerified: zBool }).parse(body(req));
  const p = await recordPayment(s.actor, { ...d, canVerify: s.can("payments.verify") });
  return p.status === "VERIFIED" ? `Payment ${p.reference} recorded and receipted.` : `Transfer ${p.reference} recorded — awaiting verification by finance.`;
}));

finance.post("/payments/:id/verify", form, h(async (req) => {
  const s = await staff(req, "payments.verify");
  await verifyPayment(s.actor, String(req.params.id), (body(req).note as string) || null);
  return "Payment verified and receipt issued.";
}));

finance.post("/payments/:id/reject", form, h(async (req) => {
  const s = await staff(req, "payments.verify");
  const d = z.object({ reason: zReq("Reason", 500) }).parse(body(req));
  await rejectPayment(s.actor, String(req.params.id), d.reason);
  return "Payment rejected; guest notified.";
}));

// ───────── Folio ─────────
finance.post("/folio/charges", form, h(async (req) => {
  const s = await staff(req, "folio.charge");
  const d = z.object({ reservationId: zReq("Reservation"), category: z.enum(POSTABLE_CATEGORIES as [string, ...string[]]), description: zReq("Description", 200), quantity: zInt(1, 100, "Quantity"), unitPrice: zMoney }).parse(body(req));
  await prisma.$transaction((tx) => postCharge(tx, s.actor, { ...d, category: d.category as never }));
  return "Charge posted.";
}));

/** Discounts are price negotiation (managers only); other adjustments are accounting corrections (finance). */
finance.post("/folio/adjustments", form, h(async (req) => {
  const d = z.object({ reservationId: zReq("Reservation"), kind: z.enum(["DISCOUNT", "ADJUSTMENT"]), amount: z.string().trim().regex(/^-?\d+(\.\d{1,2})?$/, "Enter a valid amount"), description: zReq("Description", 200), reason: zReq("Reason", 500) }).parse(body(req));
  const s = await staff(req, d.kind === "DISCOUNT" ? "pricing.negotiate" : "folio.adjust");
  await prisma.$transaction((tx) => postAdjustment(tx, s.actor, d));
  return d.kind === "DISCOUNT" ? "Discount applied." : "Adjustment posted.";
}));

finance.post("/folio/charges/:id/reverse", form, h(async (req) => {
  const s = await staff(req, "folio.adjust");
  const d = z.object({ reason: zReq("Reason", 500) }).parse(body(req));
  await prisma.$transaction(async (tx) => {
    const line = await tx.folioCharge.findUniqueOrThrow({ where: { id: String(req.params.id) } });
    const rev = await reverseLine(tx, s.actor, line.id, d.reason);
    await audit(tx, s.actor, { action: "folio.reversal", module: "finance", recordType: "FolioCharge", recordId: rev.id, oldValues: { line: line.reference, amount: line.amount.toFixed(2), description: line.description }, newValues: { reversal: rev.reference }, reason: d.reason });
  });
  return "Charge reversed.";
}));

// ───────── Refunds ─────────
finance.get("/refunds", h(async (req) => {
  await staff(req, "refunds.request", "refunds.process");
  return { refunds: await prisma.refund.findMany({ include: { payment: { include: { guest: { select: { firstName: true, lastName: true } }, reservation: { select: { id: true, reference: true } } } } }, orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 100 }) };
}));

finance.post("/refunds", form, h(async (req) => {
  const s = await staff(req, "refunds.request");
  const d = z.object({ paymentId: zReq("Payment"), amount: zMoney, method: z.enum(["CASH", "BANK_TRANSFER", "POS", "CARD_ONLINE"]), reason: zReq("Reason", 500) }).parse(body(req));
  const r = await requestRefund(s.actor, d);
  return `Refund ${r.reference} requested — awaiting approval.`;
}));

finance.post("/refunds/:id/decide", form, h(async (req) => {
  const s = await staff(req, "refunds.process");
  const d = z.object({ decision: z.enum(["PROCESS", "REJECT"]), reason: zReq("Note", 500) }).parse(body(req));
  await decideRefund(s.actor, String(req.params.id), d.decision, d.reason);
  return d.decision === "PROCESS" ? "Refund processed." : "Refund rejected.";
}));

// ───────── Invoices ─────────
finance.get("/invoices", h(async (req) => {
  await staff(req, "payments.view");
  const { take, skip, page: p } = page(req, 30);
  const text = q(req, "q");
  const where = text ? { OR: [{ number: { contains: text, mode: "insensitive" as const } }, { reservation: { reference: { contains: text, mode: "insensitive" as const } } }] } : {};
  const [rows, total] = await Promise.all([
    prisma.invoice.findMany({ where, include: { reservation: { select: { reference: true, guest: { select: { firstName: true, lastName: true } } } } }, orderBy: { issuedAt: "desc" }, take, skip }),
    prisma.invoice.count({ where }),
  ]);
  return { rows, total, page: p, pages: Math.ceil(total / take) };
}));

// ───────── Expenses ─────────
finance.get("/expenses", h(async (req) => {
  await staff(req, "expenses.view");
  const today = todayLagos();
  const from = isDateStr(q(req, "from")) ? q(req, "from")! : today.slice(0, 8) + "01";
  const to = isDateStr(q(req, "to")) ? q(req, "to")! : today;
  const rows = await prisma.expense.findMany({ where: { expenseDate: { gte: toDbDate(from), lte: toDbDate(to) }, ...(q(req, "category") ? { category: q(req, "category") } : {}) }, orderBy: { expenseDate: "desc" } });
  return { from, to, rows, total: sum(rows.filter((r) => !r.voidedAt).map((r) => r.amount.toString())), categories: EXPENSE_CATEGORIES, today };
}));

finance.post("/expenses", form, h(async (req) => {
  const s = await staff(req, "expenses.manage");
  const d = z.object({ category: zReq("Category", 60), description: zReq("Description", 300), amount: zMoney, expenseDate: zDate, paymentMethod: zReq("Payment method", 40), vendor: zOpt(120) }).parse(body(req));
  await recordExpense(s.actor, d);
  return "Expense recorded.";
}));

finance.post("/expenses/:id/void", form, h(async (req) => {
  const s = await staff(req, "expenses.manage");
  const d = z.object({ reason: zReq("Reason", 500) }).parse(body(req));
  await voidExpense(s.actor, String(req.params.id), d.reason);
  return "Expense voided.";
}));

// ───────── Reports ─────────
function range(req: Parameters<typeof q>[0]) {
  const today = todayLagos();
  const from = q(req, "from"), to = q(req, "to");
  if (isDateStr(from) && isDateStr(to) && from <= to) return { from, to };
  switch (q(req, "preset")) {
    case "today": return { from: today, to: today };
    case "week": return { from: addDays(today, -6), to: today };
    case "year": return { from: today.slice(0, 4) + "-01-01", to: today };
    case "last-month": { const d = new Date(today.slice(0, 8) + "01T00:00:00Z"); d.setUTCDate(0); const end = d.toISOString().slice(0, 10); return { from: end.slice(0, 8) + "01", to: end }; }
    default: return { from: today.slice(0, 8) + "01", to: today };
  }
}

finance.get("/reports/financial", h(async (req) => { await staff(req, "reports.view"); return financialReport(range(req)); }));
finance.get("/reports/bookings", h(async (req) => { await staff(req, "reports.view"); const r = range(req); return { range: r, ...(await bookingReport(r)) }; }));
finance.get("/reports/outstanding", h(async (req) => { await staff(req, "reports.view", "payments.view"); return { range: range(req), rows: await outstandingBalances() }; }));

finance.get("/reports/export", h(async (req, res) => {
  const s = await staff(req, "reports.export");
  const type = q(req, "type") ?? "";
  const { from, to } = range(req);
  const tsRange = { gte: lagosDayStart(from), lt: lagosDayStart(addDays(to, 1)) };
  let header: string[] = [];
  let rows: (string | number | null)[][] = [];
  switch (type) {
    case "revenue": {
      header = ["Service date", "Line ref", "Booking", "Room", "Guest", "Category", "Description", "Amount (net)", "Tax", "Service charge", "Total", "Reversal of", "Posted by"];
      const lines = await prisma.folioCharge.findMany({ where: { serviceDate: { gte: toDbDate(from), lte: toDbDate(to) } }, include: { reservation: { include: { room: true, guest: true } }, reversalOf: true }, orderBy: { serviceDate: "asc" } });
      rows = lines.map((l) => [fromDbDate(l.serviceDate), l.reference, l.reservation.reference, l.reservation.room.number, `${l.reservation.guest.firstName} ${l.reservation.guest.lastName}`, l.category, l.description, l.amount.toFixed(2), l.tax.toFixed(2), l.serviceCharge.toFixed(2), l.amount.plus(l.tax).plus(l.serviceCharge).toFixed(2), l.reversalOf?.reference ?? "", l.postedByName]);
      break;
    }
    case "payments": {
      header = ["Received", "Reference", "Booking", "Guest", "Method", "Status", "Amount", "Deposit", "External ref", "Recorded by", "Verified by"];
      const ps = await prisma.payment.findMany({ where: { receivedAt: tsRange }, include: { reservation: true, guest: true }, orderBy: { receivedAt: "asc" } });
      rows = ps.map((p) => [fmtDateTime(p.receivedAt), p.reference, p.reservation?.reference ?? "", `${p.guest.firstName} ${p.guest.lastName}`, p.method, p.status, p.amount.toFixed(2), p.isDeposit ? "yes" : "no", p.externalRef, p.recordedByName, p.verifiedByName]);
      break;
    }
    case "refunds": {
      header = ["Requested", "Reference", "Payment", "Amount", "Method", "Status", "Reason", "Requested by", "Processed by", "Processed"];
      const rs = await prisma.refund.findMany({ where: { createdAt: tsRange }, include: { payment: true }, orderBy: { createdAt: "asc" } });
      rows = rs.map((r) => [fmtDateTime(r.createdAt), r.reference, r.payment.reference, r.amount.toFixed(2), r.method, r.status, r.reason, r.requestedByName, r.processedByName, r.processedAt ? fmtDateTime(r.processedAt) : ""]);
      break;
    }
    case "expenses": {
      header = ["Date", "Reference", "Category", "Description", "Vendor", "Amount", "Paid via", "Recorded by", "Voided", "Void reason"];
      const es = await prisma.expense.findMany({ where: { expenseDate: { gte: toDbDate(from), lte: toDbDate(to) } }, orderBy: { expenseDate: "asc" } });
      rows = es.map((e) => [fromDbDate(e.expenseDate), e.reference, e.category, e.description, e.vendor, e.amount.toFixed(2), e.paymentMethod, e.recordedByName, e.voidedAt ? "yes" : "no", e.voidReason]);
      break;
    }
    case "bookings": {
      header = ["Created", "Reference", "Guest", "Room", "Stay type", "Arrival", "Departure", "Start", "End", "Adults", "Children", "Status", "Source", "Rate", "Negotiated", "Negotiation reason"];
      const bs = await prisma.reservation.findMany({ where: { createdAt: tsRange }, include: { guest: true, room: true }, orderBy: { createdAt: "asc" } });
      rows = bs.map((r) => [fmtDateTime(r.createdAt), r.reference, `${r.guest.firstName} ${r.guest.lastName}`, r.room.number, r.stayType, fromDbDate(r.arrivalDate), fromDbDate(r.departureDate), fmtDateTime(r.startAt), fmtDateTime(r.endAt), r.adults, r.children, r.status, r.source, r.nightlyRate.toFixed(2), r.rateNegotiated ? "yes" : "no", r.negotiationReason]);
      break;
    }
    case "outstanding": {
      header = ["Booking", "Guest", "Phone", "Room", "Arrival", "Departure", "Status", "Charges", "Paid", "Balance"];
      rows = (await outstandingBalances()).map((r) => [r.reference, `${r.guest.firstName} ${r.guest.lastName}`, r.guest.phone, r.room.number, fromDbDate(r.arrivalDate), fromDbDate(r.departureDate), r.status, r.total.toFixed(2), r.paid.toFixed(2), r.balance.toFixed(2)]);
      break;
    }
    default:
      throw new AppError("Unknown report.");
  }
  await audit(prisma, s.actor, { action: "report.export", module: "reports", recordType: "Report", recordId: type, newValues: { from, to, rows: rows.length } });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="asher-${type}-${from}-to-${to}.csv"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(toCsv(header, rows));
}));
