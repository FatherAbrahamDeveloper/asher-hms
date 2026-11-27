import { formatInTimeZone } from "date-fns-tz";

export const HOTEL_TZ = "Africa/Lagos";

/** A calendar date in YYYY-MM-DD form (no time component). */
export type DateStr = string;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateStr(s: unknown): s is DateStr {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Today's date at the hotel (Africa/Lagos). */
export function todayLagos(now: Date = new Date()): DateStr {
  return formatInTimeZone(now, HOTEL_TZ, "yyyy-MM-dd");
}

/** Convert YYYY-MM-DD to the Date value Prisma expects for @db.Date columns. */
export function toDbDate(s: DateStr): Date {
  if (!isDateStr(s)) throw new Error(`Invalid date: ${s}`);
  return new Date(s + "T00:00:00Z");
}

/** Convert a @db.Date value back to YYYY-MM-DD. */
export function fromDbDate(d: Date): DateStr {
  return d.toISOString().slice(0, 10);
}

export function addDays(s: DateStr, n: number): DateStr {
  const d = toDbDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fromDbDate(d);
}

export function nightsBetween(arrival: DateStr, departure: DateStr): number {
  return Math.round((toDbDate(departure).getTime() - toDbDate(arrival).getTime()) / 86_400_000);
}

/** Each night of a stay (arrival inclusive, departure exclusive). */
export function eachNight(arrival: DateStr, departure: DateStr): DateStr[] {
  const out: DateStr[] = [];
  for (let d = arrival; d < departure; d = addDays(d, 1)) out.push(d);
  return out;
}

export function fmtDate(d: Date | DateStr | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? toDbDate(d) : d;
  // @db.Date values are UTC midnight; format in UTC so the calendar date is preserved.
  return formatInTimeZone(date, "UTC", "EEE d MMM yyyy");
}

export function fmtDateTime(d: Date | null | undefined): string {
  if (!d) return "—";
  return formatInTimeZone(d, HOTEL_TZ, "d MMM yyyy, h:mm a");
}

export function fmtTime(d: Date | null | undefined): string {
  if (!d) return "—";
  return formatInTimeZone(d, HOTEL_TZ, "h:mm a");
}

/** Start of a Lagos calendar day as a UTC instant (Lagos is UTC+1, no DST). */
export function lagosDayStart(s: DateStr): Date {
  return new Date(s + "T00:00:00+01:00");
}

/** Current hour (0-23) at the hotel. */
export function lagosHour(now: Date = new Date()): number {
  return Number(formatInTimeZone(now, HOTEL_TZ, "H"));
}
