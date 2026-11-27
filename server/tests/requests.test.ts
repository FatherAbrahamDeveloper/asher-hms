import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { addDays, todayLagos } from "@/lib/dates";
import { folioSummary } from "@/services/folio";
import { allocateRequest, cancelByGuest, declineRequest, findByToken, guestView, lookupLink, quoteForType, submitRequest, type SubmitInput } from "@/services/requests";
import { makeGuest, makeStaff, room } from "./helpers";

let day = 200;
const nextDate = () => addDays(todayLagos(), (day += 3));
const type = (name: string) => prisma.roomType.findUniqueOrThrow({ where: { name } });
const publicActor = { userId: null, name: "Web form", role: "public", type: "GUEST" as const };

async function form(over: Partial<SubmitInput> = {}): Promise<SubmitInput> {
  const std = await type("Standard Room");
  return {
    fullName: "Bola Ade", phone: `080${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`, email: null, address: "5 Allen Avenue, Ikeja",
    company: "Acme Ltd", nextOfKinName: "Tola Ade", nextOfKinPhone: "08099990000", adults: 1, children: 0,
    roomTypeId: std.id, stayType: "NIGHT", date: nextDate(), time: "14:00", nights: 2, paymentMethod: "TRANSFER", transferRef: null, ...over,
  };
}

describe("booking forms", () => {
  it("prices by room type, VAT included, for nights and short stays", async () => {
    const std = await type("Standard Room"), ens = await type("Ensuite Room");
    const d = nextDate();
    expect(Number((await quoteForType(prisma, { roomTypeId: std.id, stayType: "NIGHT", date: d, time: "14:00", nights: 2 })).quote.total)).toBe(60000);
    expect(Number((await quoteForType(prisma, { roomTypeId: ens.id, stayType: "NIGHT", date: d, time: "14:00", nights: 1 })).quote.total)).toBe(40000);
    expect(Number((await quoteForType(prisma, { roomTypeId: std.id, stayType: "SHORT", date: d, time: "10:00", hours: 2 })).quote.total)).toBe(10000);
    expect(Number((await quoteForType(prisma, { roomTypeId: std.id, stayType: "SHORT", date: d, time: "19:30", hours: 2 })).quote.total)).toBe(15000);
    expect(Number((await quoteForType(prisma, { roomTypeId: std.id, stayType: "SHORT", date: d, time: "19:30", hours: 6 })).quote.total)).toBe(20000);
    await expect(quoteForType(prisma, { roomTypeId: ens.id, stayType: "SHORT", date: d, time: "10:00", hours: 2 })).rejects.toThrow(/not offered for short stays/);
    await expect(quoteForType(prisma, { roomTypeId: std.id, stayType: "NIGHT", date: addDays(todayLagos(), -1), time: "14:00", nights: 1 })).rejects.toThrow(/past/);
  });

  it("submits without an account; the private link works and a wrong token does not", async () => {
    const { request, token, link } = await submitRequest(publicActor, await form(), null);
    expect(request.reference).toMatch(/^REQ-[A-Z2-9]{6}$/);
    expect(Number(request.quotedTotal)).toBe(60000);
    expect(link).toContain(token);
    expect((await findByToken(request.reference, token))?.id).toBe(request.id);
    expect(await findByToken(request.reference, "wrong")).toBeNull();
    expect(await lookupLink(request.reference, "+234" + request.phone.slice(1))).toBe(link);
    await expect(lookupLink(request.reference, "08011111111")).rejects.toThrow(/couldn't find/);
    expect(await prisma.notification.count({ where: { title: { contains: request.reference } } })).toBeGreaterThan(0);
  });

  it("front desk confirms transfer and allocates: guest, confirmed booking, verified payment, room visible to guest", async () => {
    const fd = await makeStaff("front_desk");
    const f = await form({ transferRef: "NIP-TEST-1", nights: 1 });
    const { request, token } = await submitRequest(publicActor, f, null);
    const r303 = await room("303");
    await expect(allocateRequest(fd.actor, request.id, { roomId: r303.id, date: f.date, time: f.time, nights: 1, paymentMethod: "BANK_TRANSFER", amount: "30000", externalRef: "NIP-TEST-1", transferConfirmed: false, canNegotiate: false, checkInNow: false })).rejects.toThrow(/Tick to confirm/);
    const { reservation } = await allocateRequest(fd.actor, request.id, { roomId: r303.id, date: f.date, time: f.time, nights: 1, paymentMethod: "BANK_TRANSFER", amount: "30000", externalRef: "NIP-TEST-1", transferConfirmed: true, canNegotiate: false, checkInNow: false });
    expect(reservation.status).toBe("CONFIRMED");
    const folio = await folioSummary(reservation.id);
    expect(folio.balance.toFixed(2)).toBe("0.00");
    expect(folio.payments[0].status).toBe("VERIFIED");
    const guest = await prisma.guest.findUniqueOrThrow({ where: { id: reservation.guestId } });
    expect(guest.nextOfKinName).toBe("Tola Ade");
    expect(guest.company).toBe("Acme Ltd");
    const view = await guestView((await findByToken(request.reference, token))!.id);
    expect(view.status).toBe("ALLOCATED");
    expect(view.reservation?.room.number).toBe("303");
    await expect(allocateRequest(fd.actor, request.id, { roomId: r303.id, date: f.date, time: f.time, nights: 1, paymentMethod: "CASH", amount: "1", transferConfirmed: false, canNegotiate: false, checkInNow: false })).rejects.toThrow(/already allocated/);
    expect(await prisma.auditLog.count({ where: { recordId: request.id, action: "booking_request.allocate" } })).toBe(1);
  });

  it("short-stay form allocated with cash; an already-taken room is refused", async () => {
    const fd = await makeStaff("front_desk");
    const std = await type("Standard Room");
    const d = nextDate();
    const a = await submitRequest(publicActor, await form({ stayType: "SHORT", date: d, time: "11:00", hours: 3, nights: null, paymentMethod: "CASH" }), null);
    const b = await submitRequest(publicActor, await form({ stayType: "SHORT", date: d, time: "12:00", hours: 2, nights: null, paymentMethod: "CASH", roomTypeId: std.id }), null);
    const r304 = await room("304");
    const first = await allocateRequest(fd.actor, a.request.id, { roomId: r304.id, date: d, time: "11:00", hours: 3, paymentMethod: "CASH", amount: "15000", transferConfirmed: false, canNegotiate: false, checkInNow: false });
    expect(first.reservation.stayType).toBe("SHORT");
    await expect(allocateRequest(fd.actor, b.request.id, { roomId: r304.id, date: d, time: "12:00", hours: 2, paymentMethod: "CASH", amount: "10000", transferConfirmed: false, canNegotiate: false, checkInNow: false })).rejects.toThrow();
    expect((await prisma.bookingRequest.findUniqueOrThrow({ where: { id: b.request.id } })).status).toBe("NEW");
  });

  it("signed-in guests keep their own profile; decline and cancel are recorded", async () => {
    const fd = await makeStaff("front_desk");
    const { guest } = await makeGuest();
    const mine = await submitRequest(publicActor, await form(), guest.id);
    expect(mine.request.guestId).toBe(guest.id);
    await declineRequest(fd.actor, mine.request.id, "No rooms of that type on those dates");
    expect((await guestView(mine.request.id)).declineReason).toMatch(/No rooms/);
    const other = await submitRequest(publicActor, await form(), null);
    await cancelByGuest(other.request.id);
    await expect(cancelByGuest(other.request.id)).rejects.toThrow(/already been handled/);
  });

  it("only staff with requests.allocate can allocate (front desk and managers, not housekeeping)", async () => {
    const fd = await makeStaff("front_desk"), hk = await makeStaff("housekeeping_staff"), gm = await makeStaff("general_manager");
    expect(fd.perms.has("requests.allocate")).toBe(true);
    expect(gm.perms.has("requests.allocate")).toBe(true);
    expect(hk.perms.has("requests.allocate")).toBe(false);
  });
});
