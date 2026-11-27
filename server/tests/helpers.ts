import { prisma } from "@/lib/db";
import type { Actor } from "@/lib/audit";
import { addDays, todayLagos } from "@/lib/dates";

let n = 0;
export async function makeStaff(roleKey: string) {
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey }, include: { permissions: { include: { permission: true } } } });
  const u = await prisma.user.create({ data: { type: "STAFF", email: `staff${Date.now()}${n++}@test.local`, firstName: "Test", lastName: roleKey, passwordHash: "x", roles: { create: { roleId: role.id } } } });
  const actor: Actor = { userId: u.id, name: `Test ${roleKey}`, role: role.name, type: "STAFF" };
  return { user: u, actor, perms: new Set(role.permissions.map((p) => p.permission.key)) };
}

export async function makeGuest() {
  const u = await prisma.user.create({ data: { type: "GUEST", email: `guest${Date.now()}${n++}@test.local`, firstName: "Ada", lastName: "Guest", passwordHash: "x" } });
  const g = await prisma.guest.create({ data: { firstName: "Ada", lastName: "Guest", email: u.email, phone: "08000000000", userId: u.id } });
  const actor: Actor = { userId: u.id, name: "Ada Guest", role: "guest", type: "GUEST", guestId: g.id };
  return { user: u, guest: g, actor };
}

export async function room(number: string) {
  return prisma.room.findUniqueOrThrow({ where: { number } });
}

/** A distinct future window per test so tests don't collide on shared rooms. */
let offset = 10;
export function window(nights = 2) {
  const arrival = addDays(todayLagos(), offset);
  offset += nights + 1;
  return { arrival, departure: addDays(arrival, nights) };
}
