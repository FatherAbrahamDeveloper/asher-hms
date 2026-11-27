import { Router } from "express";
import crypto from "node:crypto";
import { prisma } from "../lib/db";
import { getSettings } from "../lib/settings";
import { auditStandalone } from "../lib/audit";
import { getGuest, getStaff } from "../core/auth";
import { NotFound, found, h } from "../core/http";
import { readStoredFile, resolveStoredPath } from "../services/files";
import { runDueJobs } from "../services/jobs";
import { confirmCardPayment } from "../services/billing";
import { AppError } from "../lib/errors";

export const shared = Router();

/** Printable documents (invoice / receipt) for staff with finance access or the guest who owns them. */
shared.get("/documents/invoice/:id", h(async (req) => {
  const inv = found(await prisma.invoice.findUnique({ where: { id: String(req.params.id) }, include: { items: true, reservation: { include: { guest: true, room: true } } } }), "Invoice");
  const [s, g] = [await getStaff(req), await getGuest(req)];
  if (!(s?.can("payments.view") || s?.can("frontdesk.checkout") || g?.guestId === inv.reservation.guestId)) throw new NotFound("Invoice");
  const { idNumberEncrypted: _x, ...guest } = inv.reservation.guest;
  return { invoice: { ...inv, reservation: { ...inv.reservation, guest } }, hotel: (await getSettings()).hotel, finance: (await getSettings()).finance };
}));

shared.get("/documents/receipt/:paymentId", h(async (req) => {
  const p = found(await prisma.payment.findUnique({ where: { id: String(req.params.paymentId) }, include: { receipt: true, guest: { select: { firstName: true, lastName: true, id: true } }, reservation: { include: { room: true } } } }), "Receipt");
  if (!p.receipt) throw new AppError("This payment has no receipt yet.");
  const [s, g] = [await getStaff(req), await getGuest(req)];
  if (!(s?.can("payments.view") || s?.can("payments.record") || g?.guestId === p.guestId)) throw new NotFound("Receipt");
  return { payment: p, hotel: (await getSettings()).hotel };
}));

/** Authorised file delivery. Room images and branding are public; everything else is checked per request. */
shared.get("/files/:kind/:name", async (req, res) => {
  const rel = `${req.params.kind}/${req.params.name}`;
  const f = resolveStoredPath(rel);
  if (!f) return res.status(404).send("Not found");
  let allowed = f.kind === "rooms" || f.kind === "branding";
  if (!allowed) {
    const [staff, guest] = [await getStaff(req), await getGuest(req)];
    if (f.kind === "ids") {
      if (staff?.can("guests.view_sensitive")) { allowed = true; await auditStandalone(staff.actor, { action: "guest.id_document_viewed", module: "guests", recordType: "File", recordId: rel }); }
      else if (guest) allowed = !!(await prisma.guest.findFirst({ where: { id: guest.guestId, idDocumentPath: rel } }));
    } else if (f.kind === "proofs") {
      allowed = !!staff?.can("payments.view") || (!!guest && !!(await prisma.payment.findFirst({ where: { guestId: guest.guestId, proofPath: rel } })));
    } else if (f.kind === "messages") {
      allowed = !!staff?.can("messages.view") || (!!guest && !!(await prisma.message.findFirst({ where: { attachmentPath: rel, conversation: { guestId: guest.guestId } } })));
    }
  }
  if (!allowed) return res.status(403).send("Forbidden");
  const file = await readStoredFile(rel);
  if (!file) return res.status(404).send("Not found");
  {
    const data = file.data;
    res.set({ "Content-Type": f.mime, "Cache-Control": allowed && (f.kind === "rooms" || f.kind === "branding") ? "public, max-age=86400" : "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" });
    res.send(data);
  }
});

/** Background jobs: call every minute with header  Authorization: Bearer <CRON_SECRET>. */
shared.all("/cron", h(async (req) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.get("authorization") !== `Bearer ${secret}`) throw new AppError("Unauthorized");
  return { ok: true, results: await runDueJobs(req.query.force === "1") };
}));

/** Paystack redirects the guest here; we verify server-to-server, then send them back to the client. */
shared.get("/payments/paystack/callback", async (req, res) => {
  const ref = String(req.query.reference ?? req.query.trxref ?? "");
  const app = process.env.APP_URL ?? "";
  if (!ref) return res.redirect(`${app}/account/payments`);
  const payment = await confirmCardPayment(ref).catch(() => null);
  const r = payment?.reservationId ? await prisma.reservation.findUnique({ where: { id: payment.reservationId } }) : null;
  res.redirect(r ? `${app}/account/reservations/${r.reference}/pay?status=${payment?.status === "VERIFIED" ? "success" : "pending"}` : `${app}/account/payments`);
});

/** Paystack webhook (HMAC-SHA512 signature verified against the raw body). */
shared.post("/payments/paystack/webhook", async (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return res.status(503).send("Not configured");
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from("");
  const sig = req.get("x-paystack-signature") ?? "";
  const expected = crypto.createHmac("sha512", secret).update(raw).digest("hex");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return res.status(401).send("Invalid signature");
  const event = JSON.parse(raw.toString("utf8")) as { event: string; data?: { reference?: string } };
  if (event.data?.reference && ["charge.success", "charge.failed"].includes(event.event)) await confirmCardPayment(event.data.reference);
  res.send("ok");
});
