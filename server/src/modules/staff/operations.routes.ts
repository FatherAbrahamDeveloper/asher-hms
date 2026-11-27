import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/db";
import { audit } from "../../lib/audit";
import { AppError } from "../../lib/errors";
import { zBool, zDate, zInt, zMoney, zOpt, zOptDate, zReq } from "../../lib/validation";
import { staff } from "../../core/auth";
import { NotFound, body, files, form, found, h, q } from "../../core/http";
import { roomBoard } from "../../services/availability";
import { addAmenity, createRoom, setRoomActive, updateRoom, upsertRoomType } from "../../services/admin";
import {
  assignHousekeepingTask, blockRoom, completeHousekeepingTask, createHousekeepingTask, createTicket, inspectRoom, MAINTENANCE_CATEGORIES,
  releaseBlock, startHousekeepingTask, updateServiceRequest, updateTicket,
} from "../../services/operations";
import { assignConversation, markConversationRead, respondToReview, sendMessage } from "../../services/crm";
import { saveUpload } from "../../services/files";
import { staffWith } from "../../services/staff-lookup";
import type { Prisma } from "@/generated/prisma/client";

export const operations = Router();

// ───────── Rooms ─────────
operations.get("/rooms", h(async (req) => {
  await staff(req, "rooms.view", "rooms.manage");
  return { board: await roomBoard() };
}));

operations.get("/rooms/meta", h(async (req) => {
  await staff(req, "rooms.view", "rooms.manage", "rooms.rates");
  const [types, amenities] = await Promise.all([
    prisma.roomType.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { rooms: true } } } }),
    prisma.amenity.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { rooms: true } } } }),
  ]);
  return { types, amenities };
}));

operations.get("/rooms/:id", h(async (req) => {
  await staff(req, "rooms.view", "rooms.manage");
  const id = String(req.params.id);
  const room = found(await prisma.room.findUnique({
    where: { id },
    include: {
      roomType: true, amenities: true, images: { orderBy: { sortOrder: "asc" } },
      blocks: { orderBy: { createdAt: "desc" }, take: 20, include: { ticket: true } },
      reservations: { orderBy: { startAt: "desc" }, take: 30, include: { guest: { select: { firstName: true, lastName: true } } } },
      housekeepingTasks: { orderBy: { createdAt: "desc" }, take: 30 },
      inspections: { orderBy: { createdAt: "desc" }, take: 20 },
      maintenance: { orderBy: { createdAt: "desc" }, take: 30 },
    },
  }), "Room");
  const live = (await roomBoard()).find((b) => b.room.id === id);
  return { room, status: live?.status ?? "AVAILABLE" };
}));

const roomSchema = z.object({
  number: zReq("Room number", 10), roomTypeId: zReq("Room type"), floor: zOpt(10), name: zOpt(80), description: zOpt(3000), nightlyRate: zMoney,
  maxOccupancy: zInt(1, 20, "Max occupancy"), bedConfiguration: zOpt(100), amenityIds: z.array(z.string()), sortOrder: z.coerce.number().int().optional(), allowShortStay: zBool,
});

operations.post("/rooms", form, h(async (req) => {
  const s = await staff(req, "rooms.manage");
  if (!s.can("rooms.rates")) throw new AppError("Setting a room rate requires the room-rates permission.");
  const room = await createRoom(s.actor, roomSchema.parse(body(req, ["amenityIds"])));
  return { ok: true, message: `Room ${room.number} created. It must be cleaned and inspected before first use.`, data: { id: room.id, redirect: `/manage/rooms/${room.id}` } };
}));

operations.post("/rooms/:id", form, h(async (req) => {
  const s = await staff(req, "rooms.manage", "rooms.rates");
  const id = String(req.params.id);
  const d = roomSchema.parse(body(req, ["amenityIds"]));
  if (!s.can("rooms.manage")) {
    const room = await prisma.room.findUniqueOrThrow({ where: { id }, include: { amenities: true } });
    await updateRoom(s.actor, id, { number: room.number, roomTypeId: room.roomTypeId, floor: room.floor, name: room.name, description: room.description, nightlyRate: d.nightlyRate, maxOccupancy: room.maxOccupancy, bedConfiguration: room.bedConfiguration, amenityIds: room.amenities.map((a) => a.amenityId), sortOrder: room.sortOrder, allowShortStay: room.allowShortStay }, true);
  } else await updateRoom(s.actor, id, d, s.can("rooms.rates"));
  return "Room saved.";
}));

operations.post("/rooms/:id/active", form, h(async (req) => {
  const s = await staff(req, "rooms.manage");
  const d = z.object({ active: zBool, reason: zReq("Reason", 500) }).parse(body(req));
  await setRoomActive(s.actor, String(req.params.id), d.active, d.reason);
  return d.active ? "Room activated." : "Room deactivated.";
}));

operations.post("/rooms/:id/images", form, h(async (req) => {
  const s = await staff(req, "rooms.manage");
  const roomId = String(req.params.id);
  const list = files(req).images ?? [];
  if (!list.length) throw new AppError("Choose at least one image.");
  const max = await prisma.roomImage.aggregate({ where: { roomId }, _max: { sortOrder: true } });
  let order = (max._max.sortOrder ?? -1) + 1;
  for (const f of list) {
    const path = await saveUpload(f, "rooms");
    if (!path) continue;
    await prisma.$transaction(async (tx) => {
      const img = await tx.roomImage.create({ data: { roomId, path, caption: (body(req).caption as string) || null, sortOrder: order++ } });
      await audit(tx, s.actor, { action: "room.image_add", module: "rooms", recordType: "RoomImage", recordId: img.id, newValues: { roomId } });
    });
  }
  return `${list.length} image(s) uploaded.`;
}));

operations.post("/room-images/:id", form, h(async (req) => {
  const s = await staff(req, "rooms.manage");
  const id = String(req.params.id), op = String(body(req).op);
  await prisma.$transaction(async (tx) => {
    const img = await tx.roomImage.findUniqueOrThrow({ where: { id } });
    if (op === "delete") {
      await tx.roomImage.delete({ where: { id } });
      await audit(tx, s.actor, { action: "room.image_remove", module: "rooms", recordType: "RoomImage", recordId: id, oldValues: { path: img.path } });
    } else if (op === "cover") {
      await tx.roomImage.updateMany({ where: { roomId: img.roomId }, data: { sortOrder: { increment: 1 } } });
      await tx.roomImage.update({ where: { id }, data: { sortOrder: 0 } });
    }
  });
  return "Updated.";
}));

operations.post("/rooms/:id/block", form, h(async (req) => {
  const s = await staff(req, "rooms.block");
  const d = z.object({ type: z.enum(["MAINTENANCE", "OUT_OF_ORDER"]), startDate: zDate, endDate: zOptDate, reason: zReq("Reason", 500) }).parse(body(req));
  const { affected } = await blockRoom(s.actor, { roomId: String(req.params.id), ...d });
  return affected.length ? `Room blocked. ${affected.length} booking(s) need re-allocation: ${affected.map((a) => a.reference).join(", ")}` : "Room blocked.";
}));

operations.post("/blocks/:id/release", form, h(async (req) => {
  const s = await staff(req, "rooms.return_to_service");
  const d = z.object({ reason: zReq("Reason", 500) }).parse(body(req));
  await releaseBlock(s.actor, String(req.params.id), d.reason);
  return "Room returned to service. Housekeeping must clean and inspect it before the next check-in.";
}));

operations.post("/room-types", form, h(async (req) => {
  const s = await staff(req, "rooms.rates");
  const d = z.object({ id: zOpt(50), name: zReq("Name", 80), description: zOpt(1000), baseRate: zMoney, maxOccupancy: zInt(1, 20, "Max occupancy"), bedConfiguration: zOpt(100) }).parse(body(req));
  await upsertRoomType(s.actor, { ...d, id: d.id ?? undefined });
  return "Room type saved.";
}));

operations.post("/amenities", form, h(async (req) => {
  const s = await staff(req, "rooms.manage");
  const { name } = z.object({ name: zReq("Amenity", 60) }).parse(body(req));
  await addAmenity(s.actor, name);
  return "Amenity added.";
}));

// ───────── Housekeeping ─────────
operations.get("/housekeeping", h(async (req) => {
  const s = await staff(req, "housekeeping.view", "housekeeping.work");
  const mineOnly = !s.can("housekeeping.view") || q(req, "show") === "mine";
  const manage = s.can("housekeeping.manage");
  const open = ["PENDING", "IN_PROGRESS", "COMPLETED", "FAILED_INSPECTION"] as const;
  const [tasks, rooms, team, done] = await Promise.all([
    prisma.housekeepingTask.findMany({ where: { status: { in: [...open] }, ...(mineOnly ? { assignedToId: s.user.id } : {}) }, include: { room: true }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }] }),
    s.can("housekeeping.view") ? prisma.room.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { number: "asc" }], select: { id: true, number: true, housekeepingStatus: true, reservations: { where: { status: "CHECKED_IN" }, select: { id: true } } } }) : [],
    manage ? staffWith("housekeeping.work") : [],
    prisma.housekeepingTask.findMany({ where: { status: { in: ["INSPECTED", "CANCELLED"] }, ...(mineOnly ? { assignedToId: s.user.id } : {}), completedAt: { gte: new Date(Date.now() - 86400_000) } }, include: { room: true }, orderBy: { completedAt: "desc" }, take: 10 }),
  ]);
  return { tasks, rooms, team, done, mineOnly, me: s.user.id };
}));

operations.post("/housekeeping/tasks", form, h(async (req) => {
  const s = await staff(req, "housekeeping.manage");
  const d = z.object({ roomId: zReq("Room"), type: z.enum(["CHECKOUT_CLEAN", "STAYOVER_CLEAN", "GUEST_REQUEST", "DEEP_CLEAN", "RECLEAN"]), priority: z.string().default("NORMAL"), assignedToId: zOpt(50), notes: zOpt(500), markDirty: zBool }).parse(body(req));
  const t = await createHousekeepingTask(s.actor, d);
  return `Task ${t.reference} created.`;
}));

operations.post("/housekeeping/tasks/:id/assign", form, h(async (req) => {
  const s = await staff(req, "housekeeping.manage");
  const d = z.object({ assignedToId: zReq("Staff member") }).parse(body(req));
  await assignHousekeepingTask(s.actor, String(req.params.id), d.assignedToId);
  return "Task assigned.";
}));

operations.post("/housekeeping/tasks/:id/:op", form, h(async (req) => {
  if (!["start", "complete"].includes(String(req.params.op))) throw new AppError("Unknown action.");
  const s = await staff(req, "housekeeping.work", "housekeeping.manage");
  const d = z.object({ notes: zOpt(1000), damageReport: zOpt(1000), missingItems: zOpt(1000) }).parse(body(req));
  const canManage = s.can("housekeeping.manage");
  if (req.params.op === "start") { await startHousekeepingTask(s.actor, String(req.params.id), canManage); return "Cleaning started."; }
  await completeHousekeepingTask(s.actor, String(req.params.id), canManage, { notes: d.notes ?? undefined, damageReport: d.damageReport ?? undefined, missingItems: d.missingItems ?? undefined });
  return "Marked clean — awaiting inspection.";
}));

operations.get("/inspections", h(async (req) => {
  await staff(req, "housekeeping.inspect");
  const [rooms, recent] = await Promise.all([
    prisma.room.findMany({ where: { isActive: true, housekeepingStatus: "CLEAN" }, orderBy: { number: "asc" }, include: { housekeepingTasks: { where: { status: "COMPLETED" }, orderBy: { completedAt: "desc" }, take: 1 } } }),
    prisma.roomInspection.findMany({ orderBy: { createdAt: "desc" }, take: 20, include: { room: true } }),
  ]);
  return { rooms, recent };
}));

operations.post("/inspections", form, h(async (req) => {
  const s = await staff(req, "housekeeping.inspect");
  const o = body(req);
  const d = z.object({ roomId: zReq("Room"), taskId: zOpt(50), result: z.enum(["pass", "fail"]), notes: zOpt(1000) }).parse(o);
  const checklist: Record<string, boolean> = {};
  for (const k of ["bed", "bathroom", "floor", "amenities", "ac", "lights", "towels"]) checklist[k] = o[`chk_${k}`] === "on" || o[`chk_${k}`] === "true";
  await inspectRoom(s.actor, { roomId: d.roomId, taskId: d.taskId, passed: d.result === "pass", notes: d.notes ?? undefined, checklist });
  return d.result === "pass" ? "Room inspected and ready for guests." : "Inspection failed — re-clean task created.";
}));

// ───────── Maintenance ─────────
operations.get("/maintenance", h(async (req) => {
  const s = await staff(req, "maintenance.view", "maintenance.work", "maintenance.report");
  const all = s.can("maintenance.view");
  const mine = !all && s.can("maintenance.work");
  const where: Prisma.MaintenanceTicketWhereInput = {
    ...(q(req, "status") === "closed" ? { status: { in: ["RESOLVED", "CLOSED"] } } : { status: { in: ["OPEN", "ASSIGNED", "IN_PROGRESS", "AWAITING_PARTS"] } }),
    ...(mine ? { assignedToId: s.user.id } : !all ? { reportedById: s.user.id } : {}),
  };
  const [tickets, rooms, techs, counts] = await Promise.all([
    prisma.maintenanceTicket.findMany({ where, include: { room: true, blocks: { where: { releasedAt: null } } }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }], take: 100 }),
    prisma.room.findMany({ orderBy: [{ sortOrder: "asc" }, { number: "asc" }], select: { id: true, number: true } }),
    s.can("maintenance.manage") ? staffWith("maintenance.work") : [],
    all ? prisma.maintenanceTicket.groupBy({ by: ["status"], _count: true }) : [],
  ]);
  return { tickets, rooms, techs, counts: Object.fromEntries(counts.map((c) => [c.status, c._count])), categories: MAINTENANCE_CATEGORIES, scope: mine ? "mine" : all ? "all" : "reported" };
}));

operations.get("/maintenance/:id", h(async (req) => {
  const s = await staff(req, "maintenance.view", "maintenance.work", "maintenance.report");
  const t = found(await prisma.maintenanceTicket.findUnique({ where: { id: String(req.params.id) }, include: { room: true, updates: { orderBy: { createdAt: "desc" } }, blocks: true } }), "Ticket");
  if (!s.can("maintenance.view") && t.assignedToId !== s.user.id && t.reportedById !== s.user.id) throw new NotFound("Ticket");
  return { ticket: t, techs: s.can("maintenance.manage") ? await staffWith("maintenance.work") : [] };
}));

operations.post("/maintenance", form, h(async (req) => {
  const s = await staff(req, "maintenance.report", "maintenance.manage");
  const d = z.object({ roomId: zOpt(50), category: zReq("Category", 60), description: zReq("Description", 2000), priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]), block: z.enum(["", "MAINTENANCE", "OUT_OF_ORDER"]).optional(), assignedToId: zOpt(50) }).parse(body(req));
  const t = await createTicket(s.actor, { ...d, block: d.block ? d.block : null, canBlock: s.can("rooms.block"), canAssign: s.can("maintenance.manage") });
  return { ok: true, message: `Ticket ${t.reference} created.`, data: { id: t.id, redirect: s.can("maintenance.view") ? `/manage/maintenance/${t.id}` : undefined } };
}));

operations.post("/maintenance/:id", form, h(async (req) => {
  const s = await staff(req, "maintenance.work", "maintenance.manage");
  const d = z.object({ status: z.enum(["", "OPEN", "ASSIGNED", "IN_PROGRESS", "AWAITING_PARTS", "RESOLVED", "CLOSED"]).optional(), note: zOpt(2000), assignedToId: zOpt(50), resolution: zOpt(2000), priority: z.enum(["", "LOW", "NORMAL", "HIGH", "URGENT"]).optional() }).parse(body(req));
  await updateTicket(s.actor, String(req.params.id), { status: d.status || undefined, note: d.note ?? undefined, assignedToId: d.assignedToId ?? undefined, resolution: d.resolution ?? undefined, priority: d.priority || undefined }, { manage: s.can("maintenance.manage") });
  return "Ticket updated.";
}));

// ───────── Guest service requests ─────────
operations.get("/service-requests", h(async (req) => {
  const s = await staff(req, "services.view");
  const text = q(req, "q");
  const where: Prisma.ServiceRequestWhereInput = {
    ...(q(req, "status") === "closed" ? { status: { in: ["COMPLETED", "CANCELLED"] } } : { status: { in: ["OPEN", "ASSIGNED", "IN_PROGRESS"] } }),
    ...(text ? { OR: [{ reference: { contains: text, mode: "insensitive" } }, { room: { number: text } }, { category: { contains: text, mode: "insensitive" } }] } : {}),
  };
  const [requests, team] = await Promise.all([
    prisma.serviceRequest.findMany({ where, include: { guest: { select: { firstName: true, lastName: true } }, room: true, reservation: { select: { id: true, reference: true } } }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }], take: 100 }),
    s.can("services.manage") ? prisma.user.findMany({ where: { type: "STAFF", isActive: true }, orderBy: { firstName: "asc" }, select: { id: true, firstName: true, lastName: true, jobTitle: true } }) : [],
  ]);
  return { requests, team };
}));

operations.post("/service-requests/:id", form, h(async (req) => {
  const s = await staff(req, "services.manage");
  const d = z.object({ status: z.enum(["", "ASSIGNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]).optional(), assignedToId: zOpt(50), completionNotes: zOpt(1000), priority: z.enum(["", "LOW", "NORMAL", "HIGH", "URGENT"]).optional() }).parse(body(req));
  await updateServiceRequest(s.actor, String(req.params.id), { status: d.status || undefined, assignedToId: d.assignedToId, completionNotes: d.completionNotes ?? undefined, priority: d.priority || undefined });
  return "Request updated; guest notified.";
}));

// ───────── Messaging ─────────
operations.get("/conversations", h(async (req) => {
  const s = await staff(req, "messages.view");
  const f = q(req, "filter");
  const where: Prisma.ConversationWhereInput = {
    ...(f === "closed" ? { isClosed: true } : { isClosed: false }),
    ...(f === "mine" ? { assignedToId: s.user.id } : f === "unassigned" ? { assignedToId: null } : {}),
  };
  return { conversations: await prisma.conversation.findMany({ where, include: { guest: { select: { firstName: true, lastName: true } }, messages: { orderBy: { createdAt: "desc" }, take: 1 }, _count: { select: { messages: { where: { fromGuest: true, readAt: null } } } } }, orderBy: { lastMessageAt: "desc" }, take: 100 }) };
}));

operations.get("/conversations/:id", h(async (req) => {
  const s = await staff(req, "messages.view");
  const c = found(await prisma.conversation.findUnique({ where: { id: String(req.params.id) }, include: { guest: { select: { id: true, firstName: true, lastName: true, phone: true, email: true, reservations: { where: { status: { in: ["CHECKED_IN", "CONFIRMED", "PENDING"] } }, include: { room: true }, take: 3, orderBy: { startAt: "asc" } } } }, messages: { orderBy: { createdAt: "asc" } } } }), "Conversation");
  await markConversationRead(c.id, false);
  return { conversation: c, team: s.can("messages.reply") ? await staffWith("messages.reply") : [] };
}));

operations.post("/conversations/:id/messages", form, h(async (req) => {
  const s = await staff(req, "messages.reply");
  const d = z.object({ body: z.string().trim().max(2000).default("") }).parse(body(req));
  const attachmentPath = await saveUpload(files(req).attachment?.[0], "messages");
  await sendMessage(s.actor, String(req.params.id), d.body, attachmentPath);
  await markConversationRead(String(req.params.id), false);
  return { ok: true };
}));

operations.post("/conversations/:id/manage", form, h(async (req) => {
  const s = await staff(req, "messages.reply");
  const d = z.object({ assignedToId: zOpt(50), op: z.enum(["assign", "close", "reopen"]) }).parse(body(req));
  await assignConversation(s.actor, String(req.params.id), d.op === "assign" ? d.assignedToId : null, d.op === "close" ? true : d.op === "reopen" ? false : undefined);
  return "Conversation updated.";
}));

// ───────── Reviews & feedback ─────────
operations.get("/reviews", h(async (req) => {
  await staff(req, "reviews.view");
  const kind = q(req, "kind");
  const [items, agg, complaints] = await Promise.all([
    prisma.review.findMany({ where: kind ? { kind } : {}, include: { guest: { select: { id: true, firstName: true, lastName: true } }, reservation: { select: { reference: true } } }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.review.aggregate({ where: { kind: "REVIEW" }, _avg: { rating: true }, _count: true }),
    prisma.review.count({ where: { kind: "COMPLAINT", staffResponse: null } }),
  ]);
  return { items, average: agg._avg.rating, count: agg._count, unanswered: complaints };
}));

operations.post("/reviews/:id", form, h(async (req) => {
  const s = await staff(req, "reviews.manage");
  const d = z.object({ response: zOpt(2000), publish: z.enum(["", "yes", "no"]).optional() }).parse(body(req));
  await respondToReview(s.actor, String(req.params.id), { response: d.response ?? undefined, publish: d.publish === "yes" ? true : d.publish === "no" ? false : undefined });
  return "Saved.";
}));
