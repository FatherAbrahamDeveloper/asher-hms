import { D, round2, sum, type Decimal } from "../lib/money";
import { eachNight, toDbDate, type DateStr } from "../lib/dates";
import type { Tx } from "../lib/db";
import { getSettings, type HotelSettings } from "../lib/settings";
import { AppError } from "../lib/errors";

/** A priced line: net amount plus tax and service charge. amount + tax + serviceCharge = what the guest pays. */
export type PricedLine = { amount: Decimal; tax: Decimal; serviceCharge: Decimal; gross: Decimal };

/**
 * Split a price into net amount, tax and service charge.
 * Tax-inclusive (the hotel's quoted price is final): gross stays exactly as quoted and VAT is the portion inside it.
 * Tax-exclusive: tax and service charge are added on top.
 */
export function priceLine(price: Decimal.Value, taxRate: Decimal.Value, scRate: Decimal.Value, inclusive: boolean): PricedLine {
  const p = round2(price);
  const t = D(taxRate), sc = D(scRate);
  if (inclusive) {
    const net = round2(p.mul(100).div(D(100).plus(t).plus(sc)));
    const tax = round2(net.mul(t).div(100));
    const serviceCharge = p.minus(net).minus(tax); // absorbs rounding so the total is exactly the quoted price
    return { amount: net, tax, serviceCharge, gross: p };
  }
  const tax = round2(p.mul(t).div(100));
  const serviceCharge = round2(p.mul(sc).div(100));
  return { amount: p, tax, serviceCharge, gross: p.plus(tax).plus(serviceCharge) };
}

export type NightPrice = PricedLine & { date: DateStr; rate: Decimal; seasonal?: string };

export type Quote = {
  stayType: "NIGHT" | "SHORT";
  nights: NightPrice[];
  nightCount: number;
  hours: number | null;
  /** Price before discounts, as quoted to the guest (gross when tax-inclusive). */
  listTotal: Decimal;
  roomSubtotal: Decimal; // net room amount (before discount)
  discountPercent: Decimal;
  discount: PricedLine | null;
  tax: Decimal;
  serviceCharge: Decimal;
  total: Decimal;
  taxRate: Decimal;
  serviceChargeRate: Decimal;
  taxLabel: string;
  taxInclusive: boolean;
  standardRate: Decimal;
  rate: Decimal;
  evening: boolean;
  label: string;
};

export type SeasonRule = { name: string; roomTypeId: string | null; startDate: DateStr; endDate: DateStr; adjustmentPercent: Decimal.Value };

/** Rate for a night: base rate adjusted by the most specific active seasonal rule (room type beats all-rooms). */
export function nightlyRateFor(date: DateStr, baseRate: Decimal.Value, roomTypeId: string, seasons: SeasonRule[]) {
  const rule = seasons
    .filter((s) => date >= s.startDate && date <= s.endDate && (s.roomTypeId === null || s.roomTypeId === roomTypeId))
    .sort((a, b) => (a.roomTypeId ? 0 : 1) - (b.roomTypeId ? 0 : 1))[0];
  const rate = rule ? round2(D(baseRate).mul(D(100).plus(D(rule.adjustmentPercent))).div(100)) : round2(baseRate);
  return { rate: rate.isNegative() ? D(0) : rate, seasonal: rule?.name };
}

type TaxArgs = { taxRate: Decimal.Value; serviceChargeRate: Decimal.Value; taxInclusive: boolean; taxLabel?: string };

function finish(stayType: "NIGHT" | "SHORT", lines: NightPrice[], discountPercent: Decimal.Value, t: TaxArgs, extra: { hours: number | null; standardRate: Decimal; rate: Decimal; evening: boolean; label: string }): Quote {
  const listTotal = sum(lines.map((n) => n.gross));
  const pct = D(discountPercent ?? 0);
  const discount = pct.gt(0) ? priceLine(round2(listTotal.mul(pct).div(100)), t.taxRate, t.serviceChargeRate, t.taxInclusive) : null;
  const roomSubtotal = sum(lines.map((n) => n.amount));
  const tax = sum(lines.map((n) => n.tax)).minus(discount?.tax ?? 0);
  const serviceCharge = sum(lines.map((n) => n.serviceCharge)).minus(discount?.serviceCharge ?? 0);
  const total = listTotal.minus(discount?.gross ?? 0);
  return {
    stayType, nights: lines, nightCount: stayType === "NIGHT" ? lines.length : 0, hours: extra.hours, listTotal, roomSubtotal, discountPercent: pct, discount,
    tax, serviceCharge, total, taxRate: D(t.taxRate), serviceChargeRate: D(t.serviceChargeRate), taxLabel: t.taxLabel ?? "VAT", taxInclusive: t.taxInclusive,
    standardRate: extra.standardRate, rate: extra.rate, evening: extra.evening, label: extra.label,
  };
}

/** Night-stay price. Pure function — used for quotes, bookings and tests. */
export function computeQuote(args: TaxArgs & {
  arrival: DateStr; departure: DateStr; baseRate: Decimal.Value; roomTypeId: string; seasons: SeasonRule[]; discountPercent?: Decimal.Value; rateOverride?: Decimal.Value | null;
}): Quote {
  const lines = eachNight(args.arrival, args.departure).map((date) => {
    const { rate, seasonal } = args.rateOverride != null ? { rate: round2(args.rateOverride), seasonal: undefined } : nightlyRateFor(date, args.baseRate, args.roomTypeId, args.seasons);
    return { date, rate, seasonal, ...priceLine(rate, args.taxRate, args.serviceChargeRate, args.taxInclusive) };
  });
  const n = lines.length;
  return finish("NIGHT", lines, args.discountPercent ?? 0, args, {
    hours: null, standardRate: round2(args.baseRate), rate: args.rateOverride != null ? round2(args.rateOverride) : round2(args.baseRate), evening: false,
    label: `${n} night${n === 1 ? "" : "s"}`,
  });
}

export type ShortStayTier = HotelSettings["shortStay"]["tiers"][number];

/** Is a Lagos clock time (HH:MM) at or after the evening threshold? */
export function isEvening(startTime: string, eveningFrom: string) {
  return startTime >= eveningFrom;
}

/** Standard package price for a short stay (evening price applies when the stay starts at/after eveningFrom). */
export function shortStayPrice(tiers: ShortStayTier[], hours: number, startTime: string, eveningFrom: string) {
  const tier = tiers.find((t) => t.hours === hours);
  if (!tier) throw new AppError(`There is no ${hours}-hour short-stay package.`);
  const evening = !!tier.eveningPrice && isEvening(startTime, eveningFrom);
  return { tier, evening, price: round2(evening ? tier.eveningPrice! : tier.price) };
}

/** Short-stay price. Pure function. */
export function computeShortQuote(args: TaxArgs & { date: DateStr; startTime: string; hours: number; tiers: ShortStayTier[]; eveningFrom: string; discountPercent?: Decimal.Value; rateOverride?: Decimal.Value | null }): Quote {
  const { tier, evening, price } = shortStayPrice(args.tiers, args.hours, args.startTime, args.eveningFrom);
  const rate = args.rateOverride != null ? round2(args.rateOverride) : price;
  const line: NightPrice = { date: args.date, rate, seasonal: evening ? "evening rate" : undefined, ...priceLine(rate, args.taxRate, args.serviceChargeRate, args.taxInclusive) };
  return finish("SHORT", [line], args.discountPercent ?? 0, args, { hours: args.hours, standardRate: price, rate, evening, label: `${tier.label}${evening ? " (evening)" : ""}` });
}

/**
 * Overtime rule for short stays: the bill moves to the smallest package that covers the time actually used
 * (plus a grace period). Beyond the longest package the stay becomes an overnight stay.
 */
export function overtimeOutcome(tiers: ShortStayTier[], bookedHours: number, minutesUsed: number, graceMinutes: number): { kind: "WITHIN" } | { kind: "UPGRADE"; hours: number } | { kind: "OVERNIGHT" } {
  if (minutesUsed <= bookedHours * 60 + graceMinutes) return { kind: "WITHIN" };
  const next = [...tiers].sort((a, b) => a.hours - b.hours).find((t) => t.hours > bookedHours && minutesUsed <= t.hours * 60 + graceMinutes);
  return next ? { kind: "UPGRADE", hours: next.hours } : { kind: "OVERNIGHT" };
}

export async function loadSeasons(db: Tx, from: DateStr, to: DateStr): Promise<SeasonRule[]> {
  const rows = await db.seasonalRate.findMany({ where: { isActive: true, startDate: { lte: toDbDate(to) }, endDate: { gte: toDbDate(from) } } });
  return rows.map((r) => ({ name: r.name, roomTypeId: r.roomTypeId, startDate: r.startDate.toISOString().slice(0, 10), endDate: r.endDate.toISOString().slice(0, 10), adjustmentPercent: r.adjustmentPercent.toString() }));
}

export async function resolveDiscount(db: Tx, code: string | null | undefined, arrival: DateStr) {
  if (!code?.trim()) return null;
  const dc = await db.discountCode.findUnique({ where: { code: code.trim().toUpperCase() } });
  const ok = dc && dc.isActive && (!dc.validFrom || dc.validFrom <= toDbDate(arrival)) && (!dc.validTo || dc.validTo >= toDbDate(arrival));
  if (!ok) throw new AppError("That discount code is not valid for these dates.");
  return dc;
}

function taxArgs(s: HotelSettings): TaxArgs {
  return { taxRate: s.finance.taxRate, serviceChargeRate: s.finance.serviceChargeRate, taxInclusive: s.finance.taxInclusive !== false, taxLabel: s.finance.taxLabel };
}

/** Quote a night stay for a room using live settings, seasonal rates and an optional discount code. */
export async function quoteForRoom(db: Tx, roomId: string, arrival: DateStr, departure: DateStr, discountCode?: string | null, rateOverride?: Decimal.Value | null) {
  const [room, settings] = await Promise.all([db.room.findUniqueOrThrow({ where: { id: roomId } }), getSettings(db)]);
  const seasons = await loadSeasons(db, arrival, departure);
  const discount = await resolveDiscount(db, discountCode, arrival);
  const quote = computeQuote({ ...taxArgs(settings), arrival, departure, baseRate: room.nightlyRate.toString(), roomTypeId: room.roomTypeId, seasons, discountPercent: discount?.percent.toString() ?? 0, rateOverride });
  return { quote, discount, room };
}

/** Quote a short stay for a room. */
export async function quoteShortStay(db: Tx, roomId: string, date: DateStr, startTime: string, hours: number, discountCode?: string | null, rateOverride?: Decimal.Value | null) {
  const [room, settings] = await Promise.all([db.room.findUniqueOrThrow({ where: { id: roomId } }), getSettings(db)]);
  if (!settings.shortStay.enabled) throw new AppError("Short stays are not available.");
  if (!room.allowShortStay) throw new AppError(`Room ${room.number} is not available for short stays.`);
  const discount = await resolveDiscount(db, discountCode, date);
  const quote = computeShortQuote({ ...taxArgs(settings), date, startTime, hours, tiers: settings.shortStay.tiers, eveningFrom: settings.shortStay.eveningFrom, discountPercent: discount?.percent.toString() ?? 0, rateOverride });
  return { quote, discount, room };
}
