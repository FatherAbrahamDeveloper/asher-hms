import { prisma } from "../lib/db";
import { audit, diff, type Actor } from "../lib/audit";
import { AppError } from "../lib/errors";
import { encrypt } from "../lib/crypto";
import { notifyGuest, notifyStaff, notifyUsers } from "../lib/notify";
import type { ConversationChannel } from "@/generated/prisma/enums";

// ───────────────────────── Guests ─────────────────────────

export type GuestInput = {
  firstName: string; lastName: string; email?: string | null; phone?: string | null; address?: string | null; city?: string | null;
  country?: string | null; nationality?: string | null; dateOfBirth?: string | null; idType?: string | null; idNumber?: string | null;
};

export async function createGuest(actor: Actor, input: GuestInput) {
  const email = input.email?.trim().toLowerCase() || null;
  if (email) {
    const dup = await prisma.guest.findFirst({ where: { email: { equals: email, mode: "insensitive" }, deletedAt: null } });
    if (dup) throw new AppError(`A guest with this email already exists (${dup.firstName} ${dup.lastName}). Open their profile instead.`);
  }
  return prisma.$transaction(async (tx) => {
    const g = await tx.guest.create({
      data: {
        firstName: input.firstName.trim(), lastName: input.lastName.trim(), email, phone: input.phone || null, address: input.address || null, city: input.city || null,
        country: input.country || "Nigeria", nationality: input.nationality || null, dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth + "T00:00:00Z") : null,
        idType: input.idType || null, idNumberEncrypted: input.idNumber ? encrypt(input.idNumber) : null,
      },
    });
    await audit(tx, actor, { action: "guest.create", module: "guests", recordType: "Guest", recordId: g.id, newValues: { name: `${g.firstName} ${g.lastName}`, email, phone: g.phone, idRecorded: !!input.idNumber } });
    return g;
  });
}

export async function updateGuest(actor: Actor, guestId: string, input: GuestInput) {
  return prisma.$transaction(async (tx) => {
    const g = await tx.guest.findUniqueOrThrow({ where: { id: guestId } });
    const next = {
      firstName: input.firstName.trim(), lastName: input.lastName.trim(), email: input.email?.trim().toLowerCase() || null, phone: input.phone || null,
      address: input.address || null, city: input.city || null, country: input.country || null, nationality: input.nationality || null, idType: input.idType || g.idType,
    };
    const { oldValues, newValues, changed } = diff(g as unknown as Record<string, unknown>, next);
    await tx.guest.update({ where: { id: guestId }, data: { ...next, dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth + "T00:00:00Z") : g.dateOfBirth, ...(input.idNumber ? { idNumberEncrypted: encrypt(input.idNumber) } : {}) } });
    if (changed || input.idNumber) await audit(tx, actor, { action: "guest.update", module: "guests", recordType: "Guest", recordId: guestId, oldValues, newValues: { ...newValues, ...(input.idNumber ? { idNumber: "[updated]" } : {}) } });
  });
}

export async function setGuestFlags(actor: Actor, guestId: string, flags: { isVip?: boolean; isBlacklisted?: boolean }, reason: string) {
  if (!reason?.trim()) throw new AppError("A reason is required.");
  return prisma.$transaction(async (tx) => {
    const g = await tx.guest.findUniqueOrThrow({ where: { id: guestId } });
    await tx.guest.update({ where: { id: guestId }, data: flags });
    await audit(tx, actor, { action: "guest.flags", module: "guests", recordType: "Guest", recordId: guestId, oldValues: { isVip: g.isVip, isBlacklisted: g.isBlacklisted }, newValues: flags, reason });
  });
}

export async function addGuestNote(actor: Actor, guestId: string, body: string) {
  return prisma.$transaction(async (tx) => {
    const n = await tx.guestNote.create({ data: { guestId, body, authorId: actor.userId!, authorName: actor.name } });
    await audit(tx, actor, { action: "guest.note_add", module: "guests", recordType: "Guest", recordId: guestId, newValues: { noteId: n.id } });
  });
}

export async function addGuestPreference(actor: Actor, guestId: string, category: string, value: string) {
  return prisma.$transaction(async (tx) => {
    await tx.guestPreference.create({ data: { guestId, category, value } });
    await audit(tx, actor, { action: "guest.preference_add", module: "guests", recordType: "Guest", recordId: guestId, newValues: { category, value } });
  });
}

export async function removeGuestPreference(actor: Actor, prefId: string) {
  return prisma.$transaction(async (tx) => {
    const p = await tx.guestPreference.findUniqueOrThrow({ where: { id: prefId } });
    if (actor.type === "GUEST" && p.guestId !== actor.guestId) throw new AppError("Not found.");
    await tx.guestPreference.delete({ where: { id: prefId } });
    await audit(tx, actor, { action: "guest.preference_remove", module: "guests", recordType: "Guest", recordId: p.guestId, oldValues: { category: p.category, value: p.value } });
  });
}

// ───────────────────────── Messaging ─────────────────────────

export async function startConversation(actor: Actor, guestId: string, input: { channel: ConversationChannel; subject: string; body: string; attachmentPath?: string | null }) {
  return prisma.$transaction(async (tx) => {
    const c = await tx.conversation.create({ data: { guestId, channel: input.channel, subject: input.subject, lastMessageAt: new Date() } });
    await tx.message.create({ data: { conversationId: c.id, fromGuest: true, senderId: actor.userId!, senderName: actor.name, body: input.body, attachmentPath: input.attachmentPath ?? null } });
    await audit(tx, actor, { action: "message.conversation_start", module: "messaging", recordType: "Conversation", recordId: c.id, newValues: { channel: input.channel, subject: input.subject } });
    await notifyStaff(tx, ["messages.reply"], { category: "message", priority: "HIGH", title: `New message: ${input.subject}`, body: `${actor.name}: ${input.body.slice(0, 140)}`, link: `/manage/messages/${c.id}`, dedupeKey: `conv:${c.id}` });
    return c;
  });
}

export async function sendMessage(actor: Actor, conversationId: string, body: string, attachmentPath?: string | null) {
  if (!body.trim() && !attachmentPath) throw new AppError("Write a message.");
  return prisma.$transaction(async (tx) => {
    const c = await tx.conversation.findUniqueOrThrow({ where: { id: conversationId }, include: { guest: true } });
    const fromGuest = actor.type === "GUEST";
    if (fromGuest && c.guestId !== actor.guestId) throw new AppError("Conversation not found.");
    if (c.isClosed && fromGuest) await tx.conversation.update({ where: { id: c.id }, data: { isClosed: false } });
    const m = await tx.message.create({ data: { conversationId: c.id, fromGuest, senderId: actor.userId!, senderName: fromGuest ? actor.name : `${actor.name} (${c.channel === "CONCIERGE" ? "Concierge" : "Front Desk"})`, body, attachmentPath: attachmentPath ?? null } });
    const updates: Record<string, unknown> = { lastMessageAt: new Date() };
    if (!fromGuest && !c.assignedToId) { updates.assignedToId = actor.userId; updates.assignedToName = actor.name; }
    await tx.conversation.update({ where: { id: c.id }, data: updates });
    await audit(tx, actor, { action: "message.send", module: "messaging", recordType: "Message", recordId: m.id, newValues: { conversation: c.id, fromGuest, attachment: !!attachmentPath } });
    if (fromGuest) {
      if (c.assignedToId) await notifyUsers(tx, [c.assignedToId], { category: "message", title: `Reply from ${actor.name}`, body: body.slice(0, 140), link: `/manage/messages/${c.id}`, dedupeKey: `msg:${m.id}` });
      else await notifyStaff(tx, ["messages.reply"], { category: "message", title: `Message from ${actor.name}`, body: body.slice(0, 140), link: `/manage/messages/${c.id}`, dedupeKey: `msg:${m.id}` });
    } else {
      await notifyGuest(tx, c.guestId, { category: "message", title: "New reply from the hotel", body: body.slice(0, 160), link: `/account/messages/${c.id}`, dedupeKey: `msg:${m.id}`, email: true });
    }
    return m;
  });
}

/** Mark the other side's messages as read. */
export async function markConversationRead(conversationId: string, viewerIsGuest: boolean) {
  await prisma.message.updateMany({ where: { conversationId, fromGuest: !viewerIsGuest, readAt: null }, data: { readAt: new Date() } });
}

export async function assignConversation(actor: Actor, conversationId: string, staffId: string | null, close?: boolean) {
  return prisma.$transaction(async (tx) => {
    const c = await tx.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    const data: Record<string, unknown> = {};
    if (staffId) {
      const u = await tx.user.findFirst({ where: { id: staffId, type: "STAFF", isActive: true } });
      if (!u) throw new AppError("Staff member not found.");
      data.assignedToId = u.id; data.assignedToName = `${u.firstName} ${u.lastName}`;
      await notifyUsers(tx, [u.id], { category: "message", title: `Conversation assigned: ${c.subject}`, body: "A guest conversation has been assigned to you.", link: `/manage/messages/${c.id}`, dedupeKey: `conv-assign:${c.id}:${u.id}` });
    }
    if (close !== undefined) data.isClosed = close;
    await tx.conversation.update({ where: { id: c.id }, data });
    await audit(tx, actor, { action: close ? "message.conversation_close" : close === false ? "message.conversation_reopen" : "message.conversation_assign", module: "messaging", recordType: "Conversation", recordId: c.id, oldValues: { assignedTo: c.assignedToName, isClosed: c.isClosed }, newValues: data });
  });
}

// ───────────────────────── Reviews & feedback ─────────────────────────

export async function submitFeedback(actor: Actor, input: { kind: "REVIEW" | "COMPLAINT" | "SUGGESTION"; reservationId?: string | null; rating?: number | null; serviceRatings?: Record<string, number>; title?: string; body: string }) {
  return prisma.$transaction(async (tx) => {
    let verified = false;
    if (input.kind === "REVIEW") {
      if (!input.reservationId) throw new AppError("Choose the stay you are reviewing.");
      const r = await tx.reservation.findUniqueOrThrow({ where: { id: input.reservationId }, include: { review: true } });
      if (r.guestId !== actor.guestId) throw new AppError("Stay not found.");
      if (r.status !== "CHECKED_OUT") throw new AppError("Reviews can be submitted after you check out.");
      if (r.review) throw new AppError("You have already reviewed this stay.");
      if (!input.rating || input.rating < 1 || input.rating > 5) throw new AppError("Give an overall rating from 1 to 5.");
      verified = true;
    }
    const review = await tx.review.create({
      data: { guestId: actor.guestId!, reservationId: input.kind === "REVIEW" ? input.reservationId : null, kind: input.kind, rating: input.kind === "REVIEW" ? input.rating : null, serviceRatings: input.serviceRatings ?? undefined, title: input.title || null, body: input.body, isVerifiedStay: verified },
    });
    await audit(tx, actor, { action: `feedback.${input.kind.toLowerCase()}`, module: "feedback", recordType: "Review", recordId: review.id, newValues: { kind: input.kind, rating: input.rating ?? null } });
    await notifyStaff(tx, ["reviews.view"], { category: "service", priority: input.kind === "COMPLAINT" ? "HIGH" : "NORMAL", title: input.kind === "COMPLAINT" ? `Guest complaint: ${input.title || "No title"}` : input.kind === "REVIEW" ? `New ${input.rating}★ review` : "New guest suggestion", body: `${actor.name}: ${input.body.slice(0, 160)}`, link: "/manage/reviews", dedupeKey: `review:${review.id}` });
    return review;
  });
}

export async function respondToReview(actor: Actor, reviewId: string, input: { response?: string; publish?: boolean }) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.review.findUniqueOrThrow({ where: { id: reviewId } });
    if (input.publish && !r.isVerifiedStay) throw new AppError("Only verified-stay reviews can be published.");
    await tx.review.update({ where: { id: reviewId }, data: { staffResponse: input.response ?? r.staffResponse, isPublished: input.publish ?? r.isPublished } });
    await audit(tx, actor, { action: "feedback.respond", module: "feedback", recordType: "Review", recordId: reviewId, oldValues: { isPublished: r.isPublished, staffResponse: r.staffResponse }, newValues: input });
    if (input.response && input.response !== r.staffResponse) await notifyGuest(tx, r.guestId, { category: "service", title: "The hotel responded to your feedback", body: input.response.slice(0, 160), link: "/account/reviews", dedupeKey: `review-resp:${r.id}:${input.response.length}`, email: true });
  });
}
