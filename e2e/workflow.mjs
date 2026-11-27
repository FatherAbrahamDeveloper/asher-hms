// End-to-end workflow test against a running instance with a FRESH, seeded database.
// Usage: BASE_URL=http://localhost:4000 SETUP_TOKEN=... node e2e/workflow.mjs
// (BASE_URL is where the client is served: the API with SERVE_CLIENT=true, or the Vite dev server.)
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.env.BASE_URL ?? "http://localhost:4000";
const API = `${BASE}/api`;
const TOKEN = process.env.SETUP_TOKEN;
const SHOTS = process.env.SHOT_DIR ?? "e2e-screens";
fs.mkdirSync(SHOTS, { recursive: true });
const stamp = Date.now().toString(36);
const OWNER = { email: `owner+${stamp}@asher.test`, password: "OwnerPass#2026x" };
const FD = { email: `desk+${stamp}@asher.test`, password: "DeskTemp#2026", newPassword: "DeskReal#2026" };
const HK = { email: `hk+${stamp}@asher.test`, password: "HkTemp#2026a", newPassword: "HkReal#2026a" };
const GUEST = { email: `guest+${stamp}@example.com`, password: "GuestPass2026" };
const errors = [];
let step = 0;
const H = { "X-Requested-With": "asher-client" };

function log(msg) { console.log(`\n[${++step}] ${msg}`); }
async function shot(page, name) { await page.screenshot({ path: `${SHOTS}/${String(step).padStart(2, "0")}-${name}.png`, fullPage: true }); }
async function expectText(page, text, timeout = 15000) { await page.getByText(text, { exact: false }).first().waitFor({ timeout }); }
async function submit(page, buttonName, { reason, scope } = {}) {
  const root = scope ?? page;
  await root.getByRole("button", { name: buttonName }).first().click();
  const dlg = page.locator("dialog[open]");
  if (await dlg.isVisible({ timeout: 1500 }).catch(() => false)) {
    if (await dlg.locator("textarea").count()) await dlg.locator("textarea").fill(reason ?? "E2E test reason");
    await dlg.getByRole("button", { name: "Confirm" }).click();
  }
}
const seen = new WeakMap();
async function status(page) {
  const prev = seen.get(page) ?? "";
  const loc = page.locator("p[role=status], [data-toast]");
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const n = await loc.count();
    const txt = n ? ((await loc.nth(n - 1).textContent().catch(() => "")) ?? "") : "";
    if (txt && txt !== prev) { seen.set(page, txt); return txt; }
    await page.waitForTimeout(200);
  }
  throw new Error("No new action feedback appeared");
}
async function expectOk(page, label) {
  const s = (await status(page)) ?? "";
  if (/went wrong|cannot|not |required|invalid|exceed|please|only/i.test(s) && !/sent|saved|created|recorded|verified|updated|checked|issued|requested|processed|thank|applied/i.test(s)) throw new Error(`${label}: ${s}`);
  console.log(`   ✓ ${label}: ${s.trim()}`);
  return s;
}
const naira = (t) => Number(String(t).replace(/[^\d.]/g, ""));
function watch(p, tag) {
  p.on("pageerror", (e) => errors.push(`${tag} pageerror @ ${p.url()}: ${e.message}`));
  p.on("response", (r) => { if (r.status() >= 500) errors.push(`${tag} ${r.status()} ${r.url()}`); });
}
async function apiJson(p, path) { const r = await p.request.get(`${API}${path}`); return { status: r.status(), body: await r.json().catch(() => null) }; }

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
watch(page, "owner");
const d = (n) => new Date(Date.now() + 3600e3 + n * 86400e3).toISOString().slice(0, 10);

try {
  log("Owner setup via one-time token");
  await page.goto(`${BASE}/manage/setup`);
  await page.locator("input[name=token]").waitFor();
  await page.fill("input[name=token]", TOKEN);
  await page.fill("input[name=firstName]", "Grace"); await page.fill("input[name=lastName]", "Asher");
  await page.fill("input[name=email]", OWNER.email); await page.fill("input[name=password]", OWNER.password); await page.fill("input[name=confirm]", OWNER.password);
  await page.getByRole("button", { name: "Create owner account" }).click();
  await page.waitForURL(`${BASE}/manage`, { timeout: 20000 });
  await expectText(page, "Total rooms");
  await shot(page, "dashboard");

  log("Rooms preloaded with the right prices and short-stay flags");
  await page.goto(`${BASE}/manage/rooms`);
  for (const n of ["301", "302", "303", "304", "306"]) await expectText(page, n);
  const rooms = (await apiJson(page, "/staff/rooms")).body.board.map((b) => b.room);
  for (const r of rooms) {
    const want = r.number === "306" ? 40000 : 30000;
    if (Number(r.nightlyRate) !== want) throw new Error(`Room ${r.number} rate ${r.nightlyRate}, expected ${want}`);
    if (r.allowShortStay !== (r.number !== "306")) throw new Error(`Room ${r.number} short-stay flag wrong`);
  }
  console.log("   ✓ 301–304 ₦30,000 with short stays; 306 ₦40,000 overnight only");

  log("Create Front Desk and Housekeeping staff accounts");
  for (const [who, role, first] of [[FD, "Front Desk / Receptionist", "Fola"], [HK, "Housekeeping Staff", "Halima"]]) {
    await page.goto(`${BASE}/manage/staff/new`);
    await page.locator("input[name=firstName]").waitFor();
    await page.fill("input[name=firstName]", first); await page.fill("input[name=lastName]", "Tester");
    await page.fill("input[name=email]", who.email); await page.fill("input[name=tempPassword]", who.password);
    await page.getByLabel(role).check();
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL(/\/manage\/staff\/[a-z0-9]+$/, { timeout: 15000 });
  }

  log("Configure bank details + discount code");
  await page.goto(`${BASE}/manage/settings?tab=finance`);
  await page.locator("input[name=bankName]").waitFor();
  await page.fill("input[name=bankName]", "Test Bank"); await page.fill("input[name=accountName]", "Asher Hotel and Suites"); await page.fill("input[name=accountNumber]", "0123456789");
  await submit(page, "Save changes"); await expectOk(page, "finance settings");
  await page.goto(`${BASE}/manage/settings?tab=pricing`);
  await page.locator("input[name=code]").waitFor();
  await page.fill("input[name=code]", "WELCOME10"); await page.fill("input[name=percent]", "10");
  await page.getByRole("button", { name: "Save", exact: true }).click(); await expectOk(page, "discount code");

  log("Short-stay settings tab shows the packages");
  await page.goto(`${BASE}/manage/settings?tab=shortStay`);
  await page.locator("input[name=tierHours]").first().waitFor();
  if ((await page.locator("input[name=tierHours]").count()) !== 3) throw new Error("Expected 3 short-stay packages");
  await shot(page, "settings-short-stay");

  // ───────── Front desk signs in ─────────
  const fd = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage(); watch(fd, "fd");
  log("Front desk signs in and must change temporary password");
  await fd.goto(`${BASE}/manage/login`);
  await fd.fill("input[name=email]", FD.email); await fd.fill("input[name=password]", FD.password);
  await fd.getByRole("button", { name: "Sign in" }).click();
  await fd.waitForURL(/\/manage\/profile/, { timeout: 15000 });
  await fd.locator("input[name=current]").waitFor();
  await fd.fill("input[name=current]", FD.password); await fd.fill("input[name=password]", FD.newPassword); await fd.fill("input[name=confirm]", FD.newPassword);
  await fd.getByRole("button", { name: "Change password" }).click();
  await fd.waitForURL(`${BASE}/manage`, { timeout: 15000 });

  log("Booking QR code poster renders for the receptionist");
  await fd.goto(`${BASE}/manage/booking-qr`);
  await fd.locator("[data-testid=qr] svg").waitFor({ timeout: 10000 });
  await shot(fd, "booking-qr");

  // ───────── Guest without an account (phone) ─────────
  const anon = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage(); watch(anon, "anon");
  log("Public site shows room types and prices but no availability");
  await anon.goto(BASE);
  await expectText(anon, "Our rooms"); await expectText(anon, "Standard Room"); await expectText(anon, "Ensuite Room");
  if ((await fetch(`${API}/public/availability?arrival=${d(3)}&departure=${d(5)}`)).status !== 404) throw new Error("public availability endpoint still exists");
  if ((await fetch(`${API}/guest/bookings`, { method: "POST", headers: H })).status < 400) throw new Error("guest room booking endpoint still open");
  const types = await (await fetch(`${API}/public/room-types`)).json();
  if (JSON.stringify(types).match(/"number"/)) throw new Error("room numbers exposed publicly");
  await shot(anon, "guest-home-mobile");

  log("Guest fills the booking form (Standard, 2 nights, bank transfer) — ₦60,000 shown before submitting");
  await anon.goto(`${BASE}/book`);
  await anon.fill("input[name=fullName]", "Ngozi Bello"); await anon.fill("input[name=phone]", "08061234567");
  await anon.fill("textarea[name=address]", "14 Awolowo Road, Ikoyi, Lagos"); await anon.fill("input[name=company]", "Bello Ventures");
  await anon.fill("input[name=nextOfKinName]", "Emeka Bello"); await anon.fill("input[name=nextOfKinPhone]", "08098765432");
  await anon.getByLabel(/Standard Room/).check();
  await anon.fill("input[name=date]", d(3)); await anon.fill("input[name=nights]", "2");
  await anon.waitForFunction(() => /60,000/.test(document.querySelector("[data-testid=price]")?.textContent ?? ""), null, { timeout: 10000 });
  await anon.fill("input[name=transferRef]", `NIP${stamp}A`);
  await anon.locator("input[name=acceptPolicies]").check();
  await shot(anon, "booking-form");
  await anon.getByRole("button", { name: /Send booking form/ }).click();
  await anon.waitForURL(/\/booking\/REQ-[A-Z0-9]+\?t=/, { timeout: 20000 });
  const anonLink = anon.url();
  const anonReq = (await anon.locator("[data-testid=booking-ref]").textContent()).trim();
  await expectText(anon, "Form received");
  console.log("   form reference:", anonReq);

  log("Lost link: reference + phone finds the booking again");
  const lk = await (await browser.newContext()).newPage();
  await lk.goto(`${BASE}/track`);
  await lk.fill("input[name=reference]", anonReq); await lk.fill("input[name=phone]", "+2348061234567");
  await lk.getByRole("button", { name: "Find my booking" }).click();
  await lk.waitForURL(/\/booking\/REQ-/, { timeout: 15000 });
  await expectText(lk, anonReq);

  log("Receptionist confirms the transfer and allocates Room 301");
  await fd.goto(`${BASE}/manage`);
  await expectText(fd, "Booking forms waiting");
  await fd.goto(`${BASE}/manage/requests`);
  await fd.locator("tr", { hasText: anonReq }).getByRole("link", { name: "Open" }).click();
  await fd.locator("label", { hasText: "Room 301" }).locator("input[type=radio]").check();
  await expectText(fd, "Next of kin");
  await fd.locator("input[name=transferConfirmed]").check();
  await shot(fd, "allocate");
  await submit(fd, /Confirm payment/);
  await fd.waitForURL(/\/manage\/reservations\/[a-z0-9]+$/, { timeout: 20000 });
  await fd.locator("span", { hasText: "Confirmed" }).first().waitFor();
  const ref = (await fd.locator("h1 span.font-mono").first().textContent()).trim();
  const anonFolio = (await apiJson(fd, `/staff/reservations/${fd.url().split("/").pop()}`)).body.folio;
  if (Number(anonFolio.balance) !== 0 || anonFolio.payments[0].status !== "VERIFIED") throw new Error("allocation payment not verified");
  console.log("   ✓ booking", ref, "confirmed, ₦60,000 transfer verified");

  log("Guest's page now shows Room 301 (no refresh needed)");
  await anon.goto(anonLink);
  await anon.locator("[data-testid=room-number]").waitFor({ timeout: 25000 });
  if (!/301/.test(await anon.locator("[data-testid=room-number]").textContent())) throw new Error("wrong room shown");
  await expectText(anon, "Your room is ready");
  await shot(anon, "guest-room-allocated");

  // ───────── Guest with an account, at reception (QR code) ─────────
  const g = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const gp = await g.newPage(); watch(gp, "guest");
  log("Guest registers");
  await gp.goto(`${BASE}/register`);
  await gp.fill("input[name=firstName]", "Ada"); await gp.fill("input[name=lastName]", "Okafor");
  await gp.fill("input[name=email]", GUEST.email); await gp.fill("input[name=phone]", "+2348031234567");
  await gp.fill("input[name=password]", GUEST.password); await gp.fill("input[name=confirm]", GUEST.password);
  await gp.getByRole("button", { name: "Create account" }).click();
  await gp.waitForURL(`${BASE}/account`, { timeout: 15000 });

  log("Signed-in guest books the Ensuite room for 1 night (details filled in, cash at reception)");
  await gp.goto(`${BASE}/book`);
  if ((await gp.inputValue("input[name=fullName]")) !== "Ada Okafor") throw new Error("form not pre-filled for signed-in guest");
  await gp.fill("textarea[name=address]", "3 Admiralty Way, Lekki"); await gp.fill("input[name=nextOfKinName]", "Chike Okafor"); await gp.fill("input[name=nextOfKinPhone]", "08011223344");
  await gp.getByLabel(/Ensuite Room/).check();
  if (await gp.getByText("Short stay (hours)").count()) throw new Error("short stay offered for Ensuite");
  await gp.fill("input[name=date]", d(6)); await gp.fill("input[name=nights]", "1");
  await gp.waitForFunction(() => /40,000/.test(document.querySelector("[data-testid=price]")?.textContent ?? ""), null, { timeout: 10000 });
  await gp.getByLabel(/Cash or POS at reception/).check();
  await gp.locator("input[name=acceptPolicies]").check();
  await gp.getByRole("button", { name: /Send booking form/ }).click();
  await gp.waitForURL(/\/booking\/REQ-/, { timeout: 20000 });
  const adaReq = (await gp.locator("[data-testid=booking-ref]").textContent()).trim();

  log("Walk-in scans the QR code: 2-hour short stay now, pays cash, receptionist allocates and checks in");
  const qr = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage(); watch(qr, "qr");
  await qr.goto(`${BASE}/book`);
  await qr.fill("input[name=fullName]", "Kemi Ade"); await qr.fill("input[name=phone]", "08055556666");
  await qr.fill("textarea[name=address]", "Ikeja, Lagos"); await qr.fill("input[name=nextOfKinName]", "Tunde Ade"); await qr.fill("input[name=nextOfKinPhone]", "08055557777");
  await qr.getByLabel(/Standard Room/).check();
  await qr.getByText("Short stay (hours)").click();
  await qr.selectOption("select[name=hours]", "2");
  const evening = (await qr.inputValue("input[name=time]")) >= "18:00";
  const shortPrice = evening ? "15,000" : "10,000";
  await qr.waitForFunction((p) => (document.querySelector("[data-testid=price]")?.textContent ?? "").includes(p), shortPrice, { timeout: 10000 });
  await qr.getByLabel(/Cash or POS at reception/).check();
  await qr.locator("input[name=acceptPolicies]").check();
  await qr.getByRole("button", { name: /Send booking form/ }).click();
  await qr.waitForURL(/\/booking\/REQ-/, { timeout: 20000 });
  const qrReq = (await qr.locator("[data-testid=booking-ref]").textContent()).trim();
  await fd.goto(`${BASE}/manage/requests`);
  await fd.locator("tr", { hasText: qrReq }).getByRole("link", { name: "Open" }).click();
  await fd.locator("label", { hasText: "Room 303" }).locator("input[type=radio]").check();
  await fd.selectOption("select[name=paymentMethod]", "CASH");
  await submit(fd, /Confirm payment/);
  await fd.waitForURL(/\/manage\/front-desk\/check-in\?id=/, { timeout: 20000 });
  await fd.fill("input[name=idNumber]", "C1234567");
  await submit(fd, "Check in guest");
  await fd.waitForURL(/\/manage\/reservations\/[a-z0-9]+$/, { timeout: 20000 });
  await fd.locator("span", { hasText: "Checked In" }).first().waitFor();
  await qr.reload();
  await qr.locator("[data-testid=room-number]").waitFor({ timeout: 15000 });
  console.log(`   ✓ ₦${shortPrice} short stay, Room 303, checked in`);

  log("Receptionist allocates Ada's Ensuite form (Room 306), cash received");
  await fd.goto(`${BASE}/manage/requests`);
  await fd.locator("tr", { hasText: adaReq }).getByRole("link", { name: "Open" }).click();
  await fd.locator("label", { hasText: "Room 306" }).locator("input[type=radio]").check();
  await fd.selectOption("select[name=paymentMethod]", "CASH");
  await submit(fd, /Confirm payment/);
  await fd.waitForURL(/\/manage\/reservations\/[a-z0-9]+$/, { timeout: 20000 });
  await expectText(fd, "306 · Ensuite Room");
  const adaRef = (await fd.locator("h1 span.font-mono").first().textContent()).trim();

  log("A form can be declined with a reason the guest sees");
  const dec = await (await browser.newContext()).newPage();
  await dec.goto(`${BASE}/book`);
  await dec.fill("input[name=fullName]", "Sam Uche"); await dec.fill("input[name=phone]", "08077778888");
  await dec.fill("textarea[name=address]", "Yaba"); await dec.fill("input[name=nextOfKinName]", "Ada Uche"); await dec.fill("input[name=nextOfKinPhone]", "08077779999");
  await dec.getByLabel(/Standard Room/).check(); await dec.fill("input[name=date]", d(2));
  await dec.locator("input[name=acceptPolicies]").check();
  await dec.getByRole("button", { name: /Send booking form/ }).click();
  await dec.waitForURL(/\/booking\/REQ-/, { timeout: 20000 });
  const decReq = (await dec.locator("[data-testid=booking-ref]").textContent()).trim();
  await fd.goto(`${BASE}/manage/requests`);
  await fd.locator("tr", { hasText: decReq }).getByRole("link", { name: "Open" }).click();
  await submit(fd, "Decline form", { reason: "Fully booked that night" });
  await fd.waitForURL(/\/manage\/requests$/, { timeout: 15000 });
  await dec.reload(); await expectText(dec, "Fully booked that night");

  log("Ada sees her room with photos in her account, completes pre-arrival check-in, messages the desk");
  await gp.goto(`${BASE}/account`);
  await expectText(gp, "Room allocated"); await expectText(gp, "Room 306");
  await gp.goto(`${BASE}/account/reservations/${adaRef}`);
  await expectText(gp, "Room 306");
  if (await gp.getByText("Change your booking").count()) throw new Error("guest can still change dates/rooms");
  await shot(gp, "guest-reservation");
  await gp.goto(`${BASE}/account/reservations/${adaRef}/check-in`);
  await gp.locator("input[name=idNumber]").waitFor();
  await gp.fill("input[name=address]", "3 Admiralty Way, Lekki"); await gp.fill("input[name=idNumber]", "12345678901");
  await gp.locator("input[name=acceptPolicies]").check();
  await gp.getByRole("button", { name: "Complete check-in" }).click();
  await gp.waitForURL(new RegExp(`/account/reservations/${adaRef}$`), { timeout: 15000 });
  await gp.goto(`${BASE}/account/messages`);
  await gp.locator("input[name=subject]").waitFor();
  await gp.fill("input[name=subject]", "Airport pickup"); await gp.fill("textarea[name=body]", "Can you arrange a pickup from the airport?");
  await gp.getByRole("button", { name: "Send" }).click();
  await gp.waitForURL(/\/account\/messages\/[a-z0-9]+$/, { timeout: 15000 });

  log("Owner replies to guest message; guest sees reply + notifications");
  await page.goto(`${BASE}/manage/messages`);
  await page.getByText("Airport pickup").first().click();
  await page.locator("textarea[name=body]").waitFor();
  await page.fill("textarea[name=body]", "Yes, we can. Please share your flight number.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await page.waitForTimeout(1500);
  await gp.goto(`${BASE}/account/notifications`);
  await expectText(gp, "New reply from the hotel");
  await expectText(gp, "Your room is ready");

  log("Manager negotiates a price: Room 304 tonight at ₦25,000 (reason required)");
  await page.goto(`${BASE}/manage/reservations/new?walkin=1`);
  await page.locator("label", { hasText: "Room 304" }).locator("input[type=radio]").check();
  await page.fill("input[name=rateOverride]", "25000");
  await page.fill("input[name=negotiationReason]", "Regular corporate guest");
  await page.getByLabel("New guest").check();
  await page.fill("input[name=firstName]", "Chidi"); await page.fill("input[name=lastName]", "Eze"); await page.fill("input[name=phone]", "08033334444");
  await page.locator("input[name=checkInNow]").uncheck();
  await page.getByRole("button", { name: "Create reservation" }).click();
  await page.waitForURL(/\/manage\/reservations\/[a-z0-9]+$/, { timeout: 20000 });
  await expectText(page, "negotiated");
  const negId = page.url().split("/").pop();
  const neg = (await apiJson(page, `/staff/reservations/${negId}`)).body;
  if (Number(neg.folio.total) !== 25000 || Number(neg.reservation.standardRate) !== 30000) throw new Error(`Negotiated total ${neg.folio.total}, standard ${neg.reservation.standardRate}`);
  console.log("   ✓ total ₦25,000 (standard ₦30,000 recorded)");

  log("RBAC: front desk cannot open staff management or audit, and cannot negotiate");
  await fd.goto(`${BASE}/manage/staff`); await expectText(fd, "You don't have access");
  await fd.goto(`${BASE}/manage/audit`); await expectText(fd, "You don't have access");
  if ((await apiJson(fd, "/staff/audit")).status !== 403) throw new Error("front desk reached audit API");
  await fd.goto(`${BASE}/manage/reservations/new`);
  await expectText(fd, "only managers can set negotiated prices");
  if (await fd.locator("input[name=rateOverride]").count()) throw new Error("front desk sees negotiated price field");
  const sneaky = await fd.request.post(`${API}/staff/reservations`, { headers: H, multipart: { guestMode: "existing", guestId: neg.reservation.guestId, stayType: "NIGHT", roomId: rooms.find((r) => r.number === "302").id, arrival: d(10), departure: d(11), adults: "1", children: "0", source: "TELEPHONE", paymentPlan: "PAY_AT_HOTEL", status: "CONFIRMED", rateOverride: "1000", negotiationReason: "x" } });
  const sj = await sneaky.json();
  if (sj.ok) throw new Error("front desk set a negotiated price via API");
  console.log("   ✓ blocked:", sj.message);

  log("Walk-in short stay (2 hours) in Room 301, paid and checked in");
  await fd.goto(`${BASE}/manage/reservations/new?walkin=1&type=SHORT&hours=2`);
  await fd.locator("label", { hasText: "Room 301" }).waitFor();
  if (await fd.locator("label", { hasText: "Room 306" }).count()) throw new Error("306 offered for short stay");
  const priceTxt = await fd.locator("label", { hasText: "Room 301" }).textContent();
  const expected = (Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", hourCycle: "h23" }).format(new Date())) >= 18) ? "15,000" : "10,000";
  if (!priceTxt.includes(expected)) throw new Error(`2h walk-in price should be ₦${expected}: ${priceTxt}`);
  await fd.locator("label", { hasText: "Room 301" }).locator("input[type=radio]").check();
  await fd.getByLabel("New guest").check();
  await fd.fill("input[name=firstName]", "Kemi"); await fd.fill("input[name=lastName]", "Ade"); await fd.fill("input[name=phone]", "08055556666");
  await fd.getByRole("button", { name: "Create reservation" }).click();
  await fd.waitForURL(/\/manage\/front-desk\/check-in\?id=/, { timeout: 20000 });
  await expectText(fd, "clock starts when you check the guest in");
  await submit(fd, "Record payment"); await expectOk(fd, "short-stay payment");
  await fd.fill("input[name=idNumber]", "B7654321");
  await submit(fd, "Check in guest");
  await fd.waitForURL(/\/manage\/reservations\/[a-z0-9]+$/, { timeout: 20000 });
  await fd.locator("span", { hasText: "Checked In" }).first().waitFor({ timeout: 10000 });
  await expectText(fd, "Within the package");
  await shot(fd, "short-stay-checked-in");
  const shortUrl = fd.url();

  log("Short stay checks out cleanly within its package");
  await fd.goto(shortUrl.replace(/\/manage\/reservations\/(.+)$/, "/manage/front-desk/check-out?id=$1"));
  await submit(fd, /Check out/);
  await fd.waitForURL(/\/manage\/reservations\/[a-z0-9]+$/, { timeout: 20000 });
  await fd.locator("span", { hasText: "Checked Out" }).first().waitFor({ timeout: 10000 });

  log("Walk-in overnight in Room 302 → check in → laundry → check out");
  await fd.goto(`${BASE}/manage/reservations/new?walkin=1`);
  await fd.locator("label", { hasText: "Room 302" }).locator("input[type=radio]").check();
  await fd.getByLabel("New guest").check();
  await fd.fill("input[name=firstName]", "Tunde"); await fd.fill("input[name=lastName]", "Bello"); await fd.fill("input[name=phone]", "08022223333");
  await fd.getByRole("button", { name: "Create reservation" }).click();
  await fd.waitForURL(/\/manage\/front-desk\/check-in\?id=/, { timeout: 20000 });
  await fd.locator("input[name=amount]").fill("20000");
  await submit(fd, "Record payment"); await expectOk(fd, "walk-in deposit");
  await fd.fill("input[name=idNumber]", "A12345678");
  await submit(fd, "Check in guest");
  await fd.waitForURL(/\/manage\/reservations\/[a-z0-9]+$/, { timeout: 20000 });
  await fd.locator("span", { hasText: "Checked In" }).first().waitFor({ timeout: 10000 });
  const walkinUrl = fd.url();
  await fd.selectOption("select[name=category]", "LAUNDRY");
  await fd.fill("input[name=description]", "Laundry - 2 shirts"); await fd.fill("input[name=unitPrice]", "2500"); await fd.fill("input[name=quantity]", "2");
  await fd.getByRole("button", { name: "Post charge" }).click(); await expectOk(fd, "post charge");
  await fd.goto(walkinUrl.replace(/\/manage\/reservations\/(.+)$/, "/manage/front-desk/check-out?id=$1"));
  await fd.locator("text=Complete check-out").waitFor();
  await submit(fd, /Check out/);
  const s1 = await status(fd);
  if (!/balance/i.test(s1)) throw new Error("Checkout with balance should have been blocked: " + s1);
  console.log("   ✓ blocked:", s1.trim());
  await submit(fd, "Record payment"); await expectOk(fd, "final payment");
  await fd.waitForTimeout(800);
  await submit(fd, /Check out/);
  await fd.waitForURL(/\/manage\/reservations\/[a-z0-9]+$/, { timeout: 20000 });
  await fd.locator("span", { hasText: "Checked Out" }).first().waitFor({ timeout: 10000 });
  await expectText(fd, "INV-");

  // ───────── Housekeeping ─────────
  const hk = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage(); watch(hk, "hk");
  log("Owner assigns the checkout cleaning task to housekeeping staff");
  await page.goto(`${BASE}/manage/housekeeping`);
  const task = page.locator(".card", { hasText: "Room 302" }).filter({ hasText: "Checkout clean" }).first();
  await task.locator("select[name=assignedToId]").selectOption({ label: "Halima Tester" });
  await task.getByRole("button", { name: "Assign" }).click();
  await expectOk(page, "task assigned");

  log("Housekeeping (mobile) cleans the room; finance blocked");
  await hk.goto(`${BASE}/manage/login`);
  await hk.fill("input[name=email]", HK.email); await hk.fill("input[name=password]", HK.password);
  await hk.getByRole("button", { name: "Sign in" }).click();
  await hk.waitForURL(/\/manage\/profile/);
  await hk.locator("input[name=current]").waitFor();
  await hk.fill("input[name=current]", HK.password); await hk.fill("input[name=password]", HK.newPassword); await hk.fill("input[name=confirm]", HK.newPassword);
  await hk.getByRole("button", { name: "Change password" }).click();
  await hk.waitForURL(/\/manage(\/housekeeping)?$/, { timeout: 15000 });
  await hk.goto(`${BASE}/manage/payments`); await expectText(hk, "You don't have access");
  const exp = await hk.request.get(`${API}/staff/reports/export?type=payments&from=2026-01-01&to=2026-12-31`);
  if (exp.status() !== 403) throw new Error("housekeeping could export payments: " + exp.status());
  console.log("   ✓ finance blocked for housekeeping (page + API)");
  await hk.goto(`${BASE}/manage/housekeeping`);
  await hk.getByRole("button", { name: "Start cleaning" }).first().click();
  await hk.locator("input[name=missingItems]").waitFor();
  await hk.fill("input[name=missingItems]", "1 bath towel");
  await hk.getByRole("button", { name: "Mark clean" }).first().click();
  await expectOk(hk, "marked clean");
  await shot(hk, "housekeeping-mobile");

  log("Supervisor inspection: pass → room ready");
  await page.goto(`${BASE}/manage/housekeeping/inspections`);
  await page.locator(".card", { hasText: "Room 302" }).getByRole("button", { name: /Pass/ }).click();
  await expectOk(page, "inspection");

  log("Maintenance ticket with room block; room hidden from availability; return to service");
  await page.goto(`${BASE}/manage/maintenance`);
  await page.locator("select[name=roomId]").waitFor();
  await page.selectOption("select[name=roomId]", { label: "Room 301" });
  await page.selectOption("select[name=category]", "Air-conditioning");
  await page.fill("textarea[name=description]", "AC not cooling"); await page.selectOption("select[name=priority]", "URGENT");
  await page.selectOption("select[name=block]", "OUT_OF_ORDER");
  await page.getByRole("button", { name: "Create ticket" }).click();
  await page.waitForURL(/\/manage\/maintenance\/[a-z0-9]+$/, { timeout: 15000 });
  const ticketUrl = page.url();
  const avail = (await apiJson(page, `/staff/availability?arrival=${d(0)}&departure=${d(1)}`)).body.rooms;
  if (avail.some((r) => r.number === "301")) throw new Error("Blocked room 301 is still available");
  console.log("   ✓ 301 excluded from availability");
  await page.goto(ticketUrl);
  await page.locator("select[name=status]").waitFor();
  await page.selectOption("select[name=status]", "RESOLVED"); await page.fill("textarea[name=resolution]", "Regassed AC");
  await page.getByRole("button", { name: "Save update" }).click(); await expectOk(page, "ticket resolved");
  await submit(page, "Return room to service", { reason: "AC repaired and tested" });
  await expectOk(page, "return to service");

  log("Refund: request and process part of the guest's payment");
  await page.goto(`${BASE}/manage/reservations?q=${ref}`);
  await page.getByRole("link", { name: ref }).click();
  await page.locator("summary", { hasText: "Request refund" }).click();
  await page.locator("details[open] input[name=amount]").fill("5000");
  await submit(page, "Request", { reason: "Goodwill for late check-in", scope: page.locator("details[open]") });
  await expectOk(page, "refund requested");
  await page.goto(`${BASE}/manage/refunds`);
  await submit(page, "Process", { reason: "Transferred via bank, ref RF123" });
  await expectOk(page, "refund processed");

  log("Reports show short-stay revenue; CSV export; audit trail");
  await page.goto(`${BASE}/manage/reports?preset=year`);
  await expectText(page, "Short-stay revenue"); await expectText(page, "RevPAR");
  const fin = (await apiJson(page, "/staff/reports/financial?preset=year")).body;
  if (!(Number(fin.shortStayRevenue) > 0)) throw new Error("short-stay revenue missing from reports");
  await shot(page, "reports");
  const csv = await page.request.get(`${API}/staff/reports/export?type=payments&from=${d(-30)}&to=${d(1)}`);
  const csvText = await csv.text();
  if (csv.status() !== 200 || !csvText.includes("Reference")) throw new Error("payments CSV export failed");
  console.log("   ✓ CSV export rows:", csvText.trim().split("\n").length - 1);
  for (const a of ["booking_request.submit", "booking_request.allocate", "booking_request.decline", "reservation.create", "pricing.negotiated_rate", "payment.verify", "frontdesk.checkin", "frontdesk.checkout", "refund.process", "room.block", "auth.login", "staff.create", "settings.update", "housekeeping.inspection_pass"]) {
    const r = (await apiJson(page, `/staff/audit?action=${a}`)).body;
    if (!r.rows.length) throw new Error(`audit entry missing: ${a}`);
  }
  console.log("   ✓ audit entries present for all key actions");

  log("Calendar and dashboard render with live data");
  await page.goto(`${BASE}/manage/calendar`);
  await expectText(page, "Reservation calendar");
  await shot(page, "calendar");
  await page.goto(`${BASE}/manage`);
  await expectText(page, "Room status board");
  await shot(page, "dashboard-after");

  log("Guest billing page renders; printable invoice opens");
  await gp.goto(`${BASE}/account/billing?ref=${adaRef}`);
  await expectText(gp, "Itemised account");
  await shot(gp, "guest-billing-mobile");

  log("Guest isolation and portal separation");
  const op = await (await browser.newContext()).newPage(); watch(op, "other");
  await op.goto(`${BASE}/register`);
  await op.fill("input[name=firstName]", "Eve"); await op.fill("input[name=lastName]", "Other");
  await op.fill("input[name=email]", `eve+${stamp}@example.com`); await op.fill("input[name=phone]", "08011112222");
  await op.fill("input[name=password]", "EvePass2026"); await op.fill("input[name=confirm]", "EvePass2026");
  await op.getByRole("button", { name: "Create account" }).click(); await op.waitForURL(`${BASE}/account`);
  const r1 = await op.request.get(`${API}/guest/reservations/${ref}`);
  if (r1.status() !== 404) throw new Error(`Other guest could open booking (status ${r1.status()})`);
  await op.goto(`${BASE}/manage`); await op.waitForURL(/\/manage\/login/);
  const r2 = await op.request.get(`${API}/staff/dashboard`);
  if (r2.status() !== 401) throw new Error("guest reached staff API: " + r2.status());
  console.log("   ✓ guest isolation enforced");

  log("CSRF: a POST without the client header is refused");
  const c = await op.request.post(`${API}/guest/conversations`, { multipart: { channel: "FRONT_DESK", subject: "x", body: "x" } });
  if (c.status() !== 403) throw new Error("POST without header accepted: " + c.status());
  console.log("   ✓ blocked");

  log("Failed login lockout after repeated attempts");
  const lp = await (await browser.newContext()).newPage();
  let lockMsg = "";
  for (let i = 0; i < 6; i++) {
    const r = await lp.request.post(`${API}/auth/staff/login`, { headers: H, multipart: { email: FD.email, password: "wrong-password" } });
    lockMsg = (await r.json()).message;
  }
  if (!/Too many failed attempts/.test(lockMsg)) throw new Error("lockout not triggered: " + lockMsg);
  console.log("   ✓", lockMsg);
} catch (e) {
  console.error("\n✗ FAILED at step", step, "-", e.message);
  for (const p of browser.contexts().flatMap((c) => c.pages())) await p.screenshot({ path: `${SHOTS}/FAIL-${step}-${Math.random().toString(36).slice(2, 6)}.png`, fullPage: true }).catch(() => {});
  errors.push(`FAILED: ${e.message}`);
} finally {
  await browser.close();
  console.log(errors.length ? `\nProblems:\n - ${errors.join("\n - ")}` : "\nAll workflow steps passed with no server errors.");
  process.exit(errors.length ? 1 : 0);
}
