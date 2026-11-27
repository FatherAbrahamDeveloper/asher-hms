import nodemailer from "nodemailer";
import { prisma } from "../lib/db";

/** Which external channels are configured. Missing credentials => deliveries are SKIPPED with a reason, never faked. */
export function deliveryConfig() {
  return {
    email: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
    sms: !!process.env.TERMII_API_KEY,
  };
}

async function sendEmail(to: string, subject: string, text: string) {
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transport.sendMail({ from: process.env.SMTP_FROM, to, subject, text });
}

async function sendSms(to: string, body: string) {
  // Termii (Nigerian SMS provider) — https://developers.termii.com
  const res = await fetch("https://api.ng.termii.com/api/sms/send", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to, from: process.env.TERMII_SENDER_ID || "AsherHotel", sms: body, type: "plain", channel: "generic", api_key: process.env.TERMII_API_KEY }),
  });
  if (!res.ok) throw new Error(`SMS provider returned ${res.status}`);
}

export async function processOutbox(limit = 50) {
  const cfg = deliveryConfig();
  const items = await prisma.notificationDelivery.findMany({ where: { status: "QUEUED" }, orderBy: { createdAt: "asc" }, take: limit });
  let sent = 0, skipped = 0, failed = 0;
  for (const item of items) {
    const configured = item.channel === "EMAIL" ? cfg.email : cfg.sms;
    if (!configured) {
      if (item.channel === "EMAIL" && process.env.NODE_ENV !== "production") {
        console.info(`[email:not-configured] to=${item.recipient} subject="${item.subject}"\n${item.body}\n`);
      }
      await prisma.notificationDelivery.update({
        where: { id: item.id },
        data: { status: "SKIPPED", lastError: item.channel === "EMAIL" ? "SMTP_HOST/SMTP_USER/SMTP_PASS not configured" : "TERMII_API_KEY not configured" },
      });
      skipped++;
      continue;
    }
    try {
      if (item.channel === "EMAIL") await sendEmail(item.recipient, item.subject ?? "Notification", item.body);
      else await sendSms(item.recipient, item.body);
      await prisma.notificationDelivery.update({ where: { id: item.id }, data: { status: "SENT", sentAt: new Date(), attempts: { increment: 1 } } });
      sent++;
    } catch (e) {
      const attempts = item.attempts + 1;
      await prisma.notificationDelivery.update({
        where: { id: item.id },
        data: { attempts, lastError: String((e as Error).message).slice(0, 500), status: attempts >= 5 ? "FAILED" : "QUEUED" },
      });
      failed++;
    }
  }
  return { sent, skipped, failed };
}
