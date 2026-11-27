import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../lib/db";
import { getSettings } from "../lib/settings";
import { todayLagos } from "../lib/dates";
import { AppError } from "../lib/errors";
import { zBool, zDate, zInt, zOpt, zPhone, zReq } from "../lib/validation";
import { cardGatewayConfigured } from "../services/billing";
import { addTransferDetails, cancelByGuest, findByToken, guestView, lookupLink, quoteForType, submitRequest } from "../services/requests";
import { registerGuest } from "../services/auth";
import { saveUpload } from "../services/files";
import { createSession, getGuest, meta } from "../core/auth";
import { NotFound, body, files, form, h, q } from "../core/http";

/**
 * Public website data: hotel profile, room types, photos and prices. Room availability is never published:
 * guests send a booking form and the front desk allocates the room.
 */
export const publicRoutes = Router();
const submitLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many attempts. Please wait a few minutes and try again." } });

publicRoutes.get("/settings", h(async () => {
  const s = await getSettings();
  return {
    hotel: s.hotel, policies: s.policies, facilities: s.facilities,
    finance: { taxLabel: s.finance.taxLabel, taxRate: s.finance.taxRate, serviceChargeRate: s.finance.serviceChargeRate, depositPercent: s.finance.depositPercent, taxInclusive: s.finance.taxInclusive, paymentInstructions: s.finance.paymentInstructions, bankName: s.finance.bankName, accountName: s.finance.accountName, accountNumber: s.finance.accountNumber },
    reservations: { maxNights: s.reservations.maxNights, maxAdvanceDays: s.reservations.maxAdvanceDays },
    shortStay: { enabled: s.shortStay.enabled, onlineBooking: s.shortStay.onlineBooking, eveningFrom: s.shortStay.eveningFrom, tiers: s.shortStay.tiers, graceMinutes: s.shortStay.graceMinutes },
    cardPayments: cardGatewayConfigured(), today: todayLagos(),
  };
}));

/** Room types with photos from their rooms, prices and features. No room numbers or availability. */
publicRoutes.get("/room-types", h(async () => {
  const s = await getSettings();
  const types = await prisma.roomType.findMany({
    where: { isActive: true, rooms: { some: { isActive: true } } },
    include: { rooms: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { number: "asc" }], include: { images: { orderBy: { sortOrder: "asc" } }, amenities: { include: { amenity: true } } } } },
    orderBy: { baseRate: "asc" },
  });
  return {
    types: types.map((t) => {
      const rates = t.rooms.map((r) => Number(r.nightlyRate));
      return {
        id: t.id, name: t.name, description: t.description ?? t.rooms[0]?.description, maxOccupancy: t.maxOccupancy, bedConfiguration: t.bedConfiguration,
        nightlyFrom: Math.min(...rates).toFixed(2), shortStay: s.shortStay.enabled && t.rooms.some((r) => r.allowShortStay),
        images: t.rooms.flatMap((r) => r.images.map((i) => ({ path: i.path, caption: i.caption }))),
        amenities: [...new Set(t.rooms.flatMap((r) => r.amenities.map((a) => a.amenity.name)))],
      };
    }),
  };
}));

const stayQuery = (src: Record<string, unknown>) => z.object({
  roomTypeId: zReq("Room type"), stayType: z.enum(["NIGHT", "SHORT"]), date: zDate, time: z.string().regex(/^\d{2}:\d{2}$/, "Choose a time"),
  nights: z.coerce.number().int().optional(), hours: z.coerce.number().int().optional(),
}).parse(src);

/** Price for the form (room type + stay). */
publicRoutes.get("/request-quote", h(async (req) => {
  const { quote, departure } = await quoteForType(prisma, stayQuery(req.query as Record<string, unknown>));
  return { quote, departure };
}));

const requestSchema = z.object({
  fullName: zReq("Your name", 120).refine((v) => v.trim().split(/\s+/).length >= 2, "Enter your first and last name"),
  phone: zPhone, email: z.string().trim().toLowerCase().email("Enter a valid email").optional().or(z.literal("")).transform((v) => v || null),
  address: zReq("Address", 300), company: zOpt(150), nextOfKinName: zReq("Next of kin name", 120), nextOfKinPhone: zPhone,
  adults: zInt(1, 10, "Adults"), children: zInt(0, 10, "Children"), specialRequests: zOpt(1000),
  paymentMethod: z.enum(["TRANSFER", "CASH"], { message: "Choose how you will pay" }), transferRef: zOpt(80), payerName: zOpt(120),
  acceptPolicies: zBool.refine((v) => v, "Please accept the hotel policies"),
  password: z.string().optional(),
});

/** The booking form. Optional password creates an account for faster booking next time. */
publicRoutes.post("/booking-requests", submitLimiter, form, h(async (req, res) => {
  const raw = body(req);
  const d = requestSchema.parse(raw);
  const stay = stayQuery(raw);
  const me = await getGuest(req);
  if (!me && d.password) {
    if (!d.email) throw new AppError("Enter your email address to create an account.");
    const [firstName, ...rest] = d.fullName.trim().split(/\s+/);
    const { user } = await registerGuest({ firstName, lastName: rest.join(" "), email: d.email, phone: d.phone, password: d.password }, meta(req));
    await createSession(req, res, user.id, "GUEST");
    const g = await prisma.guest.findUniqueOrThrow({ where: { userId: user.id } });
    const proofPath = await saveUpload(files(req).proof?.[0], "proofs", { allowPdf: true });
    const r = await submitRequest({ userId: user.id, name: d.fullName, role: "guest", type: "GUEST", ...meta(req) }, { ...d, ...stay, proofPath }, g.id);
    return { ok: true, message: "Booking form sent. Your account is ready too.", data: { reference: r.request.reference, link: r.link } };
  }
  const proofPath = await saveUpload(files(req).proof?.[0], "proofs", { allowPdf: true });
  const actor = me ? me.actor : { userId: null, name: d.fullName, role: "public", type: "GUEST" as const, ...meta(req) };
  const r = await submitRequest(actor, { ...d, ...stay, proofPath }, me?.guestId ?? null);
  return { ok: true, message: "Booking form sent.", data: { reference: r.request.reference, link: r.link } };
}));

async function byLink(req: Parameters<typeof q>[0]) {
  const r = await findByToken(String(req.params.ref), q(req, "t") ?? String((req.body as Record<string, unknown>)?.t ?? ""));
  if (!r) throw new NotFound("Booking");
  return r;
}

publicRoutes.get("/booking-requests/:ref", h(async (req) => ({ booking: await guestView((await byLink(req)).id) })));

publicRoutes.post("/booking-requests/:ref/transfer", submitLimiter, form, h(async (req) => {
  const r = await byLink(req);
  const d = z.object({ transferRef: zReq("Transfer reference", 80), payerName: zOpt(120) }).parse(body(req));
  const proofPath = await saveUpload(files(req).proof?.[0], "proofs", { allowPdf: true });
  await addTransferDetails(r.id, { ...d, proofPath });
  return "Thank you. The front desk will confirm your transfer and allocate your room.";
}));

publicRoutes.post("/booking-requests/:ref/cancel", form, h(async (req) => {
  await cancelByGuest((await byLink(req)).id);
  return "Your booking form has been cancelled.";
}));

publicRoutes.post("/booking-lookup", submitLimiter, form, h(async (req) => {
  const d = z.object({ reference: zReq("Reference", 20), phone: zPhone }).parse(body(req));
  return { ok: true, data: { redirect: await lookupLink(d.reference, d.phone) } };
}));

publicRoutes.get("/reviews", h(async () => ({
  reviews: await prisma.review.findMany({ where: { isPublished: true, isVerifiedStay: true }, select: { id: true, rating: true, title: true, body: true, createdAt: true, staffResponse: true, guest: { select: { firstName: true } } }, orderBy: { createdAt: "desc" }, take: 6 }),
})));

publicRoutes.get("/setup-status", h(async () => ({ needsSetup: (await prisma.user.count({ where: { type: "STAFF" } })) === 0 })));

