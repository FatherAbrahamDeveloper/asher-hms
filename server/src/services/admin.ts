import { prisma } from "../lib/db";
import { audit, diff, type Actor } from "../lib/audit";
import { AppError } from "../lib/errors";
import { hashPassword, passwordProblems } from "../lib/password";
import { notifyStaff } from "../lib/notify";
import { DEFAULT_SETTINGS, getSettings, type HotelSettings, type SettingsSection } from "../lib/settings";
import { ALL_PERMISSIONS, type PermissionKey } from "../lib/permissions";
import { makeRef } from "../lib/refs";
import { round2, toDb, type Decimal } from "../lib/money";
import { toDbDate, type DateStr } from "../lib/dates";

// ───────────────────────── Rooms ─────────────────────────

export type RoomInput = {
  number: string; roomTypeId: string; floor?: string | null; name?: string | null; description?: string | null; nightlyRate: Decimal.Value;
  maxOccupancy: number; bedConfiguration?: string | null; amenityIds: string[]; sortOrder?: number; allowShortStay?: boolean;
};

export async function createRoom(actor: Actor, input: RoomInput) {
  const number = input.number.trim();
  if (!number) throw new AppError("Room number is required.");
  if (await prisma.room.findUnique({ where: { number } })) throw new AppError(`Room ${number} already exists.`);
  return prisma.$transaction(async (tx) => {
    const room = await tx.room.create({
      data: {
        number, roomTypeId: input.roomTypeId, floor: input.floor || null, name: input.name || null, description: input.description || null,
        nightlyRate: toDb(input.nightlyRate), maxOccupancy: input.maxOccupancy, bedConfiguration: input.bedConfiguration || null, sortOrder: input.sortOrder ?? (Number(number) || 0), allowShortStay: !!input.allowShortStay,
        housekeepingStatus: "DIRTY", amenities: { create: input.amenityIds.map((amenityId) => ({ amenityId })) },
      },
    });
    await audit(tx, actor, { action: "room.create", module: "rooms", recordType: "Room", recordId: room.id, newValues: { number, rate: round2(input.nightlyRate).toFixed(2), maxOccupancy: input.maxOccupancy } });
    return room;
  });
}

export async function updateRoom(actor: Actor, roomId: string, input: RoomInput, canChangeRate: boolean) {
  return prisma.$transaction(async (tx) => {
    const room = await tx.room.findUniqueOrThrow({ where: { id: roomId }, include: { amenities: true } });
    const newRate = round2(input.nightlyRate).toFixed(2);
    if (newRate !== room.nightlyRate.toFixed(2) && !canChangeRate) throw new AppError("You do not have permission to change room rates.");
    if (input.number.trim() !== room.number) {
      const clash = await tx.room.findUnique({ where: { number: input.number.trim() } });
      if (clash) throw new AppError(`Room ${input.number} already exists.`);
    }
    const next = { number: input.number.trim(), roomTypeId: input.roomTypeId, floor: input.floor || null, name: input.name || null, description: input.description || null, nightlyRate: newRate, maxOccupancy: input.maxOccupancy, bedConfiguration: input.bedConfiguration || null, sortOrder: input.sortOrder ?? room.sortOrder, allowShortStay: input.allowShortStay ?? room.allowShortStay };
    const { oldValues, newValues } = diff({ ...room, nightlyRate: room.nightlyRate.toFixed(2) } as unknown as Record<string, unknown>, next);
    await tx.room.update({ where: { id: roomId }, data: next });
    await tx.roomAmenity.deleteMany({ where: { roomId } });
    if (input.amenityIds.length) await tx.roomAmenity.createMany({ data: input.amenityIds.map((amenityId) => ({ roomId, amenityId })) });
    const amenChanged = JSON.stringify(room.amenities.map((a) => a.amenityId).sort()) !== JSON.stringify([...input.amenityIds].sort());
    await audit(tx, actor, { action: newValues.nightlyRate ? "room.rate_change" : "room.update", module: "rooms", recordType: "Room", recordId: roomId, oldValues, newValues: { ...newValues, ...(amenChanged ? { amenities: input.amenityIds.length } : {}) } });
  });
}

export async function setRoomActive(actor: Actor, roomId: string, active: boolean, reason: string) {
  if (!reason?.trim()) throw new AppError("A reason is required.");
  return prisma.$transaction(async (tx) => {
    const room = await tx.room.findUniqueOrThrow({ where: { id: roomId } });
    if (!active) {
      const future = await tx.reservation.count({ where: { roomId, status: { in: ["PENDING", "CONFIRMED", "CHECKED_IN"] } } });
      if (future) throw new AppError(`Room ${room.number} has ${future} active or upcoming booking(s). Move them to another room first.`);
    }
    await tx.room.update({ where: { id: roomId }, data: { isActive: active } });
    await audit(tx, actor, { action: active ? "room.activate" : "room.deactivate", module: "rooms", recordType: "Room", recordId: roomId, oldValues: { isActive: room.isActive }, newValues: { isActive: active }, reason });
  });
}

export async function upsertRoomType(actor: Actor, input: { id?: string; name: string; description?: string | null; baseRate: Decimal.Value; maxOccupancy: number; bedConfiguration?: string | null }) {
  return prisma.$transaction(async (tx) => {
    const data = { name: input.name.trim(), description: input.description || null, baseRate: toDb(input.baseRate), maxOccupancy: input.maxOccupancy, bedConfiguration: input.bedConfiguration || null };
    if (input.id) {
      const before = await tx.roomType.findUniqueOrThrow({ where: { id: input.id } });
      await tx.roomType.update({ where: { id: input.id }, data });
      await audit(tx, actor, { action: "room_type.update", module: "rooms", recordType: "RoomType", recordId: input.id, oldValues: { name: before.name, baseRate: before.baseRate.toFixed(2) }, newValues: { name: data.name, baseRate: data.baseRate } });
    } else {
      const t = await tx.roomType.create({ data });
      await audit(tx, actor, { action: "room_type.create", module: "rooms", recordType: "RoomType", recordId: t.id, newValues: data });
    }
  });
}

export async function addSeasonalRate(actor: Actor, input: { name: string; roomTypeId: string | null; startDate: DateStr; endDate: DateStr; adjustmentPercent: string }) {
  if (input.endDate < input.startDate) throw new AppError("End date must be on or after the start date.");
  const pct = Number(input.adjustmentPercent);
  if (!Number.isFinite(pct) || pct <= -100 || pct > 500) throw new AppError("Adjustment must be between -99% and +500%.");
  return prisma.$transaction(async (tx) => {
    const s = await tx.seasonalRate.create({ data: { name: input.name, roomTypeId: input.roomTypeId, startDate: toDbDate(input.startDate), endDate: toDbDate(input.endDate), adjustmentPercent: input.adjustmentPercent } });
    await audit(tx, actor, { action: "pricing.seasonal_create", module: "settings", recordType: "SeasonalRate", recordId: s.id, newValues: input });
  });
}

export async function toggleSeasonalRate(actor: Actor, id: string) {
  return prisma.$transaction(async (tx) => {
    const s = await tx.seasonalRate.findUniqueOrThrow({ where: { id } });
    await tx.seasonalRate.update({ where: { id }, data: { isActive: !s.isActive } });
    await audit(tx, actor, { action: "pricing.seasonal_toggle", module: "settings", recordType: "SeasonalRate", recordId: id, oldValues: { isActive: s.isActive }, newValues: { isActive: !s.isActive } });
  });
}

export async function upsertDiscountCode(actor: Actor, input: { code: string; description?: string; percent: string; validFrom?: string | null; validTo?: string | null; isActive: boolean }) {
  const pct = Number(input.percent);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new AppError("Discount must be between 0 and 100%.");
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,20}$/.test(code)) throw new AppError("Codes are 3–20 letters/numbers.");
  return prisma.$transaction(async (tx) => {
    const existing = await tx.discountCode.findUnique({ where: { code } });
    const data = { code, description: input.description || null, percent: input.percent, validFrom: input.validFrom ? toDbDate(input.validFrom) : null, validTo: input.validTo ? toDbDate(input.validTo) : null, isActive: input.isActive };
    const dc = existing ? await tx.discountCode.update({ where: { code }, data }) : await tx.discountCode.create({ data });
    await audit(tx, actor, { action: existing ? "pricing.discount_update" : "pricing.discount_create", module: "settings", recordType: "DiscountCode", recordId: dc.id, oldValues: existing ? { percent: existing.percent.toString(), isActive: existing.isActive } : undefined, newValues: { code, percent: input.percent, isActive: input.isActive } });
  });
}

export async function addAmenity(actor: Actor, name: string) {
  return prisma.$transaction(async (tx) => {
    const a = await tx.amenity.create({ data: { name: name.trim() } });
    await audit(tx, actor, { action: "room.amenity_create", module: "rooms", recordType: "Amenity", recordId: a.id, newValues: { name } });
  });
}

// ───────────────────────── Staff & roles ─────────────────────────

async function assertCanAssignRoles(actor: Actor, actorPerms: Set<PermissionKey>, roleIds: string[]) {
  const roles = await prisma.role.findMany({ where: { id: { in: roleIds } }, include: { permissions: { include: { permission: true } } } });
  if (roles.length !== roleIds.length) throw new AppError("One of the selected roles no longer exists.");
  // Nobody can hand out permissions they don't hold themselves (prevents privilege escalation).
  for (const r of roles) for (const rp of r.permissions) {
    if (!actorPerms.has(rp.permission.key as PermissionKey)) throw new AppError(`You cannot assign the role "${r.name}" because it grants permissions you do not have.`);
  }
  return roles;
}

export async function createStaff(actor: Actor, actorPerms: Set<PermissionKey>, input: { firstName: string; lastName: string; email: string; phone?: string | null; jobTitle?: string | null; roleIds: string[]; tempPassword: string }) {
  const email = input.email.trim().toLowerCase();
  if (await prisma.user.findUnique({ where: { email } })) throw new AppError("An account with this email already exists.");
  const settings = await getSettings();
  const problem = passwordProblems(input.tempPassword, settings.security.passwordMinLength);
  if (problem) throw new AppError(problem);
  if (!input.roleIds.length) throw new AppError("Assign at least one role.");
  const roles = await assertCanAssignRoles(actor, actorPerms, input.roleIds);
  const passwordHash = await hashPassword(input.tempPassword);
  return prisma.$transaction(async (tx) => {
    const u = await tx.user.create({ data: { type: "STAFF", email, phone: input.phone || null, firstName: input.firstName, lastName: input.lastName, jobTitle: input.jobTitle || null, passwordHash, mustChangePassword: true, emailVerifiedAt: new Date(), roles: { create: input.roleIds.map((roleId) => ({ roleId })) } } });
    await audit(tx, actor, { action: "staff.create", module: "staff", recordType: "User", recordId: u.id, newValues: { email, name: `${u.firstName} ${u.lastName}`, roles: roles.map((r) => r.name) } });
    await notifyStaff(tx, ["staff.manage"], { category: "staff", title: "Staff account created", body: `${u.firstName} ${u.lastName} (${roles.map((r) => r.name).join(", ")}) by ${actor.name}.`, link: `/manage/staff/${u.id}`, dedupeKey: `staff-new:${u.id}` }, { exclude: actor.userId });
    return u;
  });
}

export async function updateStaff(actor: Actor, actorPerms: Set<PermissionKey>, userId: string, input: { firstName: string; lastName: string; phone?: string | null; jobTitle?: string | null; roleIds: string[] }) {
  if (userId === actor.userId) {
    const current = await prisma.userRole.findMany({ where: { userId } });
    if (JSON.stringify(current.map((c) => c.roleId).sort()) !== JSON.stringify([...input.roleIds].sort())) throw new AppError("You cannot change your own roles. Ask another administrator.");
  }
  if (!input.roleIds.length) throw new AppError("Assign at least one role.");
  const roles = await assertCanAssignRoles(actor, actorPerms, input.roleIds);
  return prisma.$transaction(async (tx) => {
    const u = await tx.user.findUniqueOrThrow({ where: { id: userId }, include: { roles: { include: { role: true } } } });
    if (u.type !== "STAFF") throw new AppError("Not a staff account.");
    const isSuperAdmin = u.roles.some((r) => r.role.key === "super_admin");
    if (isSuperAdmin && !roles.some((r) => r.key === "super_admin")) {
      const otherAdmins = await tx.userRole.count({ where: { role: { key: "super_admin" }, userId: { not: userId }, user: { isActive: true } } });
      if (!otherAdmins) throw new AppError("At least one active Super Administrator must remain.");
    }
    await tx.user.update({ where: { id: userId }, data: { firstName: input.firstName, lastName: input.lastName, phone: input.phone || null, jobTitle: input.jobTitle || null } });
    await tx.userRole.deleteMany({ where: { userId } });
    await tx.userRole.createMany({ data: input.roleIds.map((roleId) => ({ userId, roleId })) });
    const before = u.roles.map((r) => r.role.name).sort(), after = roles.map((r) => r.name).sort();
    await audit(tx, actor, { action: JSON.stringify(before) !== JSON.stringify(after) ? "staff.roles_change" : "staff.update", module: "staff", recordType: "User", recordId: userId, oldValues: { name: `${u.firstName} ${u.lastName}`, roles: before, jobTitle: u.jobTitle }, newValues: { name: `${input.firstName} ${input.lastName}`, roles: after, jobTitle: input.jobTitle } });
    if (JSON.stringify(before) !== JSON.stringify(after)) await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  });
}

export async function setStaffActive(actor: Actor, userId: string, active: boolean, reason: string) {
  if (userId === actor.userId) throw new AppError("You cannot deactivate your own account.");
  if (!reason?.trim()) throw new AppError("A reason is required.");
  return prisma.$transaction(async (tx) => {
    const u = await tx.user.findUniqueOrThrow({ where: { id: userId }, include: { roles: { include: { role: true } } } });
    if (!active && u.roles.some((r) => r.role.key === "super_admin")) {
      const others = await tx.userRole.count({ where: { role: { key: "super_admin" }, userId: { not: userId }, user: { isActive: true } } });
      if (!others) throw new AppError("At least one active Super Administrator must remain.");
    }
    await tx.user.update({ where: { id: userId }, data: { isActive: active, deactivatedAt: active ? null : new Date() } });
    if (!active) await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(tx, actor, { action: active ? "staff.reactivate" : "staff.deactivate", module: "staff", recordType: "User", recordId: userId, oldValues: { isActive: u.isActive }, newValues: { isActive: active }, reason });
    await notifyStaff(tx, ["staff.manage"], { category: "staff", priority: "HIGH", title: `Staff account ${active ? "reactivated" : "deactivated"}`, body: `${u.firstName} ${u.lastName} by ${actor.name}: ${reason}`, link: `/manage/staff/${u.id}`, dedupeKey: `staff-active:${u.id}:${Date.now()}` }, { exclude: actor.userId });
  });
}

export async function adminResetPassword(actor: Actor, userId: string, tempPassword: string, reason: string) {
  if (userId === actor.userId) throw new AppError("Use 'Change password' for your own account.");
  const settings = await getSettings();
  const problem = passwordProblems(tempPassword, settings.security.passwordMinLength);
  if (problem) throw new AppError(problem);
  const hash = await hashPassword(tempPassword);
  return prisma.$transaction(async (tx) => {
    const u = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (u.type !== "STAFF") throw new AppError("Guests reset their own passwords.");
    await tx.user.update({ where: { id: userId }, data: { passwordHash: hash, mustChangePassword: true } });
    await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(tx, actor, { action: "staff.password_reset", module: "staff", recordType: "User", recordId: userId, reason });
  });
}

export async function saveRole(actor: Actor, actorPerms: Set<PermissionKey>, input: { id?: string; name: string; description?: string; permissions: string[] }) {
  const perms = input.permissions.filter((p): p is PermissionKey => (ALL_PERMISSIONS as string[]).includes(p));
  for (const p of perms) if (!actorPerms.has(p)) throw new AppError(`You cannot grant "${p}" because you do not hold it.`);
  return prisma.$transaction(async (tx) => {
    const permRows = await tx.permission.findMany({ where: { key: { in: perms } } });
    if (input.id) {
      const role = await tx.role.findUniqueOrThrow({ where: { id: input.id }, include: { permissions: { include: { permission: true } }, users: true } });
      if (role.key === "super_admin") throw new AppError("The Super Administrator role always has every permission and cannot be edited.");
      if (role.users.some((u) => u.userId === actor.userId)) throw new AppError("You cannot change the permissions of a role you hold.");
      const before = role.permissions.map((p) => p.permission.key).sort();
      await tx.role.update({ where: { id: role.id }, data: { name: input.name, description: input.description || null } });
      await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
      await tx.rolePermission.createMany({ data: permRows.map((p) => ({ roleId: role.id, permissionId: p.id })) });
      const after: string[] = [...perms].sort();
      await audit(tx, actor, { action: "role.permissions_change", module: "staff", recordType: "Role", recordId: role.id, oldValues: { name: role.name, permissions: before }, newValues: { name: input.name, added: after.filter((p) => !before.includes(p)), removed: before.filter((p) => !after.includes(p)) } });
      await notifyStaff(tx, ["roles.manage"], { category: "settings", priority: "HIGH", title: `Permissions changed: ${input.name}`, body: `${actor.name} updated role permissions.`, link: `/manage/roles`, dedupeKey: `role:${role.id}:${Date.now()}` }, { exclude: actor.userId });
    } else {
      const key = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") + "_" + makeRef("", 4).slice(1).toLowerCase();
      const role = await tx.role.create({ data: { key, name: input.name, description: input.description || null, permissions: { create: permRows.map((p) => ({ permissionId: p.id })) } } });
      await audit(tx, actor, { action: "role.create", module: "staff", recordType: "Role", recordId: role.id, newValues: { name: input.name, permissions: perms } });
    }
  });
}

// ───────────────────────── Settings ─────────────────────────

export async function updateSettingsSection<K extends SettingsSection>(actor: Actor, section: K, value: HotelSettings[K]) {
  if (!(section in DEFAULT_SETTINGS)) throw new AppError("Unknown settings section.");
  return prisma.$transaction(async (tx) => {
    const current = await getSettings(tx);
    await tx.hotelSetting.upsert({ where: { key: section }, create: { key: section, value: value as never, updatedBy: actor.userId }, update: { value: value as never, updatedBy: actor.userId } });
    const before = current[section] as unknown as Record<string, unknown>;
    const { oldValues, newValues, changed } = Array.isArray(value) ? { oldValues: { list: before }, newValues: { list: value }, changed: true } : diff(before, value as unknown as Record<string, unknown>);
    if (changed) {
      await audit(tx, actor, { action: "settings.update", module: "settings", recordType: "HotelSetting", recordId: section, oldValues, newValues });
      await notifyStaff(tx, ["settings.manage"], { category: "settings", priority: "HIGH", title: `Settings changed: ${section}`, body: `${actor.name} changed ${Object.keys(newValues).join(", ")}.`, link: "/manage/settings", dedupeKey: `settings:${section}:${Date.now()}` }, { exclude: actor.userId });
    }
  });
}

// ───────────────────────── Expenses ─────────────────────────

export const EXPENSE_CATEGORIES = ["Utilities", "Diesel / power", "Supplies & toiletries", "Food & beverage stock", "Repairs & maintenance", "Salaries & wages", "Laundry", "Marketing", "Taxes & levies", "Bank charges", "Other"];

export async function recordExpense(actor: Actor, input: { category: string; description: string; amount: Decimal.Value; expenseDate: DateStr; paymentMethod: string; vendor?: string | null }) {
  if (round2(input.amount).lte(0)) throw new AppError("Amount must be greater than zero.");
  return prisma.$transaction(async (tx) => {
    const e = await tx.expense.create({ data: { reference: makeRef("EXP"), category: input.category, description: input.description, amount: toDb(input.amount), expenseDate: toDbDate(input.expenseDate), paymentMethod: input.paymentMethod, vendor: input.vendor || null, recordedById: actor.userId!, recordedByName: actor.name } });
    await audit(tx, actor, { action: "expense.record", module: "finance", recordType: "Expense", recordId: e.id, newValues: { reference: e.reference, category: input.category, amount: round2(input.amount).toFixed(2), date: input.expenseDate } });
  });
}

/** Expenses are voided (with reason), never deleted. */
export async function voidExpense(actor: Actor, id: string, reason: string) {
  if (!reason?.trim()) throw new AppError("A reason is required.");
  return prisma.$transaction(async (tx) => {
    const e = await tx.expense.findUniqueOrThrow({ where: { id } });
    if (e.voidedAt) throw new AppError("Already voided.");
    await tx.expense.update({ where: { id }, data: { voidedAt: new Date(), voidedById: actor.userId, voidReason: reason } });
    await audit(tx, actor, { action: "expense.void", module: "finance", recordType: "Expense", recordId: id, oldValues: { voided: false, amount: e.amount.toFixed(2) }, newValues: { voided: true }, reason });
  });
}
