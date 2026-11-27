import { prisma } from "../lib/db";
import type { PermissionKey } from "../lib/permissions";

/** Active staff who hold a permission (used to populate "assign to" lists). */
export async function staffWith(permission: PermissionKey) {
  return prisma.user.findMany({
    where: { type: "STAFF", isActive: true, roles: { some: { role: { permissions: { some: { permission: { key: permission } } } } } } },
    select: { id: true, firstName: true, lastName: true, jobTitle: true }, orderBy: { firstName: "asc" },
  });
}
