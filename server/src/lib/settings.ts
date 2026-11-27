import { prisma, type Tx } from "./db";

export type HotelSettings = {
  hotel: {
    name: string; logoPath: string | null; tagline: string; address: string; city: string; state: string; country: string;
    phone: string; email: string; website: string;
  };
  policies: {
    checkInTime: string; checkOutTime: string; houseRules: string; cancellationPolicy: string;
    freeCancellationHours: number; cancellationFeeNights: number; noShowFeeNights: number; childPolicy: string;
    guestModificationHours: number;
  };
  finance: {
    currency: "NGN"; taxLabel: string; taxRate: string; serviceChargeRate: string; depositPercent: string;
    /** true: room and service prices already include VAT/service charge (the hotel's quoted price is final). */
    taxInclusive: boolean;
    paymentInstructions: string; bankName: string; accountName: string; accountNumber: string;
    acceptedMethods: string[];
  };
  reservations: {
    holdHours: number; maxAdvanceDays: number; maxNights: number; bookingRefPrefix: string; invoicePrefix: string;
    receiptPrefix: string; requireInspectionBeforeCheckIn: boolean; housekeepingOverdueHours: number;
    allowPayAtHotel: boolean; requireDepositForOnline: boolean;
  };
  shortStay: {
    enabled: boolean; onlineBooking: boolean; eveningFrom: string; graceMinutes: number;
    /** Packages, e.g. 2 hours ₦10,000 (₦15,000 when starting from eveningFrom). Prices follow finance.taxInclusive. */
    tiers: { hours: number; price: string; eveningPrice: string | null; label: string }[];
  };
  notifications: { emailEnabled: boolean; smsEnabled: boolean; arrivalReminderHours: number; departureReminderHours: number };
  security: { staffSessionHours: number; guestSessionHours: number; maxFailedLogins: number; lockoutMinutes: number; passwordMinLength: number };
  facilities: string[];
};

export const DEFAULT_SETTINGS: HotelSettings = {
  hotel: {
    name: "Asher Hotel and Suites", logoPath: null, tagline: "Comfort, privacy and warm hospitality",
    address: "", city: "", state: "", country: "Nigeria", phone: "", email: "", website: "",
  },
  policies: {
    checkInTime: "14:00", checkOutTime: "12:00",
    houseRules: "Valid government-issued identification is required at check-in.\nSmoking is not permitted inside rooms.\nQuiet hours are 10:00 PM to 7:00 AM.",
    cancellationPolicy: "Free cancellation up to 48 hours before arrival. Later cancellations are charged one night. No-shows are charged one night.",
    freeCancellationHours: 48, cancellationFeeNights: 1, noShowFeeNights: 1,
    childPolicy: "Children are welcome. Occupancy limits include children.", guestModificationHours: 48,
  },
  finance: {
    currency: "NGN", taxLabel: "VAT", taxRate: "7.5", serviceChargeRate: "0", depositPercent: "30", taxInclusive: true,
    paymentInstructions: "For bank transfers, use your booking reference as the transfer narration, then submit the transfer details on your reservation page for verification.",
    bankName: "", accountName: "", accountNumber: "", acceptedMethods: ["CASH", "BANK_TRANSFER", "POS", "CARD_ONLINE"],
  },
  reservations: {
    holdHours: 24, maxAdvanceDays: 365, maxNights: 60, bookingRefPrefix: "ASH", invoicePrefix: "INV", receiptPrefix: "RCT",
    requireInspectionBeforeCheckIn: true, housekeepingOverdueHours: 3, allowPayAtHotel: true, requireDepositForOnline: false,
  },
  shortStay: {
    enabled: true, onlineBooking: true, eveningFrom: "18:00", graceMinutes: 15,
    tiers: [
      { hours: 2, price: "10000.00", eveningPrice: "15000.00", label: "2 hours" },
      { hours: 3, price: "15000.00", eveningPrice: null, label: "3 hours" },
      { hours: 6, price: "20000.00", eveningPrice: null, label: "Half day (6 hours)" },
    ],
  },
  notifications: { emailEnabled: true, smsEnabled: false, arrivalReminderHours: 24, departureReminderHours: 3 },
  security: { staffSessionHours: 10, guestSessionHours: 72, maxFailedLogins: 5, lockoutMinutes: 15, passwordMinLength: 8 },
  facilities: ["24-hour front desk", "Free Wi-Fi", "Secure parking", "Room service", "Laundry service", "Standby power"],
};

export type SettingsSection = keyof HotelSettings;

export async function getSettings(db: Tx = prisma): Promise<HotelSettings> {
  const rows = await db.hotelSetting.findMany();
  const merged = structuredClone(DEFAULT_SETTINGS) as Record<string, unknown>;
  for (const r of rows) {
    const def = (DEFAULT_SETTINGS as Record<string, unknown>)[r.key];
    if (def === undefined) continue;
    merged[r.key] = Array.isArray(def) ? r.value : { ...(def as object), ...(r.value as object) };
  }
  return merged as HotelSettings;
}
