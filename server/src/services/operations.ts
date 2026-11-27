import { prisma, type Tx } from "../lib/db";
import { audit, type Actor } from "../lib/audit";
import { AppError } from "../lib/errors";
import { makeRef } from "../lib/refs";
import { notifyStaff, notifyUsers, notifyGuest } from "../lib/notify";
import { addDays, fmtDate, toDbDate, todayLagos, type DateStr } from "../lib/dates";
import { getSettings } from "../lib/settings";
import { blockOverlapWhere } from "./availability";
import type { BlockType, HousekeepingStatus, HousekeepingTaskType, Priority, TicketStatus } from "@/generated/prisma/enums";

const TX = { timeout: 20_000, maxWait: 10_000 };

async function setHousekeeping(tx: Tx, actor: Actor, roomId: string, to: HousekeepingStatus, reason: string) {
  const room = await tx.room.findUniqueOrThrow({ where: { id: roomId } });
  if (room.housekeepingStatus === to) return room;
  await tx.room.update({ where: { id: roomId }, data: { housekeepingStatus: to } });
  await audit(tx, actor, { action: "room.status_change", module: "rooms", recordType: "Room", recordId: roomId, oldValues: { housekeepingStatus: room.housekeepingStatus }, newValues: { housekeepingStatus: to }, reason });
  return room;
}

// ───────────────────────── Housekeeping ─────────────────────────

export async function createHousekeepingTask(actor: Actor, input: { roomId: string; type: HousekeepingTaskType; priority?: string; assignedToId?: string | null; notes?: string | null; markDirty?: boolean }) {
  return prisma.$transaction(async (tx) => {
    const room = await tx.room.findUniqueOrThrow({ where: { id: input.roomId } });
    const assignee = input.assignedToId ? await tx.user.findFirst({ where: { id: input.assignedToId, type: "STAFF", isActive: true } }) : null;
    const settings = await getSettings(tx);
    const task = await tx.housekeepingTask.create({
      data: {
        reference: makeRef("HK", 6), roomId: room.id, type: input.type, priority: input.priority ?? "NORMAL", notes: input.notes || null, createdById: actor.userId,
        assignedToId: assignee?.id ?? null, assignedToName: assignee ? `${assignee.firstName} ${assignee.lastName}` : null,
        dueAt: new Date(Date.now() + settings.reservations.housekeepingOverdueHours * 3600_000),
      },
    });
    if (input.markDirty) await setHousekeeping(tx, actor, room.id, "DIRTY", `Task ${task.reference}`);
    await audit(tx, actor, { action: "housekeeping.task_create", module: "housekeeping", recordType: "HousekeepingTask", recordId: task.id, newValues: { reference: task.reference, room: room.number, type: input.type, assignedTo: task.assignedToName } });
    if (assignee) await notifyUsers(tx, [assignee.id], { category: "housekeeping", title: `New task: Room ${room.number}`, body: `${input.type.replace(/_/g, " ").toLowerCase()}${input.notes ? ` — ${input.notes}` : ""}`, link: "/manage/housekeeping", dedupeKey: `hk-assign:${task.id}:${assignee.id}` });
    else await notifyStaff(tx, ["housekeeping.manage"], { category: "housekeeping", title: `Housekeeping needed: Room ${room.number}`, body: input.notes || input.type.replace(/_/g, " ").toLowerCase(), link: "/manage/housekeeping", dedupeKey: `hk-task:${task.id}` }, { exclude: actor.userId });
    return task;
  }, TX);
}

export async function assignHousekeepingTask(actor: Actor, taskId: string, assigneeId: string) {
  return prisma.$transaction(async (tx) => {
    const task = await tx.housekeepingTask.findUniqueOrThrow({ where: { id: taskId }, include: { room: true } });
    const u = await tx.user.findFirst({ where: { id: assigneeId, type: "STAFF", isActive: true } });
    if (!u) throw new AppError("Staff member not found or inactive.");
    const name = `${u.firstName} ${u.lastName}`;
    await tx.housekeepingTask.update({ where: { id: taskId }, data: { assignedToId: u.id, assignedToName: name } });
    await audit(tx, actor, { action: "housekeeping.assign", module: "housekeeping", recordType: "HousekeepingTask", recordId: taskId, oldValues: { assignedTo: task.assignedToName }, newValues: { assignedTo: name } });
    await notifyUsers(tx, [u.id], { category: "housekeeping", title: `Assigned: Room ${task.room.number}`, body: `${task.type.replace(/_/g, " ").toLowerCase()} (${task.reference})`, link: "/manage/housekeeping", dedupeKey: `hk-assign:${task.id}:${u.id}` });
  });
}

/** Housekeeping staff may only progress tasks assigned to them unless they can manage housekeeping. */
function assertCanWork(actor: Actor, task: { assignedToId: string | null }, canManage: boolean) {
  if (!canManage && task.assignedToId !== actor.userId) throw new AppError("This task is not assigned to you.");
}

export async function startHousekeepingTask(actor: Actor, taskId: string, canManage: boolean) {
  return prisma.$transaction(async (tx) => {
    const task = await tx.housekeepingTask.findUniqueOrThrow({ where: { id: taskId } });
    assertCanWork(actor, task, canManage);
    if (!["PENDING", "FAILED_INSPECTION"].includes(task.status)) throw new AppError("This task has already started.");
    const occupied = await tx.reservation.findFirst({ where: { roomId: task.roomId, status: "CHECKED_IN" } });
    await tx.housekeepingTask.update({ where: { id: taskId }, data: { status: "IN_PROGRESS", startedAt: new Date(), assignedToId: task.assignedToId ?? actor.userId, assignedToName: task.assignedToName ?? actor.name } });
    if (!occupied) await setHousekeeping(tx, actor, task.roomId, "CLEANING", `Task ${task.reference} started`);
    await audit(tx, actor, { action: "housekeeping.start", module: "housekeeping", recordType: "HousekeepingTask", recordId: taskId, oldValues: { status: task.status }, newValues: { status: "IN_PROGRESS" } });
  });
}

export async function completeHousekeepingTask(actor: Actor, taskId: string, canManage: boolean, input: { notes?: string; damageReport?: string; missingItems?: string }) {
  return prisma.$transaction(async (tx) => {
    const task = await tx.housekeepingTask.findUniqueOrThrow({ where: { id: taskId }, include: { room: true } });
    assertCanWork(actor, task, canManage);
    if (task.status !== "IN_PROGRESS") throw new AppError("Start the task before completing it.");
    await tx.housekeepingTask.update({ where: { id: taskId }, data: { status: "COMPLETED", completedAt: new Date(), notes: [task.notes, input.notes].filter(Boolean).join("\n") || null, damageReport: input.damageReport || null, missingItems: input.missingItems || null } });
    const occupied = await tx.reservation.findFirst({ where: { roomId: task.roomId, status: "CHECKED_IN" } });
    if (!occupied) await setHousekeeping(tx, actor, task.roomId, "CLEAN", `Task ${task.reference} completed`);
    await audit(tx, actor, { action: "housekeeping.complete", module: "housekeeping", recordType: "HousekeepingTask", recordId: taskId, oldValues: { status: "IN_PROGRESS" }, newValues: { status: "COMPLETED", damageReport: input.damageReport || null, missingItems: input.missingItems || null } });
    await notifyStaff(tx, ["housekeeping.inspect"], { category: "housekeeping", title: `Room ${task.room.number} ready for inspection`, body: `${actor.name} completed ${task.reference}.`, link: "/manage/housekeeping/inspections", dedupeKey: `hk-done:${task.id}` }, { exclude: actor.userId });
    if (input.damageReport || input.missingItems) {
      const ticket = await tx.maintenanceTicket.create({ data: { reference: makeRef("MT", 6), roomId: task.roomId, category: "Furniture / damage", description: [input.damageReport && `Damage: ${input.damageReport}`, input.missingItems && `Missing: ${input.missingItems}`].filter(Boolean).join("\n"), priority: "NORMAL", reportedById: actor.userId, reportedByName: actor.name } });
      await audit(tx, actor, { action: "maintenance.create", module: "maintenance", recordType: "MaintenanceTicket", recordId: ticket.id, newValues: { reference: ticket.reference, source: task.reference } });
      await notifyStaff(tx, ["maintenance.manage", "reservations.view"], { category: "maintenance", title: `Damage/missing items reported — Room ${task.room.number}`, body: ticket.description, link: `/manage/maintenance/${ticket.id}`, dedupeKey: `mt-new:${ticket.id}` });
    }
  }, TX);
}

/** Supervisor inspection. Pass → INSPECTED (ready to sell/check in). Fail → DIRTY with an automatic re-clean task. */
export async function inspectRoom(actor: Actor, input: { roomId: string; taskId?: string | null; passed: boolean; notes?: string; checklist?: Record<string, boolean> }) {
  if (!input.passed && !input.notes?.trim()) throw new AppError("Describe what failed inspection.");
  return prisma.$transaction(async (tx) => {
    const room = await tx.room.findUniqueOrThrow({ where: { id: input.roomId } });
    const task = input.taskId ? await tx.housekeepingTask.findUnique({ where: { id: input.taskId } }) : await tx.housekeepingTask.findFirst({ where: { roomId: room.id, status: "COMPLETED" }, orderBy: { completedAt: "desc" } });
    const insp = await tx.roomInspection.create({ data: { roomId: room.id, taskId: task?.id ?? null, inspectorId: actor.userId!, inspectorName: actor.name, passed: input.passed, notes: input.notes || null, checklist: input.checklist ?? undefined } });
    if (task) await tx.housekeepingTask.update({ where: { id: task.id }, data: { status: input.passed ? "INSPECTED" : "FAILED_INSPECTION" } });
    await setHousekeeping(tx, actor, room.id, input.passed ? "INSPECTED" : "DIRTY", input.passed ? "Passed inspection" : `Failed inspection: ${input.notes}`);
    await audit(tx, actor, { action: input.passed ? "housekeeping.inspection_pass" : "housekeeping.inspection_fail", module: "housekeeping", recordType: "RoomInspection", recordId: insp.id, newValues: { room: room.number, passed: input.passed, task: task?.reference }, reason: input.notes || null });
    if (!input.passed) {
      const re = await tx.housekeepingTask.create({ data: { reference: makeRef("HK", 6), roomId: room.id, type: "RECLEAN", priority: "HIGH", notes: `Failed inspection: ${input.notes}`, assignedToId: task?.assignedToId, assignedToName: task?.assignedToName, createdById: actor.userId } });
      await notifyStaff(tx, ["housekeeping.manage"], { category: "housekeeping", priority: "HIGH", title: `Room ${room.number} failed inspection`, body: input.notes ?? "", link: "/manage/housekeeping", dedupeKey: `hk-fail:${insp.id}` }, { exclude: actor.userId, alsoUserIds: [task?.assignedToId] });
      return { inspection: insp, recleanTask: re };
    }
    return { inspection: insp };
  }, TX);
}

// ───────────────────────── Maintenance ─────────────────────────

export const MAINTENANCE_CATEGORIES = ["Plumbing", "Electrical", "Air-conditioning", "Furniture / damage", "Bathroom", "Appliance", "General room maintenance", "Other"];

export async function createTicket(actor: Actor, input: { roomId?: string | null; category: string; description: string; priority: Priority; block?: BlockType | null; assignedToId?: string | null; canBlock: boolean; canAssign: boolean }) {
  return prisma.$transaction(async (tx) => {
    const room = input.roomId ? await tx.room.findUniqueOrThrow({ where: { id: input.roomId } }) : null;
    const assignee = input.assignedToId && input.canAssign ? await tx.user.findFirst({ where: { id: input.assignedToId, type: "STAFF", isActive: true } }) : null;
    const ticket = await tx.maintenanceTicket.create({
      data: {
        reference: makeRef("MT", 6), roomId: room?.id ?? null, category: input.category, description: input.description, priority: input.priority,
        reportedById: actor.userId, reportedByName: actor.name, status: assignee ? "ASSIGNED" : "OPEN",
        assignedToId: assignee?.id ?? null, assignedToName: assignee ? `${assignee.firstName} ${assignee.lastName}` : null,
      },
    });
    await audit(tx, actor, { action: "maintenance.create", module: "maintenance", recordType: "MaintenanceTicket", recordId: ticket.id, newValues: { reference: ticket.reference, room: room?.number, category: input.category, priority: input.priority, block: input.block ?? null } });
    if (room && input.block) {
      if (!input.canBlock) throw new AppError("You do not have permission to block rooms.");
      await blockRoomTx(tx, actor, { roomId: room.id, type: input.block, startDate: todayLagos(), endDate: null, reason: `${ticket.reference}: ${input.category}`, ticketId: ticket.id });
    }
    await notifyStaff(tx, ["maintenance.manage"], {
      category: "maintenance", priority: input.priority === "URGENT" ? "URGENT" : input.priority === "HIGH" ? "HIGH" : "NORMAL",
      title: `${input.priority === "URGENT" ? "URGENT " : ""}Maintenance: ${input.category}${room ? ` — Room ${room.number}` : ""}`, body: input.description.slice(0, 200),
      link: `/manage/maintenance/${ticket.id}`, dedupeKey: `mt-new:${ticket.id}`,
    }, { exclude: actor.userId, alsoUserIds: [assignee?.id] });
    return ticket;
  }, TX);
}

const TICKET_FLOW: Record<TicketStatus, TicketStatus[]> = {
  OPEN: ["ASSIGNED", "IN_PROGRESS", "RESOLVED", "CLOSED"],
  ASSIGNED: ["IN_PROGRESS", "AWAITING_PARTS", "RESOLVED", "OPEN"],
  IN_PROGRESS: ["AWAITING_PARTS", "RESOLVED"],
  AWAITING_PARTS: ["IN_PROGRESS", "RESOLVED"],
  RESOLVED: ["CLOSED", "IN_PROGRESS"],
  CLOSED: [],
};

export async function updateTicket(actor: Actor, ticketId: string, input: { status?: TicketStatus; note?: string; assignedToId?: string | null; resolution?: string; priority?: Priority }, perms: { manage: boolean }) {
  return prisma.$transaction(async (tx) => {
    const t = await tx.maintenanceTicket.findUniqueOrThrow({ where: { id: ticketId }, include: { room: true } });
    if (!perms.manage && t.assignedToId !== actor.userId) throw new AppError("This ticket is not assigned to you.");
    if (!perms.manage && (input.assignedToId !== undefined || input.priority || input.status === "CLOSED")) throw new AppError("Only maintenance supervisors can assign, re-prioritise or close tickets.");
    const data: Record<string, unknown> = {};
    if (input.assignedToId) {
      const u = await tx.user.findFirst({ where: { id: input.assignedToId, type: "STAFF", isActive: true } });
      if (!u) throw new AppError("Technician not found.");
      data.assignedToId = u.id; data.assignedToName = `${u.firstName} ${u.lastName}`;
      if (t.status === "OPEN" && !input.status) data.status = "ASSIGNED";
      await notifyUsers(tx, [u.id], { category: "maintenance", priority: t.priority === "URGENT" ? "URGENT" : "NORMAL", title: `Ticket assigned: ${t.reference}`, body: `${t.category}${t.room ? ` — Room ${t.room.number}` : ""}`, link: `/manage/maintenance/${t.id}`, dedupeKey: `mt-assign:${t.id}:${u.id}` });
    }
    if (input.priority) data.priority = input.priority;
    if (input.status && input.status !== t.status) {
      if (!TICKET_FLOW[t.status].includes(input.status)) throw new AppError(`Cannot move a ticket from ${t.status.replace("_", " ").toLowerCase()} to ${input.status.replace("_", " ").toLowerCase()}.`);
      if (input.status === "RESOLVED" && !(input.resolution || t.resolution)) throw new AppError("Describe the resolution.");
      data.status = input.status;
      if (input.status === "RESOLVED") data.resolvedAt = new Date();
      if (input.status === "CLOSED") data.closedAt = new Date();
    }
    if (input.resolution) data.resolution = input.resolution;
    await tx.maintenanceTicket.update({ where: { id: t.id }, data });
    if (input.note || input.status) await tx.ticketUpdate.create({ data: { ticketId: t.id, body: input.note || `Status changed to ${input.status}`, status: input.status ?? null, authorId: actor.userId!, authorName: actor.name } });
    await audit(tx, actor, { action: "maintenance.update", module: "maintenance", recordType: "MaintenanceTicket", recordId: t.id, oldValues: { status: t.status, assignedTo: t.assignedToName, priority: t.priority }, newValues: { ...data, note: input.note } });
    if (input.status === "RESOLVED") await notifyStaff(tx, ["maintenance.manage", "rooms.return_to_service"], { category: "maintenance", title: `Resolved: ${t.reference}`, body: `${t.category}${t.room ? ` — Room ${t.room.number}` : ""}. ${input.resolution ?? ""}`, link: `/manage/maintenance/${t.id}`, dedupeKey: `mt-resolved:${t.id}` }, { exclude: actor.userId });
  }, TX);
}

// ───────────────────────── Room blocks ─────────────────────────

async function blockRoomTx(tx: Tx, actor: Actor, input: { roomId: string; type: BlockType; startDate: DateStr; endDate: DateStr | null; reason: string; ticketId?: string | null }) {
  if (input.endDate && input.endDate <= input.startDate) throw new AppError("Block end date must be after the start date.");
  const room = await tx.room.findUniqueOrThrow({ where: { id: input.roomId } });
  const block = await tx.roomBlock.create({ data: { roomId: room.id, type: input.type, startDate: toDbDate(input.startDate), endDate: input.endDate ? toDbDate(input.endDate) : null, reason: input.reason, ticketId: input.ticketId ?? null, createdById: actor.userId ?? "system" } });
  if (input.startDate <= todayLagos()) await tx.room.update({ where: { id: room.id }, data: { maintenanceState: input.type === "OUT_OF_ORDER" ? "OUT_OF_ORDER" : "MAINTENANCE" } });
  const affected = await tx.reservation.findMany({ where: { roomId: room.id, status: { in: ["PENDING", "CONFIRMED", "CHECKED_IN"] }, departureDate: { gt: toDbDate(input.startDate) }, ...(input.endDate ? { arrivalDate: { lt: toDbDate(input.endDate) } } : {}) }, select: { id: true, reference: true, status: true } });
  await audit(tx, actor, { action: "room.block", module: "rooms", recordType: "RoomBlock", recordId: block.id, newValues: { room: room.number, type: input.type, from: input.startDate, to: input.endDate, affectedReservations: affected.map((a) => a.reference) }, reason: input.reason });
  await notifyStaff(tx, ["reservations.edit", "rooms.block"], {
    category: "room", priority: affected.length ? "URGENT" : "HIGH", title: `Room ${room.number} blocked (${input.type === "OUT_OF_ORDER" ? "out of order" : "maintenance"})`,
    body: `${input.reason}. From ${fmtDate(input.startDate)}${input.endDate ? ` to ${fmtDate(input.endDate)}` : " until further notice"}.${affected.length ? ` ${affected.length} booking(s) need a new room: ${affected.map((a) => a.reference).join(", ")}` : ""}`,
    link: `/manage/rooms/${room.id}`, dedupeKey: `block:${block.id}`,
  }, { exclude: actor.userId });
  return { block, affected };
}

export async function blockRoom(actor: Actor, input: { roomId: string; type: BlockType; startDate: DateStr; endDate: DateStr | null; reason: string }) {
  if (!input.reason?.trim()) throw new AppError("A reason is required to block a room.");
  return prisma.$transaction((tx) => blockRoomTx(tx, actor, input), TX);
}

/** Return a blocked room to service. The room must then be cleaned and inspected before the next check-in. */
export async function releaseBlock(actor: Actor, blockId: string, reason: string) {
  if (!reason?.trim()) throw new AppError("A reason is required to return a room to service.");
  return prisma.$transaction(async (tx) => {
    const b = await tx.roomBlock.findUniqueOrThrow({ where: { id: blockId }, include: { room: true, ticket: true } });
    if (b.releasedAt) throw new AppError("This block has already been released.");
    if (b.ticket && !["RESOLVED", "CLOSED"].includes(b.ticket.status)) throw new AppError(`Resolve maintenance ticket ${b.ticket.reference} before returning the room to service.`);
    await tx.roomBlock.update({ where: { id: b.id }, data: { releasedAt: new Date(), releasedById: actor.userId } });
    const today = todayLagos();
    const still = await tx.roomBlock.findFirst({ where: { roomId: b.roomId, id: { not: b.id }, ...blockOverlapWhere(today, addDays(today, 1)) } });
    await tx.room.update({ where: { id: b.roomId }, data: { maintenanceState: still ? (still.type === "OUT_OF_ORDER" ? "OUT_OF_ORDER" : "MAINTENANCE") : "OK", housekeepingStatus: "DIRTY" } });
    await tx.housekeepingTask.create({ data: { reference: makeRef("HK", 6), roomId: b.roomId, type: "DEEP_CLEAN", priority: "HIGH", notes: "Returned to service after maintenance — clean and inspect", createdById: actor.userId } });
    await audit(tx, actor, { action: "room.return_to_service", module: "rooms", recordType: "RoomBlock", recordId: b.id, oldValues: { blocked: true, type: b.type }, newValues: { blocked: false, housekeepingStatus: "DIRTY" }, reason });
    await notifyStaff(tx, ["reservations.view", "housekeeping.manage"], { category: "room", title: `Room ${b.room.number} returned to service`, body: `Cleaning and inspection required before the next check-in. ${reason}`, link: `/manage/rooms/${b.roomId}`, dedupeKey: `unblock:${b.id}` }, { exclude: actor.userId });
  }, TX);
}

// ───────────────────────── Guest service requests ─────────────────────────

export const SERVICE_CATEGORIES = ["Room service", "Food and refreshments", "Housekeeping", "Fresh towels", "Extra pillows", "Maintenance assistance", "Front desk assistance", "Laundry", "Other"];

export async function createServiceRequest(actor: Actor, input: { guestId: string; reservationId?: string | null; category: string; description: string; priority?: Priority }) {
  if (!SERVICE_CATEGORIES.includes(input.category)) throw new AppError("Choose a request category.");
  return prisma.$transaction(async (tx) => {
    let roomId: string | null = null, reservationId: string | null = null, roomNo = "";
    if (input.reservationId) {
      const r = await tx.reservation.findUniqueOrThrow({ where: { id: input.reservationId }, include: { room: true } });
      if (r.guestId !== input.guestId) throw new AppError("Reservation not found.");
      if (!["CONFIRMED", "CHECKED_IN", "PENDING"].includes(r.status)) throw new AppError("Requests can only be made for current or upcoming stays.");
      roomId = r.roomId; reservationId = r.id; roomNo = r.room.number;
    }
    const req = await tx.serviceRequest.create({ data: { reference: makeRef("SR", 6), guestId: input.guestId, reservationId, roomId, category: input.category, description: input.description, priority: input.priority ?? "NORMAL" } });
    await audit(tx, actor, { action: "service_request.create", module: "services", recordType: "ServiceRequest", recordId: req.id, newValues: { reference: req.reference, category: input.category, room: roomNo || null } });
    const perms = ["Housekeeping", "Fresh towels", "Extra pillows"].includes(input.category) ? (["services.manage", "housekeeping.manage"] as const) : input.category === "Maintenance assistance" ? (["services.manage", "maintenance.manage"] as const) : (["services.manage"] as const);
    await notifyStaff(tx, [...perms], { category: "service", priority: input.priority === "URGENT" ? "URGENT" : "HIGH", title: `${input.category}${roomNo ? ` — Room ${roomNo}` : ""}`, body: input.description.slice(0, 200), link: `/manage/service-requests?q=${req.reference}`, dedupeKey: `sr-new:${req.id}` }, { exclude: actor.userId });
    await notifyGuest(tx, input.guestId, { category: "service", title: `Request ${req.reference} received`, body: `Your ${input.category.toLowerCase()} request has been received. We'll update you shortly.`, link: "/account/services", dedupeKey: `sr-new:${req.id}`, email: false });
    return req;
  });
}

export async function updateServiceRequest(actor: Actor, id: string, input: { status?: string; assignedToId?: string | null; completionNotes?: string; priority?: Priority }) {
  return prisma.$transaction(async (tx) => {
    const req = await tx.serviceRequest.findUniqueOrThrow({ where: { id } });
    if (["COMPLETED", "CANCELLED"].includes(req.status)) throw new AppError("This request is closed.");
    const data: Record<string, unknown> = {};
    if (input.assignedToId) {
      const u = await tx.user.findFirst({ where: { id: input.assignedToId, type: "STAFF", isActive: true } });
      if (!u) throw new AppError("Staff member not found.");
      data.assignedToId = u.id; data.assignedToName = `${u.firstName} ${u.lastName}`;
      if (req.status === "OPEN") data.status = "ASSIGNED";
      await notifyUsers(tx, [u.id], { category: "service", title: `Request assigned: ${req.reference}`, body: `${req.category}: ${req.description.slice(0, 120)}`, link: `/manage/service-requests?q=${req.reference}`, dedupeKey: `sr-assign:${req.id}:${u.id}` });
    }
    if (input.priority) data.priority = input.priority;
    if (input.status && input.status !== req.status) {
      if (!["ASSIGNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"].includes(input.status)) throw new AppError("Invalid status.");
      if (input.status === "COMPLETED" && !input.completionNotes?.trim()) throw new AppError("Add completion notes.");
      data.status = input.status;
      if (input.status === "COMPLETED") data.completedAt = new Date();
    }
    if (input.completionNotes) data.completionNotes = input.completionNotes;
    await tx.serviceRequest.update({ where: { id }, data });
    await audit(tx, actor, { action: "service_request.update", module: "services", recordType: "ServiceRequest", recordId: id, oldValues: { status: req.status, assignedTo: req.assignedToName }, newValues: data });
    if (data.status) {
      await notifyGuest(tx, req.guestId, { category: "service", title: `Request ${req.reference}: ${String(data.status).replace("_", " ").toLowerCase()}`, body: input.completionNotes || `Your ${req.category.toLowerCase()} request is now ${String(data.status).replace("_", " ").toLowerCase()}.`, link: "/account/services", dedupeKey: `sr-status:${req.id}:${data.status}`, email: false });
    }
  });
}

export async function cancelServiceRequestByGuest(actor: Actor, id: string) {
  return prisma.$transaction(async (tx) => {
    const req = await tx.serviceRequest.findUniqueOrThrow({ where: { id } });
    if (req.guestId !== actor.guestId) throw new AppError("Request not found.");
    if (req.status !== "OPEN") throw new AppError("Only requests that have not been picked up can be cancelled.");
    await tx.serviceRequest.update({ where: { id }, data: { status: "CANCELLED" } });
    await audit(tx, actor, { action: "service_request.cancel", module: "services", recordType: "ServiceRequest", recordId: id });
  });
}
