import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { createStaff, saveRole, setStaffActive, updateStaff } from "@/services/admin";
import { DEFAULT_ROLES, type PermissionKey } from "@/lib/permissions";
import { makeStaff } from "./helpers";

const perms = (key: string) => new Set(DEFAULT_ROLES.find((r) => r.key === key)!.permissions as PermissionKey[]);

describe("role-based access control", () => {
  it("default roles respect separation of duties", () => {
    expect(perms("housekeeping_staff").has("payments.view")).toBe(false);
    expect(perms("maintenance_staff").has("payments.view")).toBe(false);
    expect(perms("maintenance_staff").has("guests.view")).toBe(false);
    expect(perms("front_desk").has("rooms.rates")).toBe(false);
    expect(perms("front_desk").has("refunds.process")).toBe(false);
    expect(perms("accountant").has("refunds.process")).toBe(true);
    expect([...perms("auditor")].some((p) => /manage|record|create|edit|process|verify|charge|adjust/.test(p))).toBe(false);
    expect(perms("general_manager").has("roles.manage")).toBe(false);
  });

  it("staff cannot hand out roles granting permissions they do not hold", async () => {
    const gm = await makeStaff("general_manager");
    const superRole = await prisma.role.findUniqueOrThrow({ where: { key: "super_admin" } });
    await expect(createStaff(gm.actor, gm.perms as Set<PermissionKey>, { firstName: "X", lastName: "Y", email: `esc${Date.now()}@t.local`, roleIds: [superRole.id], tempPassword: "Temp12345" })).rejects.toThrow(/do not have/);
  });

  it("nobody can change their own roles or grant permissions they lack", async () => {
    const admin = await makeStaff("super_admin");
    const fdRole = await prisma.role.findUniqueOrThrow({ where: { key: "front_desk" } });
    await expect(updateStaff(admin.actor, admin.perms as Set<PermissionKey>, admin.user.id, { firstName: "A", lastName: "B", roleIds: [fdRole.id] })).rejects.toThrow(/own roles/);
    const fd = await makeStaff("front_desk");
    await expect(saveRole(fd.actor, fd.perms as Set<PermissionKey>, { name: "Sneaky", permissions: ["refunds.process"] })).rejects.toThrow(/do not hold/);
    const sa = await prisma.role.findUniqueOrThrow({ where: { key: "super_admin" } });
    await expect(saveRole(admin.actor, admin.perms as Set<PermissionKey>, { id: sa.id, name: "x", permissions: [] })).rejects.toThrow(/cannot be edited/);
  });

  it("you cannot deactivate yourself; deactivation revokes sessions and is audited", async () => {
    const admin = await makeStaff("super_admin");
    await expect(setStaffActive(admin.actor, admin.user.id, false, "x")).rejects.toThrow(/own account/);
    const victim = await makeStaff("concierge");
    await prisma.session.create({ data: { tokenHash: `h${Date.now()}`, userId: victim.user.id, portal: "STAFF", expiresAt: new Date(Date.now() + 3600e3) } });
    await setStaffActive(admin.actor, victim.user.id, false, "Left the hotel");
    expect(await prisma.session.count({ where: { userId: victim.user.id, revokedAt: null } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "staff.deactivate", recordId: victim.user.id } })).toBe(1);
  });

  it("audit records cannot be edited or deleted", async () => {
    const a = await prisma.auditLog.findFirstOrThrow();
    await expect(prisma.auditLog.update({ where: { id: a.id }, data: { action: "tampered" } })).rejects.toThrow();
    await expect(prisma.auditLog.delete({ where: { id: a.id } })).rejects.toThrow();
  });
});
