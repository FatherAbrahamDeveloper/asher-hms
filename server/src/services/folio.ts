import { prisma, type Tx } from "../lib/db";
import { D, round2, sum, toDb, type Decimal } from "../lib/money";
import { toDbDate, todayLagos, type DateStr } from "../lib/dates";
import { makeRef } from "../lib/refs";
import { audit, type Actor } from "../lib/audit";
import { AppError } from "../lib/errors";
import { getSettings } from "../lib/settings";
import type { ChargeCategory } from "@/generated/prisma/enums";
import { priceLine } from "./pricing";

export const CHARGE_LABELS: Record<ChargeCategory, string> = {
  ROOM: "Room", SHORT_STAY: "Short stay", FOOD_BEVERAGE: "Food & beverages", ROOM_SERVICE: "Room service", LAUNDRY: "Laundry", MINIBAR: "Minibar",
  SERVICE: "Other services", DAMAGE: "Damages", CANCELLATION_FEE: "Cancellation fee", NO_SHOW_FEE: "No-show fee",
  DISCOUNT: "Discount", ADJUSTMENT: "Adjustment", OTHER: "Other",
};

/** Categories staff may post as ad-hoc charges (taxable at hotel rates). */
export const POSTABLE_CATEGORIES: ChargeCategory[] = ["FOOD_BEVERAGE", "ROOM_SERVICE", "LAUNDRY", "MINIBAR", "SERVICE", "DAMAGE", "OTHER"];

type LineInput = {
  reservationId: string; category: ChargeCategory; description: string; serviceDate: DateStr; quantity?: number;
  unitPrice: Decimal.Value; tax?: Decimal.Value; serviceCharge?: Decimal.Value; reason?: string | null;
};

export async function postLine(tx: Tx, actor: Actor, l: LineInput) {
  const qty = l.quantity ?? 1;
  const amount = round2(D(l.unitPrice).mul(qty));
  return tx.folioCharge.create({
    data: {
      reference: makeRef("FC", 10), reservationId: l.reservationId, category: l.category, description: l.description,
      serviceDate: toDbDate(l.serviceDate), quantity: qty, unitPrice: toDb(l.unitPrice), amount: toDb(amount),
      tax: toDb(l.tax ?? 0), serviceCharge: toDb(l.serviceCharge ?? 0), reason: l.reason ?? null,
      postedById: actor.userId, postedByName: actor.name,
    },
  });
}

/** Reverse a folio line with an equal and opposite line. The original is never edited. */
export async function reverseLine(tx: Tx, actor: Actor, lineId: string, reason: string) {
  const line = await tx.folioCharge.findUniqueOrThrow({ where: { id: lineId }, include: { reversedBy: true } });
  if (line.reversedBy) throw new AppError("This charge has already been reversed.");
  if (line.reversalOfId) throw new AppError("A reversal line cannot itself be reversed.");
  return tx.folioCharge.create({
    data: {
      reference: makeRef("FC", 10), reservationId: line.reservationId, category: line.category,
      description: `Reversal: ${line.description}`, serviceDate: line.serviceDate, quantity: line.quantity,
      unitPrice: toDb(D(line.unitPrice).neg()), amount: toDb(D(line.amount).neg()), tax: toDb(D(line.tax).neg()),
      serviceCharge: toDb(D(line.serviceCharge).neg()), reversalOfId: line.id, reason, postedById: actor.userId, postedByName: actor.name,
    },
  });
}

/** Reverse every still-active line in the given categories (used when stay dates, rate or room change, or on cancellation). */
export async function reverseActiveLines(tx: Tx, actor: Actor, reservationId: string, categories: ChargeCategory[], reason: string, filter?: (serviceDate: DateStr) => boolean) {
  const lines = await tx.folioCharge.findMany({ where: { reservationId, category: { in: categories }, reversalOfId: null, reversedBy: null } });
  for (const l of lines) {
    if (filter && !filter(l.serviceDate.toISOString().slice(0, 10))) continue;
    await reverseLine(tx, actor, l.id, reason);
  }
}

/** Post an ad-hoc taxable charge (e.g. room service, laundry) with hotel tax and service charge. */
export async function postCharge(tx: Tx, actor: Actor, input: { reservationId: string; category: ChargeCategory; description: string; quantity: number; unitPrice: Decimal.Value; serviceDate?: DateStr }) {
  if (!POSTABLE_CATEGORIES.includes(input.category)) throw new AppError("That charge category cannot be posted manually.");
  if (D(input.unitPrice).lte(0)) throw new AppError("Charge amount must be greater than zero.");
  const res = await tx.reservation.findUniqueOrThrow({ where: { id: input.reservationId } });
  if (["CANCELLED", "NO_SHOW"].includes(res.status)) throw new AppError("Charges cannot be posted to a cancelled reservation.");
  const s = await getSettings(tx);
  const gross = round2(D(input.unitPrice).mul(input.quantity));
  // Prices entered by staff follow the hotel's pricing basis (VAT-inclusive by default).
  const priced = priceLine(gross, s.finance.taxRate, s.finance.serviceChargeRate, s.finance.taxInclusive !== false);
  const line = await postLine(tx, actor, {
    reservationId: input.reservationId, category: input.category, description: input.quantity > 1 ? `${input.description} (${input.quantity} × ${D(input.unitPrice).toFixed(2)})` : input.description,
    serviceDate: input.serviceDate ?? todayLagos(), quantity: 1, unitPrice: priced.amount.toFixed(2), tax: priced.tax.toFixed(2), serviceCharge: priced.serviceCharge.toFixed(2),
  });
  await audit(tx, actor, { action: "folio.charge_posted", module: "finance", recordType: "FolioCharge", recordId: line.id, newValues: { reservation: res.reference, category: input.category, description: input.description, total: priced.gross.toFixed(2) } });
  return line;
}

/** Discount or adjustment (negative or positive, untaxed). Requires a reason; audited. */
export async function postAdjustment(tx: Tx, actor: Actor, input: { reservationId: string; kind: "DISCOUNT" | "ADJUSTMENT"; amount: Decimal.Value; description: string; reason: string }) {
  if (!input.reason?.trim()) throw new AppError("A reason is required for discounts and adjustments.");
  const res = await tx.reservation.findUniqueOrThrow({ where: { id: input.reservationId } });
  const amt = round2(input.amount);
  if (amt.isZero()) throw new AppError("Amount cannot be zero.");
  const signed = input.kind === "DISCOUNT" ? amt.abs().neg() : amt;
  const line = await postLine(tx, actor, { reservationId: res.id, category: input.kind, description: input.description, serviceDate: todayLagos(), unitPrice: signed, reason: input.reason });
  await audit(tx, actor, { action: input.kind === "DISCOUNT" ? "folio.discount" : "folio.adjustment", module: "finance", recordType: "FolioCharge", recordId: line.id, newValues: { reservation: res.reference, amount: signed.toFixed(2), description: input.description }, reason: input.reason });
  return line;
}

export type FolioSummary = Awaited<ReturnType<typeof folioSummary>>;

/** The single source of truth for what a guest owes: charges − verified payments + processed refunds. */
export async function folioSummary(reservationId: string, db: Tx = prisma) {
  const [lines, payments] = await Promise.all([
    db.folioCharge.findMany({ where: { reservationId }, orderBy: [{ serviceDate: "asc" }, { createdAt: "asc" }], include: { reversedBy: { select: { id: true } } } }),
    db.payment.findMany({ where: { reservationId }, orderBy: { receivedAt: "asc" }, include: { refunds: true, receipt: true } }),
  ]);
  const lineTotal = (l: { amount: unknown; tax: unknown; serviceCharge: unknown }) => D(l.amount as string).plus(D(l.tax as string)).plus(D(l.serviceCharge as string));
  const subtotal = sum(lines.map((l) => l.amount.toString()));
  const tax = sum(lines.map((l) => l.tax.toString()));
  const serviceCharge = sum(lines.map((l) => l.serviceCharge.toString()));
  const total = subtotal.plus(tax).plus(serviceCharge);
  const verified = payments.filter((p) => p.status === "VERIFIED");
  const paid = sum(verified.map((p) => p.amount.toString()));
  const refunded = sum(payments.flatMap((p) => p.refunds.filter((r) => r.status === "PROCESSED").map((r) => r.amount.toString())));
  const pending = sum(payments.filter((p) => p.status === "PENDING").map((p) => p.amount.toString()));
  const deposits = sum(verified.filter((p) => p.isDeposit).map((p) => p.amount.toString()));
  const netPaid = paid.minus(refunded);
  const balance = total.minus(netPaid);
  // Grouped view of active (non-reversed) lines for guest-facing bills
  const byCategory = new Map<ChargeCategory, Decimal>();
  for (const l of lines) byCategory.set(l.category, (byCategory.get(l.category) ?? D(0)).plus(lineTotal(l)));
  return {
    lines: lines.map((l) => ({ ...l, lineTotal: lineTotal(l), isReversed: !!l.reversedBy })),
    payments, subtotal, tax, serviceCharge, total, paid, refunded, netPaid, pending, deposits, balance,
    byCategory: [...byCategory.entries()].filter(([, v]) => !v.isZero()).map(([category, amount]) => ({ category, label: CHARGE_LABELS[category], amount })),
    paymentStatus: (total.lte(0) && netPaid.lte(0) ? "NONE" : balance.lte(0) ? "PAID" : netPaid.gt(0) ? "PARTIAL" : "UNPAID") as "NONE" | "PAID" | "PARTIAL" | "UNPAID",
  };
}

/** Balances for many reservations at once (lists, dashboards). */
export async function balancesFor(reservationIds: string[], db: Tx = prisma) {
  const out = new Map<string, { total: Decimal; paid: Decimal; balance: Decimal }>();
  if (!reservationIds.length) return out;
  const [charges, payments, refunds] = await Promise.all([
    db.folioCharge.groupBy({ by: ["reservationId"], where: { reservationId: { in: reservationIds } }, _sum: { amount: true, tax: true, serviceCharge: true } }),
    db.payment.groupBy({ by: ["reservationId"], where: { reservationId: { in: reservationIds }, status: "VERIFIED" }, _sum: { amount: true } }),
    db.$queryRaw<{ reservationId: string; total: string }[]>`
      SELECT p."reservationId", COALESCE(SUM(r."amount"),0)::text AS total FROM "Refund" r JOIN "Payment" p ON p."id" = r."paymentId"
      WHERE r."status" = 'PROCESSED' AND p."reservationId" = ANY(${reservationIds}) GROUP BY p."reservationId"`,
  ]);
  for (const id of reservationIds) out.set(id, { total: D(0), paid: D(0), balance: D(0) });
  for (const c of charges) {
    const o = out.get(c.reservationId)!;
    o.total = D(c._sum.amount?.toString()).plus(D(c._sum.tax?.toString())).plus(D(c._sum.serviceCharge?.toString()));
  }
  for (const p of payments) if (p.reservationId) out.get(p.reservationId)!.paid = D(p._sum.amount?.toString());
  for (const r of refunds) out.get(r.reservationId)!.paid = out.get(r.reservationId)!.paid.minus(D(r.total));
  for (const o of out.values()) o.balance = o.total.minus(o.paid);
  return out;
}
