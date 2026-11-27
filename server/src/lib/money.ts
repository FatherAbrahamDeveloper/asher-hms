import Decimal from "decimal.js";

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export type MoneyInput = Decimal.Value | { toString(): string } | null | undefined;

/** Convert anything money-like (Prisma Decimal, string, number) to decimal.js. Never use floats for money. */
export function D(v: MoneyInput): Decimal {
  if (v === null || v === undefined || v === "") return new Decimal(0);
  if (Decimal.isDecimal(v)) return v as Decimal;
  return new Decimal(typeof v === "number" || typeof v === "string" ? v : v.toString());
}

export function round2(v: MoneyInput): Decimal {
  return D(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function sum(values: MoneyInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(D(v)), new Decimal(0));
}

/** Money as a fixed 2dp string, safe to store in a Decimal(14,2) column. */
export function toDb(v: MoneyInput): string {
  return round2(v).toFixed(2);
}

const fmt = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 2 });
export function naira(v: MoneyInput): string {
  return fmt.format(Number(round2(v).toFixed(2)));
}

/** Parse a user-entered amount like "45,000.50" into a Decimal; throws on invalid input. */
export function parseAmount(input: string | null | undefined): Decimal {
  const cleaned = String(input ?? "").replace(/[₦,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) throw new Error("Enter a valid amount (up to 2 decimal places)");
  return new Decimal(cleaned);
}

export { Decimal };
