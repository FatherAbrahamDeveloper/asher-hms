import { describe, expect, it } from "vitest";
import { computeQuote, computeShortQuote, nightlyRateFor, overtimeOutcome, priceLine } from "@/services/pricing";
import { deriveOperationalStatus, shortSpan, nightSpan } from "@/services/availability";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { eachNight, nightsBetween, isDateStr } from "@/lib/dates";
import { D, parseAmount } from "@/lib/money";

const TIERS = DEFAULT_SETTINGS.shortStay.tiers;
const INCL = { taxRate: "7.5", serviceChargeRate: "0", taxInclusive: true };

describe("VAT-inclusive pricing (Asher's published prices are final)", () => {
  it("₦30,000 night: guest pays exactly ₦30,000, VAT is the portion inside it", () => {
    const l = priceLine("30000", "7.5", "0", true);
    expect(l.gross.toFixed(2)).toBe("30000.00");
    expect(l.amount.plus(l.tax).plus(l.serviceCharge).toFixed(2)).toBe("30000.00");
    expect(l.tax.toFixed(2)).toBe("2093.02");
  });

  it("night stay totals equal the quoted nightly price × nights", () => {
    const q = computeQuote({ ...INCL, arrival: "2027-01-10", departure: "2027-01-13", baseRate: "30000", roomTypeId: "t", seasons: [] });
    expect(q.nightCount).toBe(3);
    expect(q.total.toFixed(2)).toBe("90000.00");
    expect(q.roomSubtotal.plus(q.tax).toFixed(2)).toBe("90000.00");
  });

  it("room 306 at ₦40,000 a night", () => {
    expect(computeQuote({ ...INCL, arrival: "2027-01-10", departure: "2027-01-12", baseRate: "40000", roomTypeId: "t", seasons: [] }).total.toFixed(2)).toBe("80000.00");
  });

  it("can still price tax-exclusive if the hotel changes the setting", () => {
    const q = computeQuote({ taxRate: "7.5", serviceChargeRate: "10", taxInclusive: false, arrival: "2027-01-10", departure: "2027-01-13", baseRate: "45000.00", roomTypeId: "t1", seasons: [] });
    expect(q.total.toFixed(2)).toBe("158625.00");
  });

  it("discount codes reduce the inclusive total", () => {
    const q = computeQuote({ ...INCL, arrival: "2027-02-01", departure: "2027-02-03", baseRate: "30000", roomTypeId: "t", seasons: [], discountPercent: "10" });
    expect(q.total.toFixed(2)).toBe("54000.00");
  });

  it("applies seasonal rules, room-type specific over hotel-wide", () => {
    const seasons = [
      { name: "Festive", roomTypeId: null, startDate: "2026-12-20", endDate: "2027-01-02", adjustmentPercent: "20" },
      { name: "Suite promo", roomTypeId: "suite", startDate: "2026-12-24", endDate: "2026-12-26", adjustmentPercent: "-10" },
    ];
    expect(nightlyRateFor("2026-12-21", "50000", "std", seasons).rate.toFixed(2)).toBe("60000.00");
    expect(nightlyRateFor("2026-12-25", "50000", "suite", seasons).rate.toFixed(2)).toBe("45000.00");
  });
});

describe("short stays (rooms 301–304)", () => {
  const sq = (hours: number, startTime: string, rateOverride?: string) => computeShortQuote({ ...INCL, date: "2027-03-01", startTime, hours, tiers: TIERS, eveningFrom: "18:00", rateOverride });
  it("2 hours ₦10,000; 3 hours ₦15,000; half day (6 hours) ₦20,000", () => {
    expect(sq(2, "10:00").total.toFixed(2)).toBe("10000.00");
    expect(sq(3, "10:00").total.toFixed(2)).toBe("15000.00");
    expect(sq(6, "10:00").total.toFixed(2)).toBe("20000.00");
  });
  it("2 hours from 6 pm costs ₦15,000; other packages are unchanged in the evening", () => {
    expect(sq(2, "17:59").total.toFixed(2)).toBe("10000.00");
    const ev = sq(2, "18:00");
    expect(ev.total.toFixed(2)).toBe("15000.00");
    expect(ev.evening).toBe(true);
    expect(sq(3, "19:00").total.toFixed(2)).toBe("15000.00");
  });
  it("a manager-negotiated price replaces the package price but keeps the standard for the record", () => {
    const q = sq(2, "18:30", "12000");
    expect(q.total.toFixed(2)).toBe("12000.00");
    expect(q.standardRate.toFixed(2)).toBe("15000.00");
  });
  it("unknown package lengths are refused", () => {
    expect(() => sq(4, "10:00")).toThrow(/no 4-hour/);
  });
  it("time spans: short stays occupy exactly the package; nights run check-in to check-out", () => {
    const s = shortSpan("2027-03-01", "14:00", 2);
    expect(s.startAt.toISOString()).toBe("2027-03-01T13:00:00.000Z");
    expect(s.endAt.toISOString()).toBe("2027-03-01T15:00:00.000Z");
    const n = nightSpan("2027-03-01", "2027-03-02", DEFAULT_SETTINGS);
    expect(n.startAt.toISOString()).toBe("2027-03-01T13:00:00.000Z");
    expect(n.endAt.toISOString()).toBe("2027-03-02T11:00:00.000Z");
  });
  it("overtime moves to the next package, and past 6 hours becomes a night", () => {
    expect(overtimeOutcome(TIERS, 2, 130, 15)).toEqual({ kind: "WITHIN" });
    expect(overtimeOutcome(TIERS, 2, 170, 15)).toEqual({ kind: "UPGRADE", hours: 3 });
    expect(overtimeOutcome(TIERS, 2, 250, 15)).toEqual({ kind: "UPGRADE", hours: 6 });
    expect(overtimeOutcome(TIERS, 6, 400, 15)).toEqual({ kind: "OVERNIGHT" });
  });
});

describe("dates and amounts", () => {
  it("counts nights and validates dates", () => {
    expect(nightsBetween("2026-12-30", "2027-01-02")).toBe(3);
    expect(eachNight("2026-12-30", "2027-01-01")).toEqual(["2026-12-30", "2026-12-31"]);
    expect(isDateStr("2027-02-30")).toBe(false);
  });
  it("parses money input strictly", () => {
    expect(parseAmount("₦45,000.50").toFixed(2)).toBe("45000.50");
    expect(() => parseAmount("12.345")).toThrow();
    expect(D("0.1").plus("0.2").toFixed(2)).toBe("0.30");
  });
});

describe("room operational status", () => {
  const base = { isActive: true, housekeepingStatus: "INSPECTED", activeBlockType: null, occupied: false, arrivingToday: false } as const;
  it("derives status from real state, with blocks taking priority", () => {
    expect(deriveOperationalStatus(base)).toBe("AVAILABLE");
    expect(deriveOperationalStatus({ ...base, occupied: true, housekeepingStatus: "DIRTY" })).toBe("OCCUPIED");
    expect(deriveOperationalStatus({ ...base, housekeepingStatus: "DIRTY" })).toBe("DIRTY");
    expect(deriveOperationalStatus({ ...base, arrivingToday: true })).toBe("RESERVED");
    expect(deriveOperationalStatus({ ...base, occupied: true, activeBlockType: "OUT_OF_ORDER" })).toBe("OUT_OF_ORDER");
  });
});
