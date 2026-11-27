import { prisma, type Tx } from "../lib/db";
import { D, naira, round2, toDb, type Decimal } from "../lib/money";
import { makeRef, nextSequence } from "../lib/refs";
import { audit, type Actor } from "../lib/audit";
import { AppError } from "../lib/errors";
import { notifyGuest, notifyStaff } from "../lib/notify";
import { getSettings } from "../lib/settings";
import { CHARGE_LABELS, folioSummary } from "./folio";
import type { PaymentMethod } from "@/generated/prisma/enums";

const TX_OPTS = { timeout: 20_000, maxWait: 10_000 };

export const METHOD_LABEL: Record<PaymentMethod, string> = { CASH: "Cash", BANK_TRANSFER: "Bank transfer", POS: "POS / card at hotel", CARD_ONLINE: "Card (online)" };

/** Snapshot the folio into an immutable, sequentially numbered invoice. */
export async function issueInvoice(tx: Tx, actor: Actor, reservationId: string, opts: { final?: boolean } = {}) {
  const settings = await getSettings(tx);
  const folio = await folioSummary(reservationId, tx);
  const number = await nextSequence(tx, "invoice", settings.reservations.invoicePrefix);
  const invoice = await tx.invoice.create({
    data: {
      number, reservationId, issuedById: actor.userId, issuedByName: actor.name, isFinal: !!opts.final,
      subtotal: toDb(folio.subtotal), tax: toDb(folio.tax), serviceCharge: toDb(folio.serviceCharge), total: toDb(folio.total),
      paid: toDb(folio.netPaid), balance: toDb(folio.balance),
      items: {
        create: folio.lines.map((l) => ({
          description: l.description, category: CHARGE_LABELS[l.category], serviceDate: l.serviceDate, quantity: l.quantity,
          unitPrice: l.unitPrice, amount: toDb(l.lineTotal),
        })),
      },
    },
  });
  await audit(tx, actor, { action: "invoice.issue", module: "finance", recordType: "Invoice", recordId: invoice.id, newValues: { number, total: folio.total.toFixed(2), balance: folio.balance.toFixed(2), final: !!opts.final } });
  const res = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId } });
  await notifyGuest(tx, res.guestId, { category: "billing", title: `Invoice ${number}`, body: `An invoice for ${naira(folio.total)} has been issued for booking ${res.reference}. Balance: ${naira(folio.balance)}.`, link: `/account/billing?ref=${res.reference}`, dedupeKey: `invoice:${invoice.id}`, email: true });
  return invoice;
}

async function issueReceipt(tx: Tx, paymentId: string) {
  const settings = await getSettings(tx);
  const existing = await tx.receipt.findUnique({ where: { paymentId } });
  if (existing) return existing;
  return tx.receipt.create({ data: { number: await nextSequence(tx, "receipt", settings.reservations.receiptPrefix), paymentId } });
}

/** After a payment is verified: receipt, auto-confirmation when the deposit threshold is met, notifications. */
async function afterVerified(tx: Tx, actor: Actor, paymentId: string) {
  const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { reservation: { include: { room: true } }, guest: true } });
  const receipt = await issueReceipt(tx, p.id);
  if (p.reservation) {
    const folio = await folioSummary(p.reservation.id, tx);
    const settings = await getSettings(tx);
    const depositDue = round2(folio.total.mul(D(settings.finance.depositPercent)).div(100));
    if (p.reservation.status === "PENDING" && folio.netPaid.gte(depositDue)) {
      const { confirmReservation } = await import("./reservations");
      await confirmReservation(actor, p.reservation.id, tx);
    }
    await notifyGuest(tx, p.guestId, {
      category: "payment", title: p.isDeposit ? "Deposit received" : "Payment received",
      body: `We received ${naira(p.amount.toString())} (${METHOD_LABEL[p.method]}) for booking ${p.reservation.reference}. Receipt ${receipt.number}. Balance: ${naira(folio.balance)}.`,
      link: `/account/payments`, dedupeKey: `payment-verified:${p.id}`, sms: true,
    });
  }
  await notifyStaff(tx, ["payments.view"], { category: "payment", title: `Payment received ${naira(p.amount.toString())}`, body: `${p.guest.firstName} ${p.guest.lastName} · ${METHOD_LABEL[p.method]}${p.reservation ? ` · ${p.reservation.reference}` : ""} · ${p.reference}`, link: `/manage/payments?q=${p.reference}`, dedupeKey: `payment-verified:${p.id}` }, { exclude: actor.userId });
  return receipt;
}

export type RecordPaymentInput = {
  reservationId: string; method: PaymentMethod; amount: Decimal.Value; isDeposit?: boolean; externalRef?: string | null;
  payerName?: string | null; notes?: string | null; markVerified?: boolean; canVerify?: boolean;
};

/**
 * Staff records money received. Cash and POS taken at the desk are verified by the recording officer.
 * Bank transfers stay PENDING until someone with payments.verify confirms them against the bank statement
 * (they may do it immediately if they hold that permission and tick "verified").
 */
export async function recordPayment(actor: Actor, input: RecordPaymentInput) {
  const amount = round2(input.amount);
  if (amount.lte(0)) throw new AppError("Amount must be greater than zero.");
  if (input.method === "BANK_TRANSFER" && !input.externalRef?.trim()) throw new AppError("Enter the bank transfer reference / session ID.");
  if (input.method === "CARD_ONLINE") throw new AppError("Online card payments are recorded automatically by the payment gateway.");
  return prisma.$transaction(async (tx) => {
    const r = await tx.reservation.findUniqueOrThrow({ where: { id: input.reservationId } });
    if (["CANCELLED", "NO_SHOW"].includes(r.status)) {
      const folio = await folioSummary(r.id, tx);
      if (folio.balance.lte(0)) throw new AppError("This reservation has no outstanding balance.");
    }
    const verifiedNow = input.method === "CASH" || input.method === "POS" || (input.method === "BANK_TRANSFER" && !!input.markVerified && !!input.canVerify);
    const p = await tx.payment.create({
      data: {
        reference: makeRef("PAY"), reservationId: r.id, guestId: r.guestId, method: input.method, amount: toDb(amount),
        isDeposit: !!input.isDeposit, externalRef: input.externalRef?.trim() || null, payerName: input.payerName || null, notes: input.notes || null,
        status: verifiedNow ? "VERIFIED" : "PENDING", recordedById: actor.userId, recordedByName: actor.name,
        verifiedAt: verifiedNow ? new Date() : null, verifiedById: verifiedNow ? actor.userId : null, verifiedByName: verifiedNow ? actor.name : null,
      },
    });
    await audit(tx, actor, { action: "payment.record", module: "finance", recordType: "Payment", recordId: p.id, newValues: { reference: p.reference, reservation: r.reference, method: input.method, amount: amount.toFixed(2), status: p.status, externalRef: p.externalRef, deposit: !!input.isDeposit } });
    if (verifiedNow) {
      await audit(tx, actor, { action: "payment.verify", module: "finance", recordType: "Payment", recordId: p.id, newValues: { status: "VERIFIED" } });
      await afterVerified(tx, actor, p.id);
    } else {
      await notifyStaff(tx, ["payments.verify"], { category: "payment", priority: "HIGH", title: "Bank transfer awaiting verification", body: `${naira(amount)} on ${r.reference} (ref ${p.externalRef}).`, link: `/manage/payments?status=PENDING`, dedupeKey: `payment-pending:${p.id}` }, { exclude: actor.userId });
    }
    return p;
  }, TX_OPTS);
}

/** Guest submits a bank transfer for verification (never treated as paid until finance verifies it). */
export async function submitGuestTransfer(actor: Actor, input: { reservationId: string; amount: Decimal.Value; externalRef: string; payerName: string; proofPath?: string | null }) {
  const amount = round2(input.amount);
  if (amount.lte(0)) throw new AppError("Amount must be greater than zero.");
  return prisma.$transaction(async (tx) => {
    const r = await tx.reservation.findUniqueOrThrow({ where: { id: input.reservationId } });
    if (r.guestId !== actor.guestId) throw new AppError("Reservation not found.");
    if (["CANCELLED", "NO_SHOW"].includes(r.status)) throw new AppError("This booking is no longer active.");
    const folio = await folioSummary(r.id, tx);
    if (amount.gt(folio.balance.minus(folio.pending))) throw new AppError(`Amount exceeds the outstanding balance of ${naira(folio.balance.minus(folio.pending))} (including transfers awaiting verification).`);
    const dup = await tx.payment.findUnique({ where: { externalRef: input.externalRef.trim() } });
    if (dup) throw new AppError("A payment with this transfer reference has already been submitted.");
    const p = await tx.payment.create({
      data: { reference: makeRef("PAY"), reservationId: r.id, guestId: r.guestId, method: "BANK_TRANSFER", amount: toDb(amount), externalRef: input.externalRef.trim(), payerName: input.payerName, proofPath: input.proofPath ?? null, isDeposit: r.status === "PENDING" && amount.lt(folio.balance), status: "PENDING", recordedByName: `${actor.name} (guest)` },
    });
    // Submitting proof of payment extends the hold so it doesn't expire while finance verifies it.
    if (r.holdExpiresAt) await tx.reservation.update({ where: { id: r.id }, data: { holdExpiresAt: new Date(Math.max(r.holdExpiresAt.getTime(), Date.now() + 48 * 3600_000)) } });
    await audit(tx, actor, { action: "payment.guest_transfer_submitted", module: "finance", recordType: "Payment", recordId: p.id, newValues: { reservation: r.reference, amount: amount.toFixed(2), externalRef: p.externalRef } });
    await notifyStaff(tx, ["payments.verify"], { category: "payment", priority: "HIGH", title: "Guest bank transfer to verify", body: `${naira(amount)} for ${r.reference} · ref ${p.externalRef} · payer ${input.payerName}`, link: `/manage/payments?status=PENDING`, dedupeKey: `payment-pending:${p.id}` });
    await notifyGuest(tx, r.guestId, { category: "payment", title: "Transfer submitted for verification", body: `We will confirm your transfer of ${naira(amount)} for ${r.reference} shortly.`, link: `/account/payments`, dedupeKey: `payment-submitted:${p.id}`, email: false });
    return p;
  }, TX_OPTS);
}

export async function verifyPayment(actor: Actor, paymentId: string, note?: string | null) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${paymentId} FOR UPDATE`;
    const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    if (p.status !== "PENDING") throw new AppError(`This payment is already ${p.status.toLowerCase()}.`);
    if (p.recordedById && p.recordedById === actor.userId && p.method === "BANK_TRANSFER") {
      // segregation of duties is encouraged but not mandatory for small teams; it is recorded in the audit trail
    }
    await tx.payment.update({ where: { id: p.id }, data: { status: "VERIFIED", verifiedAt: new Date(), verifiedById: actor.userId, verifiedByName: actor.name, notes: note ? [p.notes, `Verified: ${note}`].filter(Boolean).join("\n") : p.notes } });
    await audit(tx, actor, { action: "payment.verify", module: "finance", recordType: "Payment", recordId: p.id, oldValues: { status: "PENDING" }, newValues: { status: "VERIFIED", amount: p.amount.toFixed(2), sameOfficerAsRecorder: p.recordedById === actor.userId }, reason: note ?? null });
    return afterVerified(tx, actor, p.id);
  }, TX_OPTS);
}

export async function rejectPayment(actor: Actor, paymentId: string, reason: string) {
  if (!reason?.trim()) throw new AppError("A reason is required to reject a payment.");
  return prisma.$transaction(async (tx) => {
    const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { reservation: true } });
    if (p.status !== "PENDING") throw new AppError(`This payment is already ${p.status.toLowerCase()}.`);
    await tx.payment.update({ where: { id: p.id }, data: { status: "REJECTED", rejectionReason: reason, verifiedAt: new Date(), verifiedById: actor.userId, verifiedByName: actor.name } });
    await audit(tx, actor, { action: "payment.reject", module: "finance", recordType: "Payment", recordId: p.id, oldValues: { status: "PENDING" }, newValues: { status: "REJECTED" }, reason });
    await notifyGuest(tx, p.guestId, { category: "payment", priority: "HIGH", title: "Payment could not be verified", body: `We could not verify your payment of ${naira(p.amount.toString())}${p.reservation ? ` for ${p.reservation.reference}` : ""}: ${reason}. Please contact the hotel.`, link: `/account/payments`, dedupeKey: `payment-rejected:${p.id}`, sms: true });
    await notifyStaff(tx, ["payments.verify"], { category: "payment", priority: "HIGH", title: "Payment discrepancy", body: `Payment ${p.reference} (${naira(p.amount.toString())}) rejected: ${reason}`, link: `/manage/payments?q=${p.reference}`, dedupeKey: `payment-rejected:${p.id}` }, { exclude: actor.userId });
  }, TX_OPTS);
}

export async function requestRefund(actor: Actor, input: { paymentId: string; amount: Decimal.Value; reason: string; method: PaymentMethod }) {
  const amount = round2(input.amount);
  if (amount.lte(0)) throw new AppError("Refund amount must be greater than zero.");
  if (!input.reason?.trim()) throw new AppError("A reason is required for refunds.");
  return prisma.$transaction(async (tx) => {
    const p = await tx.payment.findUniqueOrThrow({ where: { id: input.paymentId }, include: { refunds: true, reservation: true } });
    if (p.status !== "VERIFIED") throw new AppError("Refunds must reference a verified payment.");
    const committed = p.refunds.filter((r) => r.status !== "REJECTED").reduce((a, r) => a.plus(D(r.amount.toString())), D(0));
    if (committed.plus(amount).gt(D(p.amount.toString()))) throw new AppError(`At most ${naira(D(p.amount.toString()).minus(committed))} can still be refunded on this payment.`);
    const refund = await tx.refund.create({ data: { reference: makeRef("RFD"), paymentId: p.id, amount: toDb(amount), method: input.method, reason: input.reason, requestedById: actor.userId, requestedByName: actor.name } });
    await audit(tx, actor, { action: "refund.request", module: "finance", recordType: "Refund", recordId: refund.id, newValues: { reference: refund.reference, payment: p.reference, amount: amount.toFixed(2), method: input.method }, reason: input.reason });
    await notifyStaff(tx, ["refunds.process"], { category: "refund", priority: "HIGH", title: "Refund requested", body: `${naira(amount)} on ${p.reference}${p.reservation ? ` (${p.reservation.reference})` : ""}: ${input.reason}`, link: "/manage/refunds", dedupeKey: `refund-req:${refund.id}` }, { exclude: actor.userId });
    return refund;
  }, TX_OPTS);
}

export async function decideRefund(actor: Actor, refundId: string, decision: "PROCESS" | "REJECT", note: string) {
  if (!note?.trim()) throw new AppError(decision === "PROCESS" ? "Enter the payout reference or a note." : "A reason is required to reject a refund.");
  return prisma.$transaction(async (tx) => {
    const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId }, include: { payment: { include: { reservation: true } } } });
    if (!["REQUESTED", "APPROVED"].includes(refund.status)) throw new AppError("This refund has already been decided.");
    const status = decision === "PROCESS" ? "PROCESSED" : "REJECTED";
    await tx.refund.update({ where: { id: refund.id }, data: { status, processedAt: new Date(), processedById: actor.userId, processedByName: actor.name, rejectionReason: decision === "REJECT" ? note : null } });
    await audit(tx, actor, { action: decision === "PROCESS" ? "refund.process" : "refund.reject", module: "finance", recordType: "Refund", recordId: refund.id, oldValues: { status: refund.status }, newValues: { status, amount: refund.amount.toFixed(2), sameOfficerAsRequester: refund.requestedById === actor.userId }, reason: note });
    if (decision === "PROCESS") {
      await notifyGuest(tx, refund.payment.guestId, { category: "refund", title: "Refund processed", body: `A refund of ${naira(refund.amount.toString())} (${METHOD_LABEL[refund.method]}) has been processed${refund.payment.reservation ? ` for ${refund.payment.reservation.reference}` : ""}.`, link: "/account/payments", dedupeKey: `refund-done:${refund.id}`, sms: true });
    }
  }, TX_OPTS);
}

// ───────────── Online card payments (Paystack) ─────────────

export function cardGatewayConfigured() {
  return !!process.env.PAYSTACK_SECRET_KEY;
}

/** Start a Paystack checkout. Amount is confirmed again server-side on verification; the browser is never trusted. */
export async function startCardPayment(actor: Actor, reservationId: string, amountInput: Decimal.Value) {
  if (!cardGatewayConfigured()) throw new AppError("Online card payment is not yet enabled. Please pay by bank transfer or at the hotel.");
  const amount = round2(amountInput);
  const r = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId }, include: { guest: true } });
  if (r.guestId !== actor.guestId) throw new AppError("Reservation not found.");
  const folio = await folioSummary(r.id);
  if (amount.lte(0) || amount.gt(folio.balance)) throw new AppError(`Enter an amount up to ${naira(folio.balance)}.`);
  const reference = makeRef("PSK", 12);
  const res = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST", headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: r.guest.email ?? actor.name, amount: amount.mul(100).toFixed(0), currency: "NGN", reference, callback_url: `${process.env.API_URL ?? process.env.APP_URL}/api/payments/paystack/callback`, metadata: { reservationId: r.id, guestId: r.guestId } }),
  });
  const body = (await res.json()) as { status: boolean; data?: { authorization_url: string } ; message?: string };
  if (!res.ok || !body.status || !body.data) throw new AppError(`Payment gateway error: ${body.message ?? res.status}`);
  await prisma.$transaction(async (tx) => {
    await tx.payment.create({ data: { reference: makeRef("PAY"), reservationId: r.id, guestId: r.guestId, method: "CARD_ONLINE", provider: "paystack", externalRef: reference, amount: toDb(amount), status: "PENDING", recordedByName: `${actor.name} (online)`, isDeposit: r.status === "PENDING" } });
    await audit(tx, actor, { action: "payment.card_initiated", module: "finance", recordType: "Reservation", recordId: r.id, newValues: { amount: amount.toFixed(2), gatewayRef: reference } });
  });
  return body.data.authorization_url;
}

/** Server-to-server verification with Paystack. Idempotent; used by both the redirect callback and the webhook. */
export async function confirmCardPayment(gatewayRef: string) {
  const payment = await prisma.payment.findUnique({ where: { externalRef: gatewayRef } });
  if (!payment || payment.status !== "PENDING") return payment;
  const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(gatewayRef)}`, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
  const body = (await res.json()) as { status: boolean; data?: { status: string; amount: number; currency: string } };
  const system: Actor = { userId: null, name: "Paystack gateway", role: "system", type: "SYSTEM" };
  const expectedKobo = D(payment.amount.toString()).mul(100).toFixed(0);
  if (body.status && body.data?.status === "success" && String(body.data.amount) === expectedKobo && body.data.currency === "NGN") {
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({ where: { id: payment.id }, data: { status: "VERIFIED", verifiedAt: new Date(), verifiedByName: "Paystack gateway" } });
      await audit(tx, system, { action: "payment.verify", module: "finance", recordType: "Payment", recordId: payment.id, newValues: { status: "VERIFIED", gateway: "paystack" } });
      await afterVerified(tx, system, payment.id);
    }, TX_OPTS);
  } else if (body.data && ["failed", "abandoned", "reversed"].includes(body.data.status)) {
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({ where: { id: payment.id }, data: { status: "FAILED", rejectionReason: `Gateway status: ${body.data!.status}` } });
      await audit(tx, system, { action: "payment.failed", module: "finance", recordType: "Payment", recordId: payment.id, newValues: { status: "FAILED", gatewayStatus: body.data!.status }, outcome: "FAILURE" });
      await notifyGuest(tx, payment.guestId, { category: "payment", priority: "HIGH", title: "Card payment failed", body: `Your card payment of ${naira(payment.amount.toString())} was not successful. No money was taken; please try again or pay by transfer.`, link: "/account/payments", dedupeKey: `payment-failed:${payment.id}` });
      await notifyStaff(tx, ["payments.view"], { category: "payment", title: "Card payment failed", body: `${payment.reference} · ${naira(payment.amount.toString())}`, link: `/manage/payments?q=${payment.reference}`, dedupeKey: `payment-failed:${payment.id}` });
    });
  } else if (body.data?.status === "success") {
    // Amount/currency mismatch — never auto-verify; flag for finance.
    await notifyStaff(prisma, ["payments.verify"], { category: "payment", priority: "URGENT", title: "Payment discrepancy (gateway)", body: `Gateway amount ${body.data.amount / 100} ${body.data.currency} does not match ${payment.reference}.`, link: `/manage/payments?q=${payment.reference}`, dedupeKey: `payment-mismatch:${payment.id}` });
  }
  return prisma.payment.findUnique({ where: { id: payment.id } });
}
