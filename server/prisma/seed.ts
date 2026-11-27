/**
 * Idempotent initial setup for Asher Hotel and Suites.
 *  - hotel settings, permissions, default roles
 *  - room types, amenities and the five initial rooms (301, 302, 303, 304, 306)
 *  - optional first Super Administrator from ADMIN_EMAIL / ADMIN_PASSWORD (otherwise use /manage/setup)
 * Rates, descriptions and amenities are starting values for management to edit in the app.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { PERMISSIONS, DEFAULT_ROLES } from "../src/lib/permissions";
import { DEFAULT_SETTINGS } from "../src/lib/settings";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

async function main() {
  // Settings (only create missing sections; never overwrite edits)
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await prisma.hotelSetting.upsert({ where: { key }, create: { key, value: value as never }, update: {} });
  }

  // Permissions
  const before = new Set((await prisma.permission.findMany({ select: { key: true } })).map((p) => p.key));
  const fresh = before.size === 0;
  const added = new Set<string>();
  for (const [key, [module, description]] of Object.entries(PERMISSIONS)) {
    if (!fresh && !before.has(key)) added.add(key);
    await prisma.permission.upsert({ where: { key }, create: { key, module, description }, update: { module, description } });
  }
  const perms = await prisma.permission.findMany();
  const permId = new Map(perms.map((p) => [p.key, p.id]));

  // Roles: created with defaults once; super_admin is always kept complete.
  for (const r of DEFAULT_ROLES) {
    const existing = await prisma.role.findUnique({ where: { key: r.key } });
    if (!existing) {
      await prisma.role.create({ data: { key: r.key, name: r.name, description: r.description, isSystem: true, permissions: { create: r.permissions.map((k) => ({ permissionId: permId.get(k)! })) } } });
    } else if (added.size && r.key !== "super_admin") {
      // Permissions introduced by an update go to the roles that have them by default (custom changes are kept).
      const extra = r.permissions.filter((k) => added.has(k));
      if (extra.length) await prisma.rolePermission.createMany({ data: extra.map((k) => ({ roleId: existing.id, permissionId: permId.get(k)! })), skipDuplicates: true });
    }
    if (existing && r.key === "super_admin") {
      await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: existing.id, permissionId: p.id })), skipDuplicates: true });
    }
  }

  // Room types and the five rooms with the hotel's published prices (VAT included).
  const types = [
    { name: "Standard Room", description: "Comfortable room with essential amenities. Available for overnight and short stays.", baseRate: "30000.00", maxOccupancy: 2, bedConfiguration: "1 Double bed" },
    { name: "Ensuite Room", description: "Room with a private en-suite bathroom.", baseRate: "40000.00", maxOccupancy: 2, bedConfiguration: "1 Double bed" },
  ];
  for (const t of types) await prisma.roomType.upsert({ where: { name: t.name }, create: t, update: {} });
  const standard = await prisma.roomType.findUniqueOrThrow({ where: { name: "Standard Room" } });
  const ensuite = await prisma.roomType.findUniqueOrThrow({ where: { name: "Ensuite Room" } });

  const amenityNames = ["Air conditioning", "Free Wi-Fi", "Flat-screen TV", "En-suite bathroom", "Hot water", "Mini fridge", "Work desk", "Wardrobe", "Electric kettle", "24-hour power"];
  for (const name of amenityNames) await prisma.amenity.upsert({ where: { name }, create: { name }, update: {} });
  const amen = async (names: string[]) => (await prisma.amenity.findMany({ where: { name: { in: names } } })).map((a) => ({ amenityId: a.id }));
  const basic = await amen(["Air conditioning", "Free Wi-Fi", "Flat-screen TV", "Hot water"]);
  const ensuiteAmen = await amen(["Air conditioning", "Free Wi-Fi", "Flat-screen TV", "Hot water", "En-suite bathroom"]);

  const rooms = [
    { number: "301", type: standard, shortStay: true, amenities: basic },
    { number: "302", type: standard, shortStay: true, amenities: basic },
    { number: "303", type: standard, shortStay: true, amenities: basic },
    { number: "304", type: standard, shortStay: true, amenities: basic },
    { number: "306", type: ensuite, shortStay: false, amenities: ensuiteAmen },
  ];
  for (const [i, r] of rooms.entries()) {
    if (await prisma.room.findUnique({ where: { number: r.number } })) continue;
    await prisma.room.create({
      data: {
        number: r.number, roomTypeId: r.type.id, floor: "3", nightlyRate: r.type.baseRate, maxOccupancy: r.type.maxOccupancy, bedConfiguration: r.type.bedConfiguration,
        allowShortStay: r.shortStay, sortOrder: i, housekeepingStatus: "INSPECTED", amenities: { create: r.amenities },
      },
    });
  }

  // Optional first administrator from environment (never hard-coded)
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (email && password) {
    if (password.length < 10) throw new Error("ADMIN_PASSWORD must be at least 10 characters");
    const exists = await prisma.user.findUnique({ where: { email } });
    if (!exists) {
      const role = await prisma.role.findUniqueOrThrow({ where: { key: "super_admin" } });
      const u = await prisma.user.create({ data: { type: "STAFF", email, firstName: process.env.ADMIN_FIRST_NAME || "Hotel", lastName: process.env.ADMIN_LAST_NAME || "Owner", passwordHash: await bcrypt.hash(password, 12), mustChangePassword: true, emailVerifiedAt: new Date(), jobTitle: "Owner", roles: { create: { roleId: role.id } } } });
      await prisma.auditLog.create({ data: { userId: null, actorName: "System (seed)", actorRole: "system", action: "staff.create", module: "staff", recordType: "User", recordId: u.id, newValues: { email, roles: ["Super Administrator / Hotel Owner"], source: "ADMIN_EMAIL env" } } });
      console.log(`Created Super Administrator ${email} (must change password at first sign-in).`);
    }
  }
  const staff = await prisma.user.count({ where: { type: "STAFF" } });
  await importRoomPhotos();
  console.log(`Seed complete. Rooms: ${await prisma.room.count()}, roles: ${await prisma.role.count()}, staff: ${staff}.`);
  if (!staff) console.log("Next step: start the server and open /manage/setup in the browser, then enter SETUP_TOKEN from .env to create the owner account. (This is not an error.)");
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });

/**
 * Room photos shipped with the project (prisma/seed-images/rooms/<room>-<n>.jpg) are copied into storage for any room
 * that has no photos yet. Set REPLACE_ROOM_PHOTOS=true to replace existing photos with the shipped ones.
 */
async function importRoomPhotos() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const crypto = await import("node:crypto");
  const { fileURLToPath } = await import("node:url");
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "seed-images", "rooms");
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => /^\d+-\d+\.(jpg|jpeg|png|webp)$/i.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const replace = process.env.REPLACE_ROOM_PHOTOS === "true";
  let added = 0, repaired = 0;
  for (const room of await prisma.room.findMany()) {
    const mine = files.filter((f) => f.startsWith(`${room.number}-`));
    if (!mine.length) continue;
    // Drop photo records whose file is gone (e.g. the old server/storage folder was not kept during an update).
    const storage = process.env.STORAGE_DIR ?? path.join(process.cwd(), "storage");
    for (const img of await prisma.roomImage.findMany({ where: { roomId: room.id } })) {
      const inDb = await prisma.storedFile.findUnique({ where: { path: img.path }, select: { path: true } });
      if (!inDb && !fs.existsSync(path.join(storage, img.path))) { await prisma.roomImage.delete({ where: { id: img.id } }); repaired++; }
    }
    const count = await prisma.roomImage.count({ where: { roomId: room.id } });
    if (count && !replace) continue;
    if (count) await prisma.roomImage.deleteMany({ where: { roomId: room.id } });
    for (const [i, f] of mine.entries()) {
      const ext = f.split(".").pop()!.toLowerCase().replace("jpeg", "jpg");
      const rel = `rooms/${crypto.randomBytes(18).toString("base64url")}.${ext}`;
      // Photos are stored in the database (StoredFile) so they survive restarts on any host.
      await prisma.storedFile.create({ data: { path: rel, kind: "rooms", mime: ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg", size: fs.statSync(path.join(dir, f)).size, data: new Uint8Array(fs.readFileSync(path.join(dir, f))) } });
      await prisma.roomImage.create({ data: { roomId: room.id, path: rel, caption: CAPTIONS[f.replace(/\.[a-z]+$/i, "")] ?? null, sortOrder: i } });
      added++;
    }
  }
  if (repaired) console.log(`Removed ${repaired} broken photo link(s).`);
  if (added) console.log(`Room photos imported: ${added}.`);
}
const CAPTIONS: Record<string, string> = { "306-1": "Room 306 (ensuite) with sofa" };
