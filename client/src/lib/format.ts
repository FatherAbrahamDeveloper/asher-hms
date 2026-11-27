import { formatInTimeZone } from "date-fns-tz";

export const HOTEL_TZ = "Africa/Lagos";
const ngn = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", minimumFractionDigits: 2 });

/** Money arrives from the API as decimal strings; display only (never used for arithmetic that is saved). */
export function naira(v: unknown) {
  const n = Number(v ?? 0);
  return ngn.format(Number.isFinite(n) ? n : 0);
}
export const num = (v: unknown) => Number(v ?? 0);

/** Date-only fields (stay dates) are stored as UTC midnight; format in UTC so the calendar date is preserved. */
export function fmtDate(v: string | Date | null | undefined) {
  if (!v) return "—";
  const d = typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + "T00:00:00Z") : new Date(v);
  return formatInTimeZone(d, "UTC", "EEE d MMM yyyy");
}
export function fmtDateTime(v: string | Date | null | undefined) {
  return v ? formatInTimeZone(new Date(v), HOTEL_TZ, "d MMM yyyy, h:mm a") : "—";
}
export function fmtTime(v: string | Date | null | undefined) {
  return v ? formatInTimeZone(new Date(v), HOTEL_TZ, "h:mm a") : "—";
}
export const dateOnly = (v: string | Date) => new Date(v).toISOString().slice(0, 10);
export function todayLagos() { return formatInTimeZone(new Date(), HOTEL_TZ, "yyyy-MM-dd"); }
export function nowLagosHHMM() { return formatInTimeZone(new Date(), HOTEL_TZ, "HH:mm"); }
export function lagosHour() { return Number(formatInTimeZone(new Date(), HOTEL_TZ, "H")); }
export function addDays(s: string, n: number) { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function nightsBetween(a: string, b: string) { return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000); }
export const label = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export const STATUS_LABEL: Record<string, string> = { PENDING: "Pending", CONFIRMED: "Confirmed", CHECKED_IN: "Checked In", CHECKED_OUT: "Checked Out", CANCELLED: "Cancelled", NO_SHOW: "No Show" };
export const METHOD_LABEL: Record<string, string> = { CASH: "Cash", BANK_TRANSFER: "Bank transfer", POS: "POS / card at hotel", CARD_ONLINE: "Card (online)" };
export const CHARGE_LABELS: Record<string, string> = {
  ROOM: "Room", SHORT_STAY: "Short stay", FOOD_BEVERAGE: "Food & beverages", ROOM_SERVICE: "Room service", LAUNDRY: "Laundry", MINIBAR: "Minibar",
  SERVICE: "Other services", DAMAGE: "Damages", CANCELLATION_FEE: "Cancellation fee", NO_SHOW_FEE: "No-show fee", DISCOUNT: "Discount", ADJUSTMENT: "Adjustment", OTHER: "Other",
};
export const OPERATIONAL_LABEL: Record<string, string> = {
  AVAILABLE: "Available", RESERVED: "Reserved", OCCUPIED: "Occupied", DIRTY: "Dirty", CLEANING: "Cleaning", CLEAN: "Clean – awaiting inspection", INSPECTED: "Inspected", MAINTENANCE: "Maintenance", OUT_OF_ORDER: "Out of Order",
};

/** One-line description of when a stay happens (handles short stays). */
export function stayWhen(r: { stayType?: string; arrivalDate: string; departureDate: string; startAt?: string; endAt?: string; shortStayHours?: number | null }) {
  if (r.stayType === "SHORT") return `${fmtDate(r.arrivalDate)} · ${fmtTime(r.startAt)}–${fmtTime(r.endAt)} (${r.shortStayHours}h)`;
  return `${fmtDate(r.arrivalDate)} → ${fmtDate(r.departureDate)}`;
}
