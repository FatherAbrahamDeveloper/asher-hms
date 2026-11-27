import { useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { formatInTimeZone } from "date-fns-tz";
import { useApi } from "@/lib/query";
import { useStaffMe } from "@/lib/auth";
import { CHARGE_LABELS, label, METHOD_LABEL, OPERATIONAL_LABEL, STATUS_LABEL, addDays, dateOnly, fmtDate, fmtDateTime, fmtTime, lagosHour, naira, nightsBetween, nowLagosHHMM, num, stayWhen, todayLagos } from "@/lib/format";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { GetForm, qs } from "@/components/get-form";
import { Alert, Badge, Card, DL, EmptyState, Load, Money, PageHeader, Pagination, Stat, StatusBadge, TableWrap } from "@/components/ui";
import { fileUrl } from "@/lib/api";
import { firstAllowed } from "@/lib/nav";
import { Logo } from "@/components/logo";

const SOURCES = ["ONLINE", "WALK_IN", "TELEPHONE", "EMAIL", "AGENT", "OTHER"];
const low = (s: string) => s.replace(/_/g, " ").toLowerCase();
const ID_TYPES = [["NIN", "NIN"], ["PASSPORT", "Passport"], ["DRIVERS_LICENCE", "Driver's licence"], ["VOTERS_CARD", "Voter's card"]];

// ───────────────────────── Shared pieces ─────────────────────────

function StayTypeBadge({ r }: { r: any }) {
  return r.stayType === "SHORT" ? <Badge tone="blue">Short stay {r.shortStayHours}h</Badge> : null;
}

function PaymentForm({ reservationId, balance, isDepositDefault, can, compact }: { reservationId: string; balance: number; isDepositDefault?: boolean; can: (p: string) => boolean; compact?: boolean }) {
  return (
    <ActionForm action="/staff/payments" className="grid grid-cols-2 gap-2" resetOnSuccess confirm="Record this payment? Recorded payments cannot be deleted.">
      {!compact && <p className="col-span-2 text-sm font-semibold">Record payment · balance {naira(balance)}</p>}
      <input type="hidden" name="reservationId" value={reservationId} />
      <select name="method" className="input"><option value="CASH">Cash</option><option value="POS">POS / card</option><option value="BANK_TRANSFER">Bank transfer</option></select>
      <input name="amount" className="input" defaultValue={balance > 0 ? balance.toFixed(2) : ""} inputMode="decimal" required aria-label="Amount" />
      <input name="externalRef" className="input" placeholder="POS / transfer ref" />
      <input name="payerName" className="input" placeholder="Payer (if different)" />
      <label className="col-span-2 flex items-center gap-2 text-xs"><input type="checkbox" name="isDeposit" defaultChecked={isDepositDefault} /> This is a deposit</label>
      {can("payments.verify") && <label className="col-span-2 flex items-center gap-2 text-xs"><input type="checkbox" name="markVerified" /> Transfer already confirmed on bank statement</label>}
      <div className="col-span-2"><SubmitButton className="btn-primary btn-sm">Record payment</SubmitButton></div>
    </ActionForm>
  );
}

function ChargeForm({ reservationId, categories }: { reservationId: string; categories: string[] }) {
  return (
    <ActionForm action="/staff/folio/charges" className="grid grid-cols-2 gap-2" resetOnSuccess>
      <input type="hidden" name="reservationId" value={reservationId} />
      <select name="category" className="input col-span-2">{categories.map((c) => <option key={c} value={c}>{CHARGE_LABELS[c] ?? c}</option>)}</select>
      <input name="description" className="input col-span-2" placeholder="Description" required />
      <input name="quantity" type="number" min={1} defaultValue={1} className="input" aria-label="Quantity" />
      <input name="unitPrice" className="input" placeholder="Unit price ₦ (incl. VAT)" inputMode="decimal" required />
      <div className="col-span-2"><SubmitButton className="btn-secondary btn-sm">Post charge</SubmitButton></div>
    </ActionForm>
  );
}

function minutesLabel(m: number) { const h = Math.floor(m / 60), mm = m % 60; return h ? `${h}h ${mm}m` : `${mm}m`; }

/** Short-stay timer and what check-out will charge if the guest has run over. */
export function OvertimePanel({ r, o, can }: { r: any; o: any; can: (p: string) => boolean }) {
  if (!o) return null;
  const tone = o.outcome.kind === "WITHIN" ? "green" : "amber";
  return (
    <Alert tone={tone}>
      <p><strong>Short stay:</strong> booked {o.bookedHours}h, used {minutesLabel(o.minutesUsed)} so far (ends {fmtTime(r.endAt)}).</p>
      {o.outcome.kind === "WITHIN" && <p>Within the package — no extra charge.</p>}
      {o.outcome.kind === "UPGRADE" && <p>Over time: moves to the {o.outcome.hours}-hour package at {naira(o.newPrice)}.</p>}
      {o.outcome.kind === "OVERNIGHT" && <p>Past the longest package: the overnight rate of {naira(o.newPrice)} applies.</p>}
      {o.outcome.kind !== "WITHIN" && can("folio.charge") && (
        <ActionForm action={`/staff/reservations/${r.id}/overtime`} className="mt-2" confirm="Apply the overtime charge to this guest's bill now?"><SubmitButton className="btn-secondary btn-sm">Apply overtime charge now</SubmitButton></ActionForm>
      )}
    </Alert>
  );
}

function FolioTotals({ folio }: { folio: any }) {
  return (
    <dl className="space-y-1 text-sm">
      <div className="flex justify-between"><dt>Total charges</dt><dd><Money value={folio.total} /></dd></div>
      <div className="flex justify-between text-xs text-ink-500"><dt>Includes VAT</dt><dd><Money value={folio.tax} /></dd></div>
      <div className="flex justify-between text-emerald-700"><dt>Paid (verified)</dt><dd><Money value={folio.netPaid} /></dd></div>
      {num(folio.pending) > 0 && <div className="flex justify-between text-amber-700"><dt>Pending verification</dt><dd><Money value={folio.pending} /></dd></div>}
      <div className="flex justify-between border-t border-ink-100 pt-1 text-base font-bold"><dt>{num(folio.balance) < 0 ? "Credit due to guest" : "Balance"}</dt><dd><Money value={Math.abs(num(folio.balance))} /></dd></div>
    </dl>
  );
}

// ───────────────────────── Dashboard ─────────────────────────

export function Dashboard() {
  const { user, can } = useStaffMe();
  const allowed = can("dashboard.view");
  const q = useApi<any>(allowed ? "/staff/dashboard" : null, { refetchInterval: 60_000 });
  if (user && !allowed) return <Navigate to={firstAllowed(can)} replace />;
  const quick: [string, string, string][] = [
    ["requests.allocate", "/manage/requests", "Booking forms"],
    ["reservations.create", "/manage/reservations/new", "New reservation"],
    ["reservations.create", "/manage/reservations/new?walkin=1", "Walk-in (overnight)"],
    ["reservations.create", "/manage/reservations/new?walkin=1&type=SHORT", "Walk-in short stay"],
    ["frontdesk.checkin", "/manage/front-desk/check-in", "Check in guest"],
    ["frontdesk.checkout", "/manage/front-desk/check-out", "Check out guest"],
    ["payments.record", "/manage/front-desk/check-out?mode=pay", "Record payment"],
    ["guests.manage", "/manage/guests/new", "Add guest"],
    ["maintenance.report", "/manage/maintenance?new=1", "Maintenance ticket"],
  ];
  const h = lagosHour();
  return (
    <Load q={q}>{(d) => {
      const c = (k: string) => d.counts[k] ?? 0;
      const fin = can("payments.view") || can("reports.view");
      return (
        <div className="space-y-6">
          <PageHeader title={`Good ${h < 12 ? "morning" : h < 17 ? "afternoon" : "evening"}, ${user?.firstName ?? ""}`} subtitle={`${fmtDate(todayLagos())} · live figures from hotel records`} />
          <div className="flex flex-wrap gap-2">{quick.filter(([p]) => can(p)).map(([, href, l], i) => <Link key={href} to={href} className={i === 0 ? "btn-gold btn-sm" : "btn-secondary btn-sm"}>{l}</Link>)}</div>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
            <Stat label="Total rooms" value={d.totalRooms} href="/manage/rooms" />
            <Stat label="Available" value={c("AVAILABLE")} tone="good" href="/manage/rooms" />
            <Stat label="Reserved today" value={c("RESERVED")} href="/manage/front-desk/check-in" />
            <Stat label="Occupied" value={c("OCCUPIED")} href="/manage/rooms" />
            <Stat label="Dirty" value={c("DIRTY")} tone={c("DIRTY") ? "bad" : undefined} href="/manage/housekeeping" />
            <Stat label="Cleaning / to inspect" value={`${c("CLEANING")} / ${c("CLEAN")}`} href="/manage/housekeeping" />
            <Stat label="Maintenance" value={c("MAINTENANCE")} tone={c("MAINTENANCE") ? "warn" : undefined} href="/manage/maintenance" />
            <Stat label="Out of order" value={c("OUT_OF_ORDER")} tone={c("OUT_OF_ORDER") ? "bad" : undefined} href="/manage/rooms" />
          </section>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
            <Stat label="Occupancy" value={`${Number(d.occupancyPct).toFixed(0)}%`} hint={`${d.occupied} of ${d.activeRooms} rooms`} />
            <Stat label="Arrivals today" value={d.arrivals.length} href="/manage/front-desk/check-in" />
            <Stat label="Departures today" value={d.departures.length} href="/manage/front-desk/check-out" />
            <Stat label="In-house" value={d.inHouse} hint={`${d.inHouseGuests} guests`} />
            <Stat label="Booking forms waiting" value={d.newForms ?? 0} tone={d.newForms ? "warn" : undefined} href="/manage/requests" />
            <Stat label="Pending bookings" value={d.pendingRes} tone={d.pendingRes ? "warn" : undefined} href="/manage/reservations?status=PENDING" />
            <Stat label="Upcoming bookings" value={d.reservedFuture} href="/manage/reservations" />
          </section>
          {fin && (
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
              <Stat label="Revenue earned today" value={<Money value={d.todayRevenue} />} hint="excl. VAT" href="/manage/reports" />
              <Stat label="Payments today" value={<Money value={d.todayPayments} />} href="/manage/payments" />
              <Stat label="Revenue this month" value={<Money value={d.monthRevenue} />} href="/manage/reports" />
              <Stat label="Payments this month" value={<Money value={d.monthPayments} />} href="/manage/payments" />
              <Stat label="Outstanding balances" value={<Money value={d.outstandingTotal} />} hint={`${d.outstandingCount} folios`} tone={d.outstandingCount ? "warn" : undefined} href="/manage/reports?tab=outstanding" />
              <Stat label="Payments to verify" value={d.pendingPayments} tone={d.pendingPayments ? "warn" : undefined} href="/manage/payments?status=PENDING" />
            </section>
          )}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Housekeeping tasks" value={d.hkPending} href="/manage/housekeeping" />
            <Stat label="Open maintenance" value={d.mtPending} href="/manage/maintenance" />
            <Stat label="Unread guest messages" value={d.unreadMsgs} tone={d.unreadMsgs ? "warn" : undefined} href="/manage/messages" />
            <Stat label="Open service requests" value={d.srOpen} tone={d.srOpen ? "warn" : undefined} href="/manage/service-requests" />
          </section>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card title={`Today's arrivals (${d.arrivals.length})`} padded={false}>
              {d.arrivals.length === 0 ? <div className="p-4"><EmptyState title="No arrivals today" /></div> : (
                <ul className="divide-y divide-ink-100">{d.arrivals.map((r: any) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
                    <div><Link className="font-medium hover:underline" to={`/manage/reservations/${r.id}`}>{r.guest.firstName} {r.guest.lastName}</Link> <span className="text-ink-500">· Room {r.room.number} · {r.stayType === "SHORT" ? `${fmtTime(r.startAt)} (${r.shortStayHours}h)` : r.reference}</span>{r.expectedArrival && <span className="text-ink-500"> · ETA {r.expectedArrival}</span>}</div>
                    {r.status === "CHECKED_IN" ? <StatusBadge status="CHECKED_IN" label="Arrived" /> : can("frontdesk.checkin") ? <Link className="btn-primary btn-sm" to={`/manage/front-desk/check-in?id=${r.id}`}>Check in</Link> : <StatusBadge status={r.status} label={STATUS_LABEL[r.status]} />}
                  </li>
                ))}</ul>
              )}
            </Card>
            <Card title={`Today's departures (${d.departures.length})`} padded={false}>
              {d.departures.length === 0 ? <div className="p-4"><EmptyState title="No departures today" /></div> : (
                <ul className="divide-y divide-ink-100">{d.departures.map((r: any) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
                    <div><Link className="font-medium hover:underline" to={`/manage/reservations/${r.id}`}>{r.guest.firstName} {r.guest.lastName}</Link> <span className="text-ink-500">· Room {r.room.number}{r.stayType === "SHORT" && ` · until ${fmtTime(r.endAt)}`}</span>{r.checkoutRequestedAt && <span className="ml-1 text-xs text-gold-700">Express checkout requested</span>}</div>
                    {r.status === "CHECKED_OUT" ? <StatusBadge status="CHECKED_OUT" label="Departed" /> : can("frontdesk.checkout") ? <Link className="btn-primary btn-sm" to={`/manage/front-desk/check-out?id=${r.id}`}>Check out</Link> : null}
                  </li>
                ))}</ul>
              )}
            </Card>
          </div>
          <Card title="Room status board" actions={<span className="text-xs text-ink-500">Updated {fmtDateTime(new Date())}</span>}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {d.board.map((b: any) => (
                <Link key={b.room.id} to={`/manage/rooms/${b.room.id}`} className="rounded-lg border border-ink-100 p-3 transition hover:border-gold-300 hover:shadow-sm">
                  <div className="flex items-center justify-between"><span className="font-display text-xl font-semibold">{b.room.number}</span><StatusBadge status={b.status} label={OPERATIONAL_LABEL[b.status]} /></div>
                  <p className="mt-1 truncate text-xs text-ink-500">{b.room.roomType.name}</p>
                  <p className="mt-1 truncate text-xs text-ink-700">{b.inHouse ? `${b.inHouse.guest.firstName} ${b.inHouse.guest.lastName} · until ${b.inHouse.stayType === "SHORT" ? fmtTime(b.inHouse.endAt) : fmtDate(b.inHouse.departureDate)}` : b.arriving ? `Arriving: ${b.arriving.guest.firstName} ${b.arriving.guest.lastName}` : b.block ? b.block.reason : `Housekeeping: ${b.room.housekeepingStatus.toLowerCase()}`}</p>
                </Link>
              ))}
            </div>
          </Card>
        </div>
      );
    }}</Load>
  );
}

// ───────────────────────── Reservations ─────────────────────────

export function Reservations() {
  const [sp] = useSearchParams();
  const { can } = useStaffMe();
  const p = Object.fromEntries(sp.entries());
  const q = useApi<any>(qs("/staff/reservations", p));
  return (
    <div className="space-y-4">
      <PageHeader title="Reservations" subtitle={q.data ? `${q.data.total} matching` : undefined} actions={can("reservations.create") && <><Link to="/manage/reservations/new?walkin=1&type=SHORT" className="btn-secondary">Short stay</Link><Link to="/manage/reservations/new?walkin=1" className="btn-secondary">Walk-in</Link><Link to="/manage/reservations/new" className="btn-gold">New reservation</Link></>} />
      <GetForm className="card grid gap-3 p-3 sm:grid-cols-3 lg:grid-cols-8">
        <label className="lg:col-span-2"><span className="label">Search</span><input name="q" defaultValue={p.q} className="input" placeholder="Reference, guest, phone, room" /></label>
        <label><span className="label">Status</span><select name="status" defaultValue={p.status ?? ""} className="input"><option value="">All</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label><span className="label">Type</span><select name="stayType" defaultValue={p.stayType ?? ""} className="input"><option value="">All</option><option value="NIGHT">Overnight</option><option value="SHORT">Short stay</option></select></label>
        <label><span className="label">Source</span><select name="source" defaultValue={p.source ?? ""} className="input"><option value="">All</option>{SOURCES.map((s) => <option key={s} value={s}>{low(s)}</option>)}</select></label>
        <label><span className="label">Staying from</span><input type="date" name="from" defaultValue={p.from} className="input" /></label>
        <label><span className="label">to</span><input type="date" name="to" defaultValue={p.to} className="input" /></label>
        <div className="flex items-end gap-2"><button className="btn-primary flex-1">Filter</button><Link to="/manage/reservations" className="btn-ghost">Reset</Link></div>
      </GetForm>
      <Load q={q}>{(d) => (
        <>
          <Card padded={false}>
            {d.rows.length === 0 ? <div className="p-4"><EmptyState title="No reservations found" /></div> : (
              <TableWrap><table className="table">
                <thead><tr><th>Reference</th><th>Guest</th><th>Room</th><th>When</th><th>Status</th><th>Source</th><th className="text-right">Total</th><th className="text-right">Balance</th></tr></thead>
                <tbody>{d.rows.map((r: any) => (
                  <tr key={r.id}>
                    <td><Link className="link font-mono" to={`/manage/reservations/${r.id}`}>{r.reference}</Link>{r.rateNegotiated && <p className="text-[10px] text-gold-700">negotiated</p>}</td>
                    <td>{r.guest.firstName} {r.guest.lastName}{r.guest.isVip && <span className="ml-1 text-xs text-gold-600">VIP</span>}<p className="text-xs text-ink-500">{r.guest.phone}</p></td>
                    <td>{r.room.number}</td>
                    <td className="whitespace-nowrap">{stayWhen(r)} <StayTypeBadge r={r} /></td>
                    <td><StatusBadge status={r.status} label={STATUS_LABEL[r.status]} /></td>
                    <td className="text-xs capitalize">{low(r.source)}</td>
                    <td className="text-right"><Money value={d.balances[r.id]?.total} /></td>
                    <td className={`text-right ${num(d.balances[r.id]?.balance) > 0 ? "font-semibold text-amber-700" : ""}`}><Money value={d.balances[r.id]?.balance} /></td>
                  </tr>
                ))}</tbody>
              </table></TableWrap>
            )}
          </Card>
          <Pagination page={d.page} pages={d.pages} makeHref={(n) => qs("/manage/reservations", { ...p, page: n })} />
        </>
      )}</Load>
    </div>
  );
}

export function NewReservation() {
  const [sp, setSp] = useSearchParams();
  const { can } = useStaffMe();
  const navigate = useNavigate();
  const walkin = sp.get("walkin") === "1";
  const type = sp.get("type") === "SHORT" ? "SHORT" : "NIGHT";
  const today = todayLagos();
  const arrival = walkin ? today : sp.get("arrival") ?? today;
  const departure = sp.get("departure") && sp.get("departure")! > arrival ? sp.get("departure")! : addDays(arrival, 1);
  const adults = Math.max(1, Number(sp.get("adults")) || 1), children = Math.max(0, Number(sp.get("children")) || 0);
  const hours = sp.get("hours") ?? "";
  const start = walkin ? nowLagosHHMM() : sp.get("start") ?? "12:00";
  const [guestQ, setGuestQ] = useState("");
  const [guestMode, setGuestMode] = useState<"existing" | "new">("new");
  const [override, setOverride] = useState("");
  const opts = useApi<any>(qs("/staff/booking-options", type === "SHORT" ? { type, arrival, start, hours, adults, children } : { type, arrival, departure, adults, children }));
  const search = useApi<any>(guestQ ? qs("/staff/guests/search", { q: guestQ }) : null);
  const preGuest = useApi<any>(sp.get("guestId") ? `/staff/guests/${sp.get("guestId")}` : null);
  const set = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) v ? n.set(k, v) : n.delete(k); setSp(n, { replace: true }); };
  const negotiate = can("pricing.negotiate");
  const found = search.data?.guests ?? [];

  return (
    <div className="space-y-5">
      <PageHeader title={walkin ? (type === "SHORT" ? "Walk-in short stay" : "Walk-in booking") : "New reservation"} back={{ href: "/manage/reservations", label: "Reservations" }}
        subtitle={walkin ? "Guest is at the desk now — book and check in straight away." : "Telephone, email, agent or in-person bookings."} />
      <Card title="1 · Stay">
        <div className="mb-3 inline-flex rounded-lg border border-ink-200 p-0.5 text-sm">
          {(["NIGHT", "SHORT"] as const).map((t) => <button key={t} type="button" onClick={() => set({ type: t === "SHORT" ? "SHORT" : null, room: null })} className={`rounded-md px-3 py-1.5 ${type === t ? "bg-ink-900 text-white" : "text-ink-600"}`}>{t === "NIGHT" ? "Overnight" : "Short stay (hours)"}</button>)}
        </div>
        <GetForm keep={["walkin", "type", "guestId", "room"]} className="grid gap-3 sm:grid-cols-5">
          <label><span className="label">{type === "SHORT" ? "Date" : "Arrival"}</span><input type="date" name="arrival" defaultValue={arrival} className="input" disabled={walkin} /></label>
          {type === "NIGHT" ? <label><span className="label">Departure</span><input type="date" name="departure" defaultValue={departure} className="input" /></label> : (
            <label><span className="label">Start time</span><input type="time" name="start" defaultValue={start} className="input" disabled={walkin} /></label>
          )}
          {type === "SHORT" && <label><span className="label">Package</span><select name="hours" defaultValue={hours || opts.data?.hours} key={opts.data?.hours} className="input">{(opts.data?.tiers ?? []).map((t: any) => <option key={t.hours} value={t.hours}>{t.label}</option>)}</select></label>}
          <label><span className="label">Adults</span><input type="number" name="adults" min={1} max={10} defaultValue={adults} className="input" /></label>
          <label><span className="label">Children</span><input type="number" name="children" min={0} max={10} defaultValue={children} className="input" /></label>
          <button className="btn-secondary self-end">Find rooms</button>
        </GetForm>
        <p className="mt-2 text-sm text-ink-500">{type === "SHORT" ? `${fmtDate(arrival)} from ${walkin ? "now" : start}` : `${fmtDate(arrival)} → ${fmtDate(departure)} · ${nightsBetween(arrival, departure)} night(s)`}</p>
      </Card>

      <Load q={opts}>{(o) => o.rooms.length === 0 ? <Alert tone="amber">{type === "SHORT" ? "No short-stay rooms are free for that time. Short stays are only offered in rooms set up for them." : "No rooms are available for those dates and guest count."}</Alert> : (
        <ActionForm action="/staff/reservations" className="space-y-5" onSuccess={(r) => !r.data?.redirect && navigate("/manage/reservations")}>
          <input type="hidden" name="stayType" value={type} />
          <input type="hidden" name="arrival" value={arrival} />
          {type === "NIGHT" ? <input type="hidden" name="departure" value={departure} /> : <><input type="hidden" name="startTime" value={walkin ? "now" : start} /><input type="hidden" name="hours" value={o.hours} /></>}
          <input type="hidden" name="adults" value={adults} /><input type="hidden" name="children" value={children} />
          <Card title={`2 · Room (${o.rooms.length} available)`}>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {o.rooms.map((r: any, i: number) => (
                <label key={r.id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-ink-200 p-3 has-[:checked]:border-gold-500 has-[:checked]:bg-gold-50">
                  <input type="radio" name="roomId" value={r.id} required defaultChecked={sp.get("room") ? sp.get("room") === r.id : i === 0} className="mt-1" />
                  <span className="text-sm"><strong className="text-base">Room {r.number}</strong> · {r.roomType.name}<br />
                    <span className="text-ink-500">Up to {r.maxOccupancy} · {type === "SHORT" ? r.quote.label : <><Money value={r.nightlyRate} />/night</>} · {r.housekeepingStatus.toLowerCase()}</span><br />
                    <span className="font-medium">Total <Money value={r.quote.total} /></span>{r.quote.evening && <span className="ml-1 text-xs text-gold-700">evening rate</span>}
                    <span className="block text-xs text-ink-400">Includes VAT</span>
                  </span>
                </label>
              ))}
            </div>
            {negotiate ? (
              <div className="mt-4 grid gap-3 rounded-lg border border-dashed border-gold-300 bg-gold-50/40 p-3 sm:grid-cols-2">
                <label><span className="label">{type === "SHORT" ? "Negotiated package price (₦, optional)" : "Negotiated price per night (₦, optional)"}</span><input name="rateOverride" className="input" inputMode="decimal" placeholder="Leave blank for the standard price" value={override} onChange={(e) => setOverride(e.target.value)} /></label>
                <label><span className="label">Reason for the negotiated price {override && "(required)"}</span><input name="negotiationReason" className="input" placeholder="E.g. regular guest, corporate rate" required={!!override} /></label>
                <p className="text-xs text-ink-500 sm:col-span-2">Final price including VAT. It is recorded against your name in the audit log.</p>
              </div>
            ) : <p className="mt-3 text-xs text-ink-500">Need a different price? Ask a manager — only managers can set negotiated prices.</p>}
          </Card>

          <Card title="3 · Guest">
            <div className="space-y-3">
              {preGuest.data ? (
                <><input type="hidden" name="guestMode" value="existing" /><input type="hidden" name="guestId" value={preGuest.data.guest.id} />
                  <p className="text-sm">Booking for <strong>{preGuest.data.guest.firstName} {preGuest.data.guest.lastName}</strong> ({preGuest.data.guest.phone ?? preGuest.data.guest.email}). <button type="button" className="link" onClick={() => set({ guestId: null })}>Change</button></p></>
              ) : (
                <>
                  <p className="text-sm text-ink-600">Find an existing guest:</p>
                  <div className="flex gap-2">
                    <input className="input" placeholder="Name, phone or email" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setGuestQ((e.target as HTMLInputElement).value.trim()); setGuestMode("existing"); } }} id="guest-q" />
                    <button type="button" className="btn-secondary" onClick={() => { setGuestQ((document.getElementById("guest-q") as HTMLInputElement).value.trim()); setGuestMode("existing"); }}>Search</button>
                  </div>
                  {guestQ && found.length === 0 && !search.isLoading && <p className="text-sm text-ink-500">No guest matches “{guestQ}”. Fill in the new guest details below.</p>}
                  {found.length > 0 && (
                    <div className="space-y-1">{found.map((g: any, i: number) => (
                      <label key={g.id} className="flex items-center gap-2 rounded border border-ink-100 px-3 py-2 text-sm has-[:checked]:border-gold-500 has-[:checked]:bg-gold-50">
                        <input type="radio" name="guestId" value={g.id} defaultChecked={i === 0} /> {g.firstName} {g.lastName} · {g.phone ?? "—"} · {g.email ?? "—"}{g.isVip && " · VIP"}{g.isBlacklisted && " · ⚠ flagged"}
                      </label>
                    ))}</div>
                  )}
                  <fieldset className="rounded-lg border border-ink-100 p-3">
                    <legend className="px-1 text-sm font-medium">Guest</legend>
                    <div className="mb-2 flex gap-4 text-sm">
                      <label className="flex items-center gap-2"><input type="radio" name="guestMode" value="existing" checked={guestMode === "existing" && found.length > 0} disabled={!found.length} onChange={() => setGuestMode("existing")} /> Selected existing guest</label>
                      <label className="flex items-center gap-2"><input type="radio" name="guestMode" value="new" checked={guestMode === "new" || !found.length} onChange={() => setGuestMode("new")} /> New guest</label>
                    </div>
                    {(guestMode === "new" || !found.length) && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label><span className="label">First name</span><input className="input" name="firstName" required /></label>
                        <label><span className="label">Last name</span><input className="input" name="lastName" required /></label>
                        <label><span className="label">Phone</span><input className="input" name="phone" required /></label>
                        <label><span className="label">Email (optional)</span><input className="input" type="email" name="email" /></label>
                      </div>
                    )}
                  </fieldset>
                </>
              )}
              {adults + children > 1 && <div className="grid gap-2 sm:grid-cols-2">{Array.from({ length: adults + children - 1 }).map((_, i) => <input key={i} name="extraGuests" className="input" placeholder={`Accompanying guest ${i + 2} (optional)`} />)}</div>}
            </div>
          </Card>

          <Card title="4 · Booking details">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label><span className="label">Source</span><select name="source" className="input" defaultValue={walkin ? "WALK_IN" : "TELEPHONE"}>{SOURCES.filter((s) => s !== "ONLINE").map((s) => <option key={s} value={s}>{low(s)}</option>)}</select></label>
              <label><span className="label">Status</span><select name="status" className="input" defaultValue="CONFIRMED"><option value="CONFIRMED">Confirmed</option><option value="PENDING">Pending (tentative)</option></select></label>
              <label><span className="label">Payment</span><select name="paymentPlan" className="input" defaultValue={walkin || type === "SHORT" ? "PAY_NOW" : "PAY_AT_HOTEL"}><option value="PAY_AT_HOTEL">Pay at hotel</option><option value="DEPOSIT">Deposit</option><option value="PAY_NOW">Pay in full</option></select></label>
              <label><span className="label">Discount code</span><input name="discountCode" className="input" /></label>
              {type === "NIGHT" && <label><span className="label">Expected arrival</span><input name="expectedArrival" type="time" className="input" /></label>}
              <label className="sm:col-span-2 lg:col-span-3"><span className="label">Special requests</span><input name="specialRequests" className="input" /></label>
            </div>
            {type === "SHORT" && <p className="mt-3 text-xs text-ink-500">Short stays are paid in full before check-in. If the guest stays longer, check-out moves them to the next package automatically.</p>}
            {walkin && can("frontdesk.checkin") && <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" name="checkInNow" defaultChecked /> Go straight to check-in after booking</label>}
            <div className="mt-4"><SubmitButton className="btn-gold">Create reservation</SubmitButton></div>
          </Card>
        </ActionForm>
      )}</Load>
    </div>
  );
}

export function ReservationDetail() {
  const { id } = useParams();
  const { can } = useStaffMe();
  const q = useApi<any>(`/staff/reservations/${id}`);
  const settings = useApi<any>("/public/settings");
  return (
    <Load q={q}>{({ reservation: r, folio, rooms, creator, overtime, categories }) => {
      const active = ["PENDING", "CONFIRMED", "CHECKED_IN"].includes(r.status);
      const today = todayLagos();
      const arr = dateOnly(r.arrivalDate), dep = dateOnly(r.departureDate);
      const short = r.stayType === "SHORT";
      const nights = nightsBetween(arr, dep);
      const tiers = settings.data?.shortStay.tiers ?? [];
      return (
        <div className="space-y-5">
          <PageHeader back={{ href: "/manage/reservations", label: "Reservations" }} title={<span className="font-mono">{r.reference}</span>}
            subtitle={<>{r.guest.firstName} {r.guest.lastName} · Room {r.room.number} · {short ? stayWhen(r) : `${fmtDate(arr)} → ${fmtDate(dep)} (${nights} night${nights > 1 ? "s" : ""})`}</>}
            actions={<><StayTypeBadge r={r} /><StatusBadge status={r.status} label={STATUS_LABEL[r.status]} />{folio && <StatusBadge status={folio.paymentStatus} label={`Payment: ${folio.paymentStatus.toLowerCase()}`} />}</>} />
          <div className="flex flex-wrap gap-2">
            {r.status === "PENDING" && can("reservations.edit") && <ActionForm action={`/staff/reservations/${r.id}/confirm`}><SubmitButton className="btn-primary btn-sm">Confirm booking</SubmitButton></ActionForm>}
            {["PENDING", "CONFIRMED"].includes(r.status) && arr <= today && can("frontdesk.checkin") && <Link to={`/manage/front-desk/check-in?id=${r.id}`} className="btn-gold btn-sm">Check in</Link>}
            {r.status === "CHECKED_IN" && can("frontdesk.checkout") && <Link to={`/manage/front-desk/check-out?id=${r.id}`} className="btn-gold btn-sm">Check out</Link>}
            {["PENDING", "CONFIRMED"].includes(r.status) && arr <= today && can("reservations.cancel") && (
              <ActionForm action={`/staff/reservations/${r.id}/no-show`} requireReason confirm="Mark as no-show? The no-show fee policy will be applied."><SubmitButton className="btn-secondary btn-sm">Mark no-show</SubmitButton></ActionForm>
            )}
            {can("invoices.issue") && <ActionForm action={`/staff/reservations/${r.id}/invoice`}><SubmitButton className="btn-secondary btn-sm">Generate invoice</SubmitButton></ActionForm>}
            <Link to={`/manage/guests/${r.guestId}`} className="btn-secondary btn-sm">Guest profile</Link>
          </div>
          <OvertimePanel r={r} o={overtime} can={can} />
          {r.checkoutRequestedAt && r.status === "CHECKED_IN" && <Alert tone="amber">Guest requested express checkout at {fmtDateTime(r.checkoutRequestedAt)}.</Alert>}
          {r.guest.isBlacklisted && <Alert tone="red">This guest is flagged. Review the guest profile notes before proceeding.</Alert>}

          <div className="grid gap-5 xl:grid-cols-[1fr_400px]">
            <div className="space-y-5">
              <Card title="Booking">
                <DL cols={3} items={[
                  ["Guest", <Link key="g" className="link" to={`/manage/guests/${r.guestId}`}>{r.guest.firstName} {r.guest.lastName}{r.guest.isVip ? " (VIP)" : ""}</Link>],
                  ["Phone", r.guest.phone], ["Email", r.guest.email],
                  ["Room", `${r.room.number} · ${r.room.roomType.name}`],
                  [short ? "Package price" : "Nightly rate", <span key="r"><Money value={r.nightlyRate} />{r.rateNegotiated && <Badge tone="gold" className="ml-1">negotiated</Badge>}</span>],
                  ["Standard price", r.rateNegotiated ? <Money key="s" value={r.standardRate} /> : null],
                  ["Negotiation reason", r.negotiationReason],
                  ["Occupancy", `${r.adults} adult(s), ${r.children} child(ren)`],
                  ["Stay type", short ? `Short stay · ${r.shortStayHours} hours` : "Overnight"],
                  [short ? "Starts" : "Arrival", short ? fmtDateTime(r.startAt) : fmtDate(arr)], [short ? "Ends" : "Departure", short ? fmtDateTime(r.endAt) : fmtDate(dep)], ["Expected arrival", r.expectedArrival],
                  ["Source", low(r.source)], ["Payment plan", low(r.paymentPlan)], ["Discount code", r.discountCode],
                  ["Created", `${fmtDateTime(r.createdAt)}${creator ? ` by ${creator.firstName} ${creator.lastName}` : r.source === "ONLINE" ? " (online)" : ""}`], ["Last modified", fmtDateTime(r.updatedAt)], ["Hold expires", r.holdExpiresAt ? fmtDateTime(r.holdExpiresAt) : null],
                  ["Checked in", r.checkedInAt ? fmtDateTime(r.checkedInAt) : null], ["Checked out", r.checkedOutAt ? fmtDateTime(r.checkedOutAt) : null], ["Pre-arrival check-in", r.preCheckInAt ? fmtDateTime(r.preCheckInAt) : "Not done"],
                  ["Other guests", r.extraGuests.map((e: any) => e.fullName).join(", ") || null], ["Special requests", r.specialRequests], ["Cancellation reason", r.cancelReason],
                ]} />
              </Card>

              {folio && (
                <Card title="Folio (guest account)" padded={false} actions={r.invoices.length > 0 && <span className="text-xs">Invoices: {r.invoices.map((i: any) => <Link key={i.id} target="_blank" className="link ml-1" to={`/documents/invoice/${i.id}`}>{i.number}</Link>)}</span>}>
                  <TableWrap><table className="table">
                    <thead><tr><th>Date</th><th>Description</th><th>Category</th><th className="text-right">Net</th><th className="text-right">VAT+SC</th><th className="text-right">Total</th><th>Posted by</th><th /></tr></thead>
                    <tbody>{folio.lines.map((l: any) => (
                      <tr key={l.id} className={l.isReversed || l.reversalOfId ? "text-ink-400" : ""}>
                        <td className="whitespace-nowrap">{fmtDate(l.serviceDate)}</td>
                        <td>{l.description}{l.reason && <p className="text-xs text-ink-400">{l.reason}</p>}</td>
                        <td className="text-xs">{CHARGE_LABELS[l.category]}</td>
                        <td className="text-right"><Money value={l.amount} /></td>
                        <td className="text-right"><Money value={num(l.tax) + num(l.serviceCharge)} /></td>
                        <td className="text-right font-medium"><Money value={l.lineTotal} /></td>
                        <td className="text-xs">{l.postedByName ?? "—"}</td>
                        <td>{can("folio.adjust") && !l.isReversed && !l.reversalOfId && (
                          <ActionForm action={`/staff/folio/charges/${l.id}/reverse`} requireReason confirm={`Reverse "${l.description}"? A negative line will be posted; the original stays on record.`}><SubmitButton className="btn-ghost btn-sm" pendingText="…">Reverse</SubmitButton></ActionForm>
                        )}{l.isReversed && <Badge>reversed</Badge>}</td>
                      </tr>
                    ))}</tbody>
                  </table></TableWrap>
                  <div className="grid gap-4 p-4 md:grid-cols-2">
                    <div className="md:order-2"><FolioTotals folio={folio} /></div>
                    <div className="space-y-4">
                      {can("folio.charge") && active && <div><p className="mb-2 text-sm font-semibold">Post a charge</p><ChargeForm reservationId={r.id} categories={categories} /></div>}
                      {(can("folio.adjust") || can("pricing.negotiate")) && (
                        <ActionForm action="/staff/folio/adjustments" className="grid grid-cols-2 gap-2" requireReason confirm="Post this discount/adjustment? It will be recorded with your name and reason." resetOnSuccess>
                          <p className="col-span-2 text-sm font-semibold">Discount / adjustment</p>
                          <input type="hidden" name="reservationId" value={r.id} />
                          <select name="kind" className="input">{can("pricing.negotiate") && <option value="DISCOUNT">Discount</option>}{can("folio.adjust") && <option value="ADJUSTMENT">Adjustment (+/−)</option>}</select>
                          <input name="amount" className="input" placeholder="Amount ₦" required />
                          <input name="description" className="input col-span-2" placeholder="Description shown on bill" required />
                          <div className="col-span-2"><SubmitButton className="btn-secondary btn-sm">Post</SubmitButton></div>
                        </ActionForm>
                      )}
                    </div>
                  </div>
                </Card>
              )}

              {can("reservations.edit") && active && (
                <Card title={short ? "Change short stay" : r.status === "CHECKED_IN" ? "Extend / shorten stay or move room" : "Modify reservation"}>
                  <ActionForm action={`/staff/reservations/${r.id}/modify`} className="grid gap-3 sm:grid-cols-3" confirm="Save changes? Charges will be recalculated.">
                    <label><span className="label">{short ? "Date" : "Arrival"}</span><input type="date" name="arrival" className="input" defaultValue={arr} readOnly={r.status === "CHECKED_IN"} /></label>
                    {short ? <>
                      <label><span className="label">Start time</span><input type="time" name="startTime" className="input" defaultValue={formatInTimeZone(new Date(r.startAt), "Africa/Lagos", "HH:mm")} readOnly={r.status === "CHECKED_IN"} /></label>
                      <label><span className="label">Package</span><select name="hours" className="input" defaultValue={r.shortStayHours}>{tiers.map((t: any) => <option key={t.hours} value={t.hours}>{t.label}</option>)}</select></label>
                    </> : <label><span className="label">Departure</span><input type="date" name="departure" className="input" defaultValue={dep} /></label>}
                    <label><span className="label">Room</span><select name="roomId" className="input" defaultValue={r.roomId}>{rooms.filter((rm: any) => !short || rm.allowShortStay || rm.id === r.roomId).map((rm: any) => <option key={rm.id} value={rm.id}>Room {rm.number} (max {rm.maxOccupancy})</option>)}</select></label>
                    <label><span className="label">Adults</span><input type="number" name="adults" min={1} max={10} className="input" defaultValue={r.adults} /></label>
                    <label><span className="label">Children</span><input type="number" name="children" min={0} max={10} className="input" defaultValue={r.children} /></label>
                    {can("pricing.negotiate") && <>
                      <label><span className="label">{short ? "Negotiated package price" : "Negotiated nightly price"}</span><input name="rateOverride" className="input" placeholder="Blank = keep current" /></label>
                      <label className="sm:col-span-2"><span className="label">Reason for negotiated price</span><input name="negotiationReason" className="input" placeholder="Required when setting a price" /></label>
                    </>}
                    {!short && <label><span className="label">Expected arrival</span><input name="expectedArrival" type="time" className="input" defaultValue={r.expectedArrival ?? ""} /></label>}
                    <label className="sm:col-span-2"><span className="label">Special requests</span><input name="specialRequests" className="input" defaultValue={r.specialRequests ?? ""} /></label>
                    <label className="sm:col-span-3"><span className="label">Reason for change</span><input name="reason" className="input" placeholder="E.g. guest extended by phone" /></label>
                    <div className="sm:col-span-3"><SubmitButton>Save changes</SubmitButton></div>
                  </ActionForm>
                  {short && (
                    <ActionForm action={`/staff/reservations/${r.id}/modify`} className="mt-5 flex flex-wrap items-end gap-3 border-t border-ink-100 pt-4" confirm="Convert this short stay to an overnight stay? The short-stay charge is replaced by the nightly rate.">
                      <input type="hidden" name="convertToNight" value="on" /><input type="hidden" name="arrival" value={arr} /><input type="hidden" name="roomId" value={r.roomId} />
                      <input type="hidden" name="adults" value={r.adults} /><input type="hidden" name="children" value={r.children} />
                      <p className="w-full text-sm font-semibold">Guest wants to stay the night?</p>
                      <label><span className="label">Departure date</span><input type="date" name="departure" className="input" defaultValue={addDays(arr, 1)} min={addDays(arr, 1)} /></label>
                      <input type="hidden" name="reason" value="Converted to overnight" />
                      <SubmitButton className="btn-secondary">Convert to overnight stay</SubmitButton>
                    </ActionForm>
                  )}
                </Card>
              )}
            </div>

            <div className="space-y-5">
              {folio && (
                <Card title="Payments" padded={false}>
                  <ul className="divide-y divide-ink-100">
                    {folio.payments.length === 0 && <li className="p-4 text-sm text-ink-500">No payments yet.</li>}
                    {folio.payments.map((p: any) => {
                      const refundable = num(p.amount) - p.refunds.filter((x: any) => x.status !== "REJECTED").reduce((a: number, x: any) => a + num(x.amount), 0);
                      return (
                        <li key={p.id} className="space-y-2 p-4 text-sm">
                          <div className="flex items-start justify-between gap-2">
                            <div><p className="font-medium"><Money value={p.amount} /> · {METHOD_LABEL[p.method]} {p.isDeposit && <Badge tone="gold">deposit</Badge>}</p>
                              <p className="text-xs text-ink-500">{p.reference}{p.externalRef && ` · ext ${p.externalRef}`} · {fmtDateTime(p.receivedAt)}</p>
                              <p className="text-xs text-ink-500">Recorded by {p.recordedByName ?? "—"}{p.verifiedByName && ` · ${p.status === "VERIFIED" ? "verified" : "reviewed"} by ${p.verifiedByName}`}</p>
                              {p.proofPath && <a className="link text-xs" target="_blank" rel="noreferrer" href={fileUrl(p.proofPath)!}>View proof of payment</a>}
                              {p.rejectionReason && <p className="text-xs text-red-600">{p.rejectionReason}</p>}
                            </div>
                            <StatusBadge status={p.status} />
                          </div>
                          {p.refunds.map((x: any) => <p key={x.id} className="text-xs">Refund <Money value={x.amount} /> <StatusBadge status={x.status} /> — {x.reason}</p>)}
                          <div className="flex flex-wrap gap-2">
                            {p.receipt && <Link className="btn-secondary btn-sm" target="_blank" to={`/documents/receipt/${p.id}`}>Receipt {p.receipt.number}</Link>}
                            {p.status === "PENDING" && can("payments.verify") && <>
                              <ActionForm action={`/staff/payments/${p.id}/verify`} confirm={`Confirm ${naira(p.amount)} has been received in the hotel account?`}><SubmitButton className="btn-primary btn-sm">Verify</SubmitButton></ActionForm>
                              <ActionForm action={`/staff/payments/${p.id}/reject`} requireReason confirm="Reject this payment? The guest will be notified."><SubmitButton className="btn-danger btn-sm">Reject</SubmitButton></ActionForm>
                            </>}
                          </div>
                          {p.status === "VERIFIED" && refundable > 0 && can("refunds.request") && (
                            <details className="rounded border border-ink-100 p-2"><summary className="cursor-pointer text-xs font-medium">Request refund</summary>
                              <ActionForm action="/staff/refunds" className="mt-2 grid grid-cols-2 gap-2" requireReason confirm="Submit this refund for approval?">
                                <input type="hidden" name="paymentId" value={p.id} />
                                <input name="amount" className="input" defaultValue={refundable.toFixed(2)} />
                                <select name="method" className="input" defaultValue={p.method}><option value="CASH">Cash</option><option value="BANK_TRANSFER">Bank transfer</option><option value="POS">POS reversal</option><option value="CARD_ONLINE">Card (gateway)</option></select>
                                <div className="col-span-2"><SubmitButton className="btn-secondary btn-sm">Request</SubmitButton></div>
                              </ActionForm>
                            </details>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {can("payments.record") && num(folio.balance) > 0 && (
                    <div className="border-t border-ink-100 bg-ink-50/50 p-4"><PaymentForm reservationId={r.id} balance={num(folio.balance)} isDepositDefault={r.status !== "CHECKED_IN" && num(folio.netPaid) === 0 && !short} can={can} /></div>
                  )}
                </Card>
              )}
              {["PENDING", "CONFIRMED"].includes(r.status) && can("reservations.cancel") && (
                <Card title="Cancel reservation">
                  <ActionForm action={`/staff/reservations/${r.id}/cancel`} requireReason confirm="Cancel this reservation? The room will be released.">
                    {!short && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="waiveFee" /> Waive late cancellation fee</label>}
                    <div className="mt-3"><SubmitButton className="btn-danger btn-sm">Cancel reservation</SubmitButton></div>
                  </ActionForm>
                </Card>
              )}
              <Card title="History">
                <ol className="space-y-3 text-sm">{r.history.map((h: any) => (
                  <li key={h.id} className="border-l-2 border-gold-300 pl-3">
                    <p className="font-medium capitalize">{low(h.action)}{h.toStatus && <> → <StatusBadge status={h.toStatus} label={STATUS_LABEL[h.toStatus]} /></>}</p>
                    <p className="text-xs text-ink-500">{fmtDateTime(h.createdAt)} · {h.actorName ?? "System"}</p>
                    {h.details != null && <details className="text-xs text-ink-500"><summary className="cursor-pointer">Details</summary><pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-ink-50 p-2">{JSON.stringify(h.details, null, 2)}</pre></details>}
                  </li>
                ))}</ol>
              </Card>
              {r.serviceRequests.length > 0 && (
                <Card title="Service requests"><ul className="space-y-2 text-sm">{r.serviceRequests.map((s: any) => <li key={s.id} className="flex justify-between gap-2"><span>{s.category}: {s.description.slice(0, 60)}</span><StatusBadge status={s.status} /></li>)}</ul></Card>
              )}
            </div>
          </div>
        </div>
      );
    }}</Load>
  );
}

// ───────────────────────── Calendar ─────────────────────────

const COLORS: Record<string, string> = {
  PENDING: "bg-amber-100 border-amber-300 text-amber-900", CONFIRMED: "bg-sky-100 border-sky-300 text-sky-900",
  CHECKED_IN: "bg-violet-200 border-violet-400 text-violet-900", CHECKED_OUT: "bg-ink-100 border-ink-200 text-ink-500",
};

export function Calendar() {
  const [sp, setSp] = useSearchParams();
  const { can } = useStaffMe();
  const q = useApi<any>(qs("/staff/calendar", { start: sp.get("start"), days: sp.get("days") }));
  return (
    <Load q={q}>{({ start, days, today, rooms }) => {
      const dates = Array.from({ length: days }, (_, i) => addDays(start, i));
      const go = (s: string) => setSp({ start: s, days: String(days) });
      return (
        <div className="space-y-4">
          <PageHeader title="Reservation calendar" subtitle="Rooms down the side, dates across. Click an empty cell to book it. Short stays show as small chips." actions={<>
            <button className="btn-secondary btn-sm" onClick={() => go(addDays(start, -days))}>← Previous</button>
            <button className="btn-secondary btn-sm" onClick={() => go(addDays(today, -1))}>Today</button>
            <button className="btn-secondary btn-sm" onClick={() => go(addDays(start, days))}>Next →</button>
          </>} />
          <GetForm className="flex flex-wrap items-end gap-2">
            <label><span className="label">Start</span><input type="date" name="start" defaultValue={start} className="input" /></label>
            <label><span className="label">Days</span><select name="days" defaultValue={days} className="input">{[7, 14, 21, 31].map((d) => <option key={d}>{d}</option>)}</select></label>
            <button className="btn-secondary">Go</button>
            <div className="ml-auto flex flex-wrap gap-2 text-xs">
              <span className="rounded border border-ink-200 bg-white px-2 py-1">Available</span>
              <span className={`rounded border px-2 py-1 ${COLORS.PENDING}`}>Pending</span>
              <span className={`rounded border px-2 py-1 ${COLORS.CONFIRMED}`}>Reserved</span>
              <span className={`rounded border px-2 py-1 ${COLORS.CHECKED_IN}`}>Occupied</span>
              <span className="rounded border border-amber-400 bg-amber-100 px-2 py-1">Maintenance</span>
              <span className="rounded border border-ink-700 bg-ink-700 px-2 py-1 text-white">Out of order</span>
            </div>
          </GetForm>
          <div className="card overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead><tr>
                <th className="sticky left-0 z-10 w-20 border-b border-r border-ink-100 bg-white px-2 py-2 text-left">Room</th>
                {dates.map((d) => <th key={d} className={`min-w-[64px] border-b border-ink-100 px-1 py-2 text-center font-medium ${d === today ? "bg-gold-50 text-gold-700" : "text-ink-500"}`}>{formatInTimeZone(new Date(d + "T00:00:00Z"), "UTC", "EEE")}<br /><span className="text-sm text-ink-800">{formatInTimeZone(new Date(d + "T00:00:00Z"), "UTC", "d MMM")}</span></th>)}
              </tr></thead>
              <tbody>{rooms.map((room: any) => {
                const nightsRes = room.reservations.filter((r: any) => r.stayType !== "SHORT");
                const shorts = room.reservations.filter((r: any) => r.stayType === "SHORT");
                const cells: ReactNode[] = [];
                let i = 0;
                while (i < dates.length) {
                  const d = dates[i];
                  const covering = nightsRes.filter((r: any) => dateOnly(r.arrivalDate) <= d && dateOnly(r.departureDate) > d);
                  const block = room.blocks.find((b: any) => dateOnly(b.startDate) <= d && (!b.endDate || dateOnly(b.endDate) > d));
                  const dayShorts = shorts.filter((r: any) => dateOnly(r.arrivalDate) === d);
                  const chips = dayShorts.map((r: any) => <Link key={r.id} to={`/manage/reservations/${r.id}`} className={`mt-0.5 block truncate rounded border px-1 py-0.5 text-[10px] ${COLORS[r.status]}`} title={`${r.reference} · ${r.guest.firstName} ${r.guest.lastName}`}>{fmtTime(r.startAt)} {r.shortStayHours}h · {r.guest.firstName}</Link>);
                  if (covering.length > 1) {
                    cells.push(<td key={d} className="border border-red-500 bg-red-100 p-1 text-center text-red-800" title="Conflicting reservations">{covering.map((c: any) => <Link key={c.id} to={`/manage/reservations/${c.id}`} className="block underline">{c.reference}</Link>)}</td>);
                    i++;
                  } else if (covering.length === 1) {
                    const r = covering[0];
                    const last = dateOnly(r.departureDate);
                    let span = 0;
                    while (i + span < dates.length && dates[i + span] < last) span++;
                    cells.push(<td key={d} colSpan={span} className="border border-ink-100 p-0.5"><Link to={`/manage/reservations/${r.id}`} className={`block truncate rounded border px-1.5 py-1.5 font-medium ${COLORS[r.status]}`} title={`${r.reference} · ${r.guest.firstName} ${r.guest.lastName}`}>{r.guest.firstName} {r.guest.lastName.charAt(0)}. · {r.reference}</Link></td>);
                    i += span;
                  } else if (block) {
                    cells.push(<td key={d} className={`border border-ink-100 p-1 text-center ${block.type === "OUT_OF_ORDER" ? "bg-ink-700 text-white" : "bg-amber-100 text-amber-900"}`} title={block.reason}>{block.type === "OUT_OF_ORDER" ? "OOO" : "Maint."}</td>);
                    i++;
                  } else {
                    cells.push(
                      <td key={d} className={`border border-ink-100 p-0.5 align-top ${d === today ? "bg-gold-50/50" : ""}`}>
                        {chips}
                        {room.isActive && d >= today && can("reservations.create") ? <Link to={`/manage/reservations/new?room=${room.id}&arrival=${d}&departure=${addDays(d, 1)}`} className={`block rounded hover:bg-emerald-50 ${chips.length ? "h-3" : "h-7"}`} aria-label={`Book room ${room.number} on ${d}`} /> : !chips.length && <span className="block h-7" />}
                      </td>,
                    );
                    i++;
                  }
                }
                return (
                  <tr key={room.id}>
                    <th className="sticky left-0 z-10 border-r border-ink-100 bg-white px-2 py-1 text-left"><Link to={`/manage/rooms/${room.id}`} className="font-display text-base font-semibold hover:underline">{room.number}</Link>{!room.isActive && <p className="text-[10px] text-red-600">inactive</p>}</th>
                    {cells}
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        </div>
      );
    }}</Load>
  );
}

// ───────────────────────── Availability ─────────────────────────

export function Availability() {
  const [sp] = useSearchParams();
  const { can } = useStaffMe();
  const q = useApi<any>(qs("/staff/availability", Object.fromEntries(sp.entries())));
  return (
    <div className="space-y-4">
      <PageHeader title="Room availability" subtitle="Calculated from reservations and room blocks — not from manual status flags." actions={can("reservations.create") && <Link to="/manage/reservations/new?type=SHORT" className="btn-secondary">Short-stay availability</Link>} />
      <Load q={q}>{(d) => (
        <>
          <GetForm className="card grid gap-3 p-3 sm:grid-cols-4">
            <label><span className="label">Arrival</span><input type="date" name="arrival" defaultValue={d.arrival} className="input" /></label>
            <label><span className="label">Departure</span><input type="date" name="departure" defaultValue={d.departure} className="input" /></label>
            <label><span className="label">Guests</span><input type="number" name="guests" min={1} defaultValue={d.guests} className="input" /></label>
            <button className="btn-primary self-end">Check</button>
          </GetForm>
          <Card title={`${d.rooms.length} room(s) free · ${fmtDate(d.arrival)} → ${fmtDate(d.departure)} (${d.nights} night${d.nights > 1 ? "s" : ""})`} padded={false}>
            {d.rooms.length === 0 ? <div className="p-4"><EmptyState title="Fully booked for these dates" /></div> : (
              <TableWrap><table className="table">
                <thead><tr><th>Room</th><th>Type</th><th>Max guests</th><th>Short stays</th><th>Housekeeping</th><th className="text-right">Rate</th><th className="text-right">Stay total</th><th /></tr></thead>
                <tbody>{d.rooms.map((r: any) => (
                  <tr key={r.id}>
                    <td className="font-semibold">{r.number}</td><td>{r.roomType.name}</td><td>{r.maxOccupancy}</td><td>{r.allowShortStay ? "Yes" : "No"}</td><td className="capitalize">{r.housekeepingStatus.toLowerCase()}</td>
                    <td className="text-right"><Money value={r.nightlyRate} /></td><td className="text-right"><Money value={r.quote.total} /></td>
                    <td className="text-right">{can("reservations.create") && <Link className="btn-primary btn-sm" to={`/manage/reservations/new?room=${r.id}&arrival=${d.arrival}&departure=${d.departure}&adults=${d.guests}`}>Book</Link>}</td>
                  </tr>
                ))}</tbody>
              </table></TableWrap>
            )}
          </Card>
        </>
      )}</Load>
    </div>
  );
}

// ───────────────────────── Check-in / Check-out ─────────────────────────

function QueueList({ list, selId, link, empty, render }: { list: any[]; selId: string | null; link: (id: string) => string; empty: string; render: (r: any) => ReactNode }) {
  if (!list.length) return <div className="p-4"><EmptyState title={empty} /></div>;
  return <ul className="divide-y divide-ink-100">{list.map((r) => <li key={r.id}><Link to={link(r.id)} className={`block px-4 py-3 text-sm hover:bg-ink-50 ${selId === r.id ? "bg-gold-50" : ""}`}>{render(r)}</Link></li>)}</ul>;
}

export function CheckIn() {
  const [sp] = useSearchParams();
  const { can } = useStaffMe();
  const s = sp.get("q") ?? "", id = sp.get("id");
  const list = useApi<any>(qs("/staff/front-desk/arrivals", { q: s }));
  const sel = useApi<any>(id ? `/staff/front-desk/${id}` : null);
  return (
    <div className="space-y-5">
      <PageHeader title="Check-in" subtitle={`Arrivals for ${fmtDate(todayLagos())}`} actions={can("reservations.create") && <><Link to="/manage/reservations/new?walkin=1&type=SHORT" className="btn-secondary">Walk-in short stay</Link><Link to="/manage/reservations/new?walkin=1" className="btn-gold">Walk-in guest</Link></>} />
      <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
        <Card title="Find booking" padded={false}>
          <GetForm className="flex gap-2 border-b border-ink-100 p-3"><input name="q" defaultValue={s} className="input" placeholder="Reference, name or phone" /><button className="btn-secondary">Search</button></GetForm>
          <Load q={list}>{(d) => <QueueList list={d.list} selId={id} empty={s ? "No matching bookings" : "No arrivals pending"} link={(x) => qs("/manage/front-desk/check-in", { id: x, q: s })} render={(r) => <>
            <p className="font-medium">{r.guest.firstName} {r.guest.lastName} {r.preCheckInAt && <span className="text-xs text-emerald-700">· pre-checked-in</span>}</p>
            <p className="text-xs text-ink-500">{r.reference} · Room {r.room.number} · {r.stayType === "SHORT" ? `${fmtTime(r.startAt)} (${r.shortStayHours}h)` : fmtDate(r.arrivalDate)} · <StatusBadge status={r.status} label={STATUS_LABEL[r.status]} /></p>
          </>} />}</Load>
        </Card>
        {!id ? <EmptyState title="Select a booking to check in" body="Search by booking reference, guest name or phone number." /> : (
          <Load q={sel}>{({ reservation: r, folio, depositDue, depositPercent }) => {
            const short = r.stayType === "SHORT";
            const owed = num(depositDue) - num(folio.netPaid);
            return (
              <div className="space-y-4">
                <Card title={<>Check in <span className="font-mono">{r.reference}</span> <StayTypeBadge r={r} /></>} actions={<Link className="link text-sm" to={`/manage/reservations/${r.id}`}>Full reservation →</Link>}>
                  <DL cols={3} items={[
                    ["Guest", `${r.guest.firstName} ${r.guest.lastName}${r.guest.isVip ? " (VIP)" : ""}`], ["Phone", r.guest.phone], ["Email", r.guest.email],
                    ["Room", `${r.room.number} · ${r.room.roomType.name}`], ["Stay", stayWhen(r)], ["Guests", `${r.adults} + ${r.children}`],
                    ["Room readiness", <StatusBadge key="hk" status={r.room.housekeepingStatus} />], ["Status", <StatusBadge key="s" status={r.status} label={STATUS_LABEL[r.status]} />], ["Pre-arrival", r.preCheckInAt ? fmtDateTime(r.preCheckInAt) : "Not done"],
                    ["Special requests", r.specialRequests],
                  ]} />
                  {short && <div className="mt-3"><Alert>The {r.shortStayHours}-hour clock starts when you check the guest in.</Alert></div>}
                  {r.room.housekeepingStatus !== "INSPECTED" && <div className="mt-3"><Alert tone="amber">Room {r.room.number} has not passed inspection ({r.room.housekeepingStatus.toLowerCase()}). Ask housekeeping to finish, or move the guest to a ready room from the reservation page.</Alert></div>}
                  {r.guest.isBlacklisted && <div className="mt-3"><Alert tone="red">Guest is flagged — manager review required.</Alert></div>}
                </Card>
                <Card title="Payment">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <dl className="space-y-1 text-sm">
                      <div className="flex justify-between"><dt>Stay total (incl. VAT)</dt><dd><Money value={folio.total} /></dd></div>
                      <div className="flex justify-between"><dt>Paid (verified)</dt><dd><Money value={folio.netPaid} /></dd></div>
                      {num(folio.pending) > 0 && <div className="flex justify-between text-amber-700"><dt>Pending verification</dt><dd><Money value={folio.pending} /></dd></div>}
                      <div className="flex justify-between"><dt>{short ? "Required before check-in (full)" : `Deposit required (${depositPercent}%)`}</dt><dd><Money value={depositDue} /></dd></div>
                      <div className="flex justify-between font-semibold"><dt>Balance</dt><dd><Money value={folio.balance} /></dd></div>
                      <p className="pt-1 text-xs text-ink-500">Plan: {low(r.paymentPlan)}</p>
                    </dl>
                    {can("payments.record") && num(folio.balance) > 0 && <PaymentForm reservationId={r.id} balance={num(folio.balance)} isDepositDefault={!short && num(folio.netPaid) === 0} can={can} compact />}
                  </div>
                </Card>
                <Card title="Identification & confirm">
                  <ActionForm action={`/staff/reservations/${r.id}/check-in`} className="grid gap-3 sm:grid-cols-2" confirm={`Check ${r.guest.firstName} into Room ${r.room.number}?`}>
                    {r.guest.idOnFile && <p className="text-sm sm:col-span-2">ID on file: {r.guest.idType} {r.guest.idOnFile}. Enter a new number only if different.</p>}
                    <label><span className="label">ID type</span><select name="idType" className="input" defaultValue={r.guest.idType ?? "NIN"}>{ID_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
                    <label><span className="label">ID number {r.guest.idOnFile ? "(optional)" : ""}</span><input name="idNumber" className="input" autoComplete="off" required={!r.guest.idOnFile} /></label>
                    <label className="sm:col-span-2"><span className="label">Notes</span><input name="notes" className="input" placeholder="E.g. key cards issued: 2" /></label>
                    {owed > 0.009 && (short || r.paymentPlan !== "PAY_AT_HOTEL") && <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="allowUnpaid" /> Manager approved check-in without the required payment (recorded in audit log)</label>}
                    <div className="sm:col-span-2"><SubmitButton className="btn-gold">Check in guest</SubmitButton></div>
                  </ActionForm>
                </Card>
              </div>
            );
          }}</Load>
        )}
      </div>
    </div>
  );
}

export function CheckOut() {
  const [sp] = useSearchParams();
  const { can } = useStaffMe();
  const s = sp.get("q") ?? "", id = sp.get("id"), payMode = sp.get("mode") === "pay";
  const today = todayLagos();
  const list = useApi<any>(qs("/staff/front-desk/in-house", { q: s, mode: payMode ? "pay" : null }));
  const sel = useApi<any>(id ? `/staff/front-desk/${id}` : null, { refetchInterval: 60_000 });
  return (
    <div className="space-y-5">
      <PageHeader title={payMode ? "Record payment" : "Check-out"} subtitle={payMode ? "Find a guest account to take a payment." : `In-house guests · departures due ${fmtDate(today)} shown first`} />
      <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
        <Card title={payMode ? "Find guest account" : "In-house"} padded={false}>
          <GetForm keep={["mode"]} className="flex gap-2 border-b border-ink-100 p-3"><input name="q" defaultValue={s} className="input" placeholder="Reference, room, name, phone" /><button className="btn-secondary">Search</button></GetForm>
          <Load q={list}>{(d) => <QueueList list={d.list} selId={id} empty="No guests found" link={(x) => qs("/manage/front-desk/check-out", { id: x, q: s, mode: payMode ? "pay" : null })} render={(r) => <>
            <p className="font-medium">Room {r.room.number} · {r.guest.firstName} {r.guest.lastName} <StayTypeBadge r={r} /></p>
            <p className="text-xs text-ink-500">{r.reference} · {r.stayType === "SHORT" ? `until ${fmtTime(r.endAt)}` : `departs ${fmtDate(r.departureDate)}`}{r.status === "CHECKED_IN" && (r.stayType === "SHORT" ? new Date(r.endAt) <= new Date() : dateOnly(r.departureDate) <= today) && <span className="ml-1 font-semibold text-amber-700">due now</span>}{r.checkoutRequestedAt && <span className="ml-1 text-gold-700">· express requested</span>}</p>
          </>} />}</Load>
        </Card>
        {!id ? <EmptyState title="Select a guest" /> : (
          <Load q={sel}>{({ reservation: r, folio, overtime, categories }) => (
            <div className="space-y-4">
              <OvertimePanel r={r} o={overtime} can={can} />
              <Card title={<>Room {r.room.number} · {r.guest.firstName} {r.guest.lastName} <span className="font-mono text-ink-500">({r.reference})</span></>} padded={false} actions={<Link className="link text-sm" to={`/manage/reservations/${r.id}`}>Full folio →</Link>}>
                <TableWrap><table className="table">
                  <thead><tr><th>Date</th><th>Item</th><th className="text-right">Total</th></tr></thead>
                  <tbody>{folio.lines.map((l: any) => <tr key={l.id} className={l.isReversed || l.reversalOfId ? "text-ink-400" : ""}><td className="whitespace-nowrap">{fmtDate(l.serviceDate)}</td><td>{l.description} <span className="text-xs text-ink-400">({CHARGE_LABELS[l.category]})</span></td><td className="text-right"><Money value={l.lineTotal} /></td></tr>)}</tbody>
                </table></TableWrap>
                <div className="grid gap-4 p-4 sm:grid-cols-2">
                  <div className="space-y-1 text-sm">{folio.payments.map((p: any) => <p key={p.id} className="flex justify-between gap-2"><span>{METHOD_LABEL[p.method]} · {fmtDateTime(p.receivedAt)} <StatusBadge status={p.status} /></span><Money value={p.amount} /></p>)}</div>
                  <FolioTotals folio={folio} />
                </div>
              </Card>
              <div className="grid gap-4 md:grid-cols-2">
                {can("folio.charge") && r.status === "CHECKED_IN" && <Card title="Add approved extra charge"><ChargeForm reservationId={r.id} categories={categories} /></Card>}
                {can("payments.record") && num(folio.balance) > 0 && (
                  <Card title="Take payment"><PaymentForm reservationId={r.id} balance={num(folio.balance)} can={can} compact /><p className="mt-2 text-xs text-ink-500">Split payments: record each method separately.</p></Card>
                )}
              </div>
              {r.status === "CHECKED_IN" && can("frontdesk.checkout") && (
                <Card title="Complete check-out">
                  {overtime && overtime.outcome.kind !== "WITHIN" && <div className="mb-3"><Alert tone="amber">The overtime charge above will be added when you check out. Collect it first, or the guest leaves with a balance.</Alert></div>}
                  {num(folio.balance) > 0 && <div className="mb-3"><Alert tone="amber">Outstanding balance <Money value={folio.balance} />. Collect payment first{can("folio.adjust") || can("payments.verify") ? ", or check out with balance and a recorded reason" : ""}.</Alert></div>}
                  {r.stayType !== "SHORT" && dateOnly(r.departureDate) > today && <div className="mb-3"><Alert>Early departure: unused nights from today will be removed from the bill automatically.</Alert></div>}
                  <ActionForm action={`/staff/reservations/${r.id}/check-out`} className="space-y-3" confirm="Finalise check-out? The final invoice will be issued and housekeeping notified.">
                    {(can("folio.adjust") || can("payments.verify")) && <>
                      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="allowBalance" /> Check out with outstanding balance (follow-up)</label>
                      <input name="reason" className="input" placeholder="Reason (required if checking out with a balance)" />
                    </>}
                    <SubmitButton className="btn-gold">Check out &amp; issue final invoice</SubmitButton>
                  </ActionForm>
                </Card>
              )}
            </div>
          )}</Load>
        )}
      </div>
    </div>
  );
}

// ───────────────────────── Guests ─────────────────────────

function GuestForm({ action, guest, canId, onSuccess }: { action: string; guest?: any; canId: boolean; onSuccess?: (r: any) => void }) {
  return (
    <ActionForm action={action} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" onSuccess={onSuccess}>
      <label><span className="label">First name</span><input name="firstName" className="input" defaultValue={guest?.firstName} required /></label>
      <label><span className="label">Last name</span><input name="lastName" className="input" defaultValue={guest?.lastName} required /></label>
      <label><span className="label">Phone</span><input name="phone" className="input" defaultValue={guest?.phone ?? ""} /></label>
      <label><span className="label">Email</span><input name="email" type="email" className="input" defaultValue={guest?.email ?? ""} /></label>
      <label><span className="label">Nationality</span><input name="nationality" className="input" defaultValue={guest?.nationality ?? ""} /></label>
      <label><span className="label">Date of birth</span><input name="dateOfBirth" type="date" className="input" defaultValue={guest?.dateOfBirth ? dateOnly(guest.dateOfBirth) : ""} /></label>
      <label className="sm:col-span-2"><span className="label">Address</span><input name="address" className="input" defaultValue={guest?.address ?? ""} /></label>
      <label><span className="label">City</span><input name="city" className="input" defaultValue={guest?.city ?? ""} /></label>
      <label><span className="label">Country</span><input name="country" className="input" defaultValue={guest?.country ?? "Nigeria"} /></label>
      {canId && <>
        <label><span className="label">ID type</span><select name="idType" className="input" defaultValue={guest?.idType ?? ""}><option value="">—</option>{ID_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label><span className="label">ID number {guest ? "(leave blank to keep)" : ""}</span><input name="idNumber" className="input" autoComplete="off" /></label>
      </>}
      <div className="sm:col-span-2 lg:col-span-3"><SubmitButton>{guest ? "Save guest" : "Register guest"}</SubmitButton></div>
    </ActionForm>
  );
}

export function Guests() {
  const [sp] = useSearchParams();
  const { can } = useStaffMe();
  const p = Object.fromEntries(sp.entries());
  const q = useApi<any>(qs("/staff/guests", p));
  return (
    <div className="space-y-4">
      <PageHeader title="Guests" subtitle={q.data ? `${q.data.total} guest profile(s)` : undefined} actions={can("guests.manage") && <Link to="/manage/guests/new" className="btn-gold">Register guest</Link>} />
      <GetForm className="card flex flex-wrap items-end gap-3 p-3">
        <label className="flex-1"><span className="label">Search</span><input name="q" defaultValue={p.q} className="input" placeholder="Name, phone or email" /></label>
        <label><span className="label">Show</span><select name="filter" defaultValue={p.filter ?? ""} className="input"><option value="">All guests</option><option value="inhouse">In-house now</option><option value="vip">VIP</option><option value="flagged">Flagged</option></select></label>
        <button className="btn-primary">Search</button>
      </GetForm>
      <Load q={q}>{(d) => (
        <>
          <Card padded={false}>
            {d.guests.length === 0 ? <div className="p-4"><EmptyState title="No guests found" /></div> : (
              <TableWrap><table className="table">
                <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Stays</th><th>Last booking</th><th>Account</th></tr></thead>
                <tbody>{d.guests.map((g: any) => (
                  <tr key={g.id}>
                    <td><Link className="link" to={`/manage/guests/${g.id}`}>{g.firstName} {g.lastName}</Link> {g.isVip && <Badge tone="gold">VIP</Badge>} {g.isBlacklisted && <Badge tone="red">Flagged</Badge>} {g._count.reservations > 1 && <Badge tone="blue">Repeat</Badge>}</td>
                    <td>{g.phone ?? "—"}</td><td>{g.email ?? "—"}</td><td>{g._count.reservations}</td>
                    <td className="text-xs">{g.reservations[0] ? fmtDate(g.reservations[0].arrivalDate) : "—"}</td>
                    <td className="text-xs">{g.userId ? "Online account" : "Front desk"}</td>
                  </tr>
                ))}</tbody>
              </table></TableWrap>
            )}
          </Card>
          <Pagination page={d.page} pages={d.pages} makeHref={(n) => qs("/manage/guests", { ...p, page: n })} />
        </>
      )}</Load>
    </div>
  );
}

export function NewGuest() {
  const { can } = useStaffMe();
  return (
    <div className="space-y-4">
      <PageHeader title="Register guest" back={{ href: "/manage/guests", label: "Guests" }} />
      <Card><GuestForm action="/staff/guests" canId={can("guests.view_sensitive")} /></Card>
    </div>
  );
}

export function GuestProfile() {
  const { id } = useParams();
  const { can } = useStaffMe();
  const q = useApi<any>(`/staff/guests/${id}`);
  return (
    <Load q={q}>{({ guest: g, balances, stats }) => (
      <div className="space-y-5">
        <PageHeader back={{ href: "/manage/guests", label: "Guests" }} title={<>{g.firstName} {g.lastName} {g.isVip && <Badge tone="gold">VIP</Badge>} {g.isBlacklisted && <Badge tone="red">Flagged</Badge>} {stats.stays > 1 && <Badge tone="blue">Repeat guest</Badge>}</>}
          subtitle={`Guest since ${fmtDate(g.createdAt)} · ${g.userId ? "has online account" : "registered at front desk"}`}
          actions={can("reservations.create") && <><Link className="btn-secondary" to={`/manage/reservations/new?guestId=${g.id}&type=SHORT`}>Short stay</Link><Link className="btn-gold" to={`/manage/reservations/new?guestId=${g.id}`}>New booking</Link></>} />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Completed stays" value={stats.stays} />
          <Stat label="Bookings" value={stats.bookings} />
          {stats.lifetime != null && <Stat label="Lifetime value" value={<Money value={stats.lifetime} />} />}
          {stats.outstanding != null && <Stat label="Outstanding" value={<Money value={stats.outstanding} />} tone={num(stats.outstanding) > 0 ? "warn" : undefined} />}
        </div>
        <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
          <div className="space-y-5">
            <Card title="Profile">
              {can("guests.manage") ? <GuestForm action={`/staff/guests/${g.id}`} guest={g} canId={can("guests.view_sensitive")} /> : (
                <DL cols={3} items={[["Phone", g.phone], ["Email", g.email], ["Address", g.address], ["City", g.city], ["Country", g.country], ["Nationality", g.nationality]]} />
              )}
              <div className="mt-4 rounded-lg bg-ink-50 p-3 text-sm">
                <p><span className="font-medium">Identification:</span> {g.idType ?? "—"} {g.idMasked ?? "not recorded"}</p>
                {can("guests.view_sensitive") && g.idMasked && <ActionForm action={`/staff/guests/${g.id}/reveal-id`} className="mt-1" confirm="Reveal the full ID number? This view is recorded in the audit log."><SubmitButton className="btn-ghost btn-sm" pendingText="…">Reveal full ID</SubmitButton></ActionForm>}
                {can("guests.view_sensitive") && g.hasIdDocument && <a className="link text-xs" target="_blank" rel="noreferrer" href={fileUrl(g.idDocumentPath)!}>View uploaded ID document</a>}
              </div>
            </Card>
            <Card title="Booking history" padded={false}>
              <TableWrap><table className="table">
                <thead><tr><th>Ref</th><th>Room</th><th>When</th><th>Status</th>{can("payments.view") && <><th className="text-right">Total</th><th className="text-right">Balance</th></>}</tr></thead>
                <tbody>{g.reservations.map((r: any) => (
                  <tr key={r.id}><td><Link className="link font-mono" to={`/manage/reservations/${r.id}`}>{r.reference}</Link></td><td>{r.room.number}</td><td className="whitespace-nowrap">{stayWhen(r)}</td><td><StatusBadge status={r.status} label={STATUS_LABEL[r.status]} /></td>
                    {can("payments.view") && <><td className="text-right"><Money value={balances[r.id]?.total} /></td><td className="text-right"><Money value={balances[r.id]?.balance} /></td></>}</tr>
                ))}</tbody>
              </table></TableWrap>
            </Card>
            {g.payments && g.payments.length > 0 && (
              <Card title="Payment history" padded={false}>
                <TableWrap><table className="table"><thead><tr><th>Date</th><th>Ref</th><th>Method</th><th>Status</th><th className="text-right">Amount</th></tr></thead>
                  <tbody>{g.payments.map((p: any) => <tr key={p.id}><td className="text-xs">{fmtDateTime(p.receivedAt)}</td><td className="font-mono text-xs">{p.reference}</td><td>{METHOD_LABEL[p.method]}</td><td><StatusBadge status={p.status} /></td><td className="text-right"><Money value={p.amount} /></td></tr>)}</tbody></table></TableWrap>
              </Card>
            )}
            <div className="grid gap-5 md:grid-cols-2">
              <Card title="Service requests">{g.serviceRequests.length === 0 ? <p className="text-sm text-ink-500">None.</p> : <ul className="space-y-2 text-sm">{g.serviceRequests.map((s: any) => <li key={s.id} className="flex justify-between gap-2"><span>{s.category} · {fmtDate(s.createdAt)}</span><StatusBadge status={s.status} /></li>)}</ul>}</Card>
              <Card title="Reviews & complaints">{g.reviews.length === 0 ? <p className="text-sm text-ink-500">None.</p> : <ul className="space-y-2 text-sm">{g.reviews.map((r: any) => <li key={r.id}><Badge tone={r.kind === "COMPLAINT" ? "red" : "gray"}>{r.kind.toLowerCase()}</Badge> {r.rating && "★".repeat(r.rating)} {r.title ?? r.body.slice(0, 60)}</li>)}</ul>}</Card>
            </div>
          </div>
          <div className="space-y-5">
            <Card title="Preferences">
              <ul className="mb-3 space-y-1 text-sm">{g.preferences.map((p: any) => (
                <li key={p.id} className="flex items-center justify-between rounded bg-ink-50 px-2 py-1"><span><span className="text-ink-500">{p.category}:</span> {p.value}</span>
                  {can("guests.manage") && <ActionForm action={`/staff/guests/${g.id}/preferences`}><input type="hidden" name="removeId" value={p.id} /><SubmitButton className="btn-ghost btn-sm" pendingText="…">×</SubmitButton></ActionForm>}</li>
              ))}{!g.preferences.length && <li className="text-ink-500">None recorded.</li>}</ul>
              {can("guests.manage") && <ActionForm action={`/staff/guests/${g.id}/preferences`} className="flex gap-2" resetOnSuccess><select name="category" className="input w-28"><option>Room</option><option>Pillow</option><option>Diet</option><option>Floor</option><option>Other</option></select><input name="value" className="input" required /><SubmitButton className="btn-secondary btn-sm">Add</SubmitButton></ActionForm>}
            </Card>
            {can("guests.notes") && g.notes && (
              <Card title="Internal notes (staff only)">
                <ActionForm action={`/staff/guests/${g.id}/notes`} className="mb-3 space-y-2" resetOnSuccess><textarea name="body" className="input" required placeholder="Add a note visible to authorised staff" /><SubmitButton className="btn-secondary btn-sm">Add note</SubmitButton></ActionForm>
                <ul className="space-y-2 text-sm">{g.notes.map((n: any) => <li key={n.id} className="rounded border border-ink-100 p-2"><p className="whitespace-pre-wrap">{n.body}</p><p className="mt-1 text-xs text-ink-400">{n.authorName} · {fmtDateTime(n.createdAt)}</p></li>)}</ul>
              </Card>
            )}
            {can("guests.vip") && (
              <Card title="Flags">
                <ActionForm action={`/staff/guests/${g.id}/flags`} className="space-y-2" requireReason confirm="Update guest flags?">
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isVip" defaultChecked={g.isVip} /> VIP guest</label>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isBlacklisted" defaultChecked={g.isBlacklisted} /> Flag guest (blocks online booking, requires manager review at check-in)</label>
                  <SubmitButton className="btn-secondary btn-sm">Save flags</SubmitButton>
                </ActionForm>
              </Card>
            )}
          </div>
        </div>
      </div>
    )}</Load>
  );
}

// ───────────────────────── Booking forms (guests never pick rooms) ─────────────────────────

export function Requests() {
  const [sp] = useSearchParams();
  const done = sp.get("status") === "done";
  const q = useApi<any>(qs("/staff/requests", { status: done ? "done" : null }), { refetchInterval: 20_000 });
  return (
    <div className="space-y-4">
      <PageHeader title="Booking forms" subtitle="Guests fill the form online or by scanning the QR code at reception. Confirm their payment, then allocate a room."
        actions={<><Link to="/manage/booking-qr" className="btn-secondary">QR code poster</Link><div className="flex gap-1"><Link className={`btn-sm ${!done ? "btn-primary" : "btn-secondary"}`} to="/manage/requests">Waiting</Link><Link className={`btn-sm ${done ? "btn-primary" : "btn-secondary"}`} to="/manage/requests?status=done">Handled</Link></div></>} />
      <Load q={q}>{({ requests }) => requests.length === 0 ? <EmptyState title={done ? "Nothing handled yet" : "No booking forms waiting"} body={done ? undefined : "New forms appear here automatically."} /> : (
        <Card padded={false}>
          <TableWrap><table className="table">
            <thead><tr><th>Reference</th><th>Guest</th><th>Room type</th><th>When</th><th className="text-right">Price</th><th>Payment</th><th>Status</th><th /></tr></thead>
            <tbody>{requests.map((r: any) => (
              <tr key={r.id}>
                <td className="font-mono text-xs">{r.reference}<p className="text-ink-400">{fmtDateTime(r.createdAt)}</p></td>
                <td>{r.fullName}<p className="text-xs text-ink-500">{r.phone}</p></td>
                <td>{r.roomType.name}{r.stayType === "SHORT" && <Badge tone="blue" className="ml-1">short</Badge>}</td>
                <td className="text-xs">{r.when}</td>
                <td className="text-right"><Money value={r.quotedTotal} /></td>
                <td className="text-xs">{r.paymentMethod === "CASH" ? "Cash / POS at desk" : r.transferRef ? <>Transfer · <span className="font-mono">{r.transferRef}</span>{r.proofPath && " · receipt"}</> : <span className="text-amber-700">Transfer (no reference yet)</span>}</td>
                <td>{r.status === "ALLOCATED" && r.reservation ? <Link className="link text-sm" to={`/manage/reservations/${r.reservation.id}`}>Room {r.reservation.room.number}</Link> : <StatusBadge status={r.status === "NEW" ? "PENDING" : r.status} label={label(r.status)} />}</td>
                <td className="text-right">{r.status === "NEW" && <Link className="btn-primary btn-sm" to={`/manage/requests/${r.id}`}>Open</Link>}{r.status !== "NEW" && <Link className="link text-sm" to={`/manage/requests/${r.id}`}>View</Link>}</td>
              </tr>
            ))}</tbody>
          </table></TableWrap>
        </Card>
      )}</Load>
    </div>
  );
}

export function RequestDetail() {
  const { id } = useParams();
  const { can } = useStaffMe();
  const [stay, setStay] = useState<Record<string, string>>({});
  const q = useApi<any>(qs(`/staff/requests/${id}`, stay));
  const [roomId, setRoomId] = useState("");
  const [method, setMethod] = useState("");
  return (
    <Load q={q}>{({ request: r, stay: st, rooms, roomsError, tiers, today, knownGuest }) => {
      const short = r.stayType === "SHORT";
      const pm = method || (r.paymentMethod === "CASH" ? "CASH" : "BANK_TRANSFER");
      const chosen = rooms.find((x: any) => x.id === roomId) ?? rooms[0];
      const amount = chosen?.total ?? r.quotedTotal;
      return (
        <div className="space-y-5">
          <PageHeader back={{ href: "/manage/requests", label: "Booking forms" }} title={<span className="font-mono">{r.reference}</span>} subtitle={`${r.fullName} · ${r.roomType.name} · ${r.when}`}
            actions={<StatusBadge status={r.status === "NEW" ? "PENDING" : r.status} label={label(r.status)} />} />
          {knownGuest?.isBlacklisted && <Alert tone="red">A guest with this phone/email is flagged. Check their profile before allocating.</Alert>}
          {knownGuest?.isVip && <Alert tone="green">Returning VIP guest.</Alert>}
          <div className="grid gap-5 xl:grid-cols-[1fr_420px]">
            <div className="space-y-5">
              <Card title="Guest details">
                <DL cols={2} items={[
                  ["Name", r.fullName], ["Phone", r.phone], ["Email", r.email], ["Address", r.address], ["Company / organisation", r.company],
                  ["Next of kin", `${r.nextOfKinName} · ${r.nextOfKinPhone}`], ["Guests", `${r.adults} adult(s), ${r.children} child(ren)`], ["Requests", r.specialRequests],
                  ["Account", r.guestId ? <Link key="g" className="link" to={`/manage/guests/${r.guestId}`}>Online account</Link> : "No account"],
                ]} />
              </Card>
              <Card title="Payment from the guest">
                <DL cols={2} items={[
                  ["Price quoted", <Money key="p" value={r.quotedTotal} />], ["Paying by", r.paymentMethod === "CASH" ? "Cash / POS at reception" : "Bank transfer"],
                  ["Transfer reference", r.transferRef], ["Sender", r.payerName],
                  ["Receipt", r.proofPath ? <a key="pr" className="link" target="_blank" rel="noreferrer" href={fileUrl(r.proofPath)!}>View receipt</a> : null],
                ]} />
                {r.paymentMethod === "TRANSFER" && r.status === "NEW" && <p className="mt-3 text-sm text-ink-600">Check the hotel bank account for this transfer before allocating a room.</p>}
              </Card>
              {r.status !== "NEW" && (
                <Card title="Outcome">
                  <DL cols={2} items={[["Status", label(r.status)], ["Handled by", r.handledByName], ["When", r.handledAt ? fmtDateTime(r.handledAt) : null], ["Reason", r.declineReason],
                    ["Booking", r.reservation ? <Link key="res" className="link" to={`/manage/reservations/${r.reservationId}`}>{r.reservation.reference} · Room {r.reservation.room.number}</Link> : null]]} />
                </Card>
              )}
            </div>
            {r.status === "NEW" && (
              <div className="space-y-5">
                <Card title="Allocate a room">
                  <div className="grid grid-cols-2 gap-2">
                    <label><span className="label">{short ? "Date" : "Check-in date"}</span><input type="date" className="input" defaultValue={st.date} min={today} onChange={(e) => setStay({ ...stay, date: e.target.value })} /></label>
                    <label><span className="label">Time</span><input type="time" className="input" defaultValue={st.time} onBlur={(e) => setStay({ ...stay, time: e.target.value })} /></label>
                    {short ? <label><span className="label">Package</span><select className="input" defaultValue={st.hours} onChange={(e) => setStay({ ...stay, hours: e.target.value })}>{tiers.map((t: any) => <option key={t.hours} value={t.hours}>{t.label}</option>)}</select></label>
                      : <label><span className="label">Nights</span><input type="number" min={1} className="input" defaultValue={st.nights} onBlur={(e) => setStay({ ...stay, nights: e.target.value })} /></label>}
                  </div>
                  {roomsError && <div className="mt-3"><Alert tone="amber">{roomsError}</Alert></div>}
                  {!roomsError && rooms.length === 0 && <div className="mt-3"><Alert tone="amber">No suitable room is free for this time. Change the time, or decline the form.</Alert></div>}
                  {rooms.length > 0 && (
                    <ActionForm action={`/staff/requests/${r.id}/allocate`} className="mt-4 space-y-3" confirm="Allocate this room? The booking is confirmed, the payment recorded as received, and the guest sees their room straight away.">
                      <input type="hidden" name="date" value={st.date} /><input type="hidden" name="time" value={st.time} />
                      {short ? <input type="hidden" name="hours" value={st.hours} /> : <input type="hidden" name="nights" value={st.nights} />}
                      <div className="grid gap-2 sm:grid-cols-2">{rooms.map((rm: any, i: number) => (
                        <label key={rm.id} className="flex cursor-pointer items-start gap-2 rounded-lg border border-ink-200 p-2 text-sm has-[:checked]:border-gold-500 has-[:checked]:bg-gold-50">
                          <input type="radio" name="roomId" value={rm.id} defaultChecked={roomId ? roomId === rm.id : i === 0} onChange={() => setRoomId(rm.id)} className="mt-1" required />
                          <span><strong>Room {rm.number}</strong>{rm.roomTypeId !== r.roomTypeId && <span className="text-xs text-amber-700"> ({rm.typeName})</span>}<br /><span className="text-xs text-ink-500">{rm.housekeepingStatus.toLowerCase()} · {rm.total ? naira(rm.total) : "—"}</span></span>
                        </label>
                      ))}</div>
                      <fieldset className="space-y-2 rounded-lg border border-ink-100 p-3">
                        <legend className="px-1 text-sm font-semibold">Payment received</legend>
                        <select name="paymentMethod" className="input" value={pm} onChange={(e) => setMethod(e.target.value)}>
                          <option value="BANK_TRANSFER">Bank transfer</option><option value="CASH">Cash</option><option value="POS">POS / card</option>
                          {(can("pricing.negotiate") || can("payments.verify")) && <option value="NONE">Not paid yet (manager approval)</option>}
                        </select>
                        {pm !== "NONE" && <input name="amount" className="input" defaultValue={Number(amount).toFixed(2)} key={amount} inputMode="decimal" aria-label="Amount received" required />}
                        {pm === "BANK_TRANSFER" && <>
                          <input name="externalRef" className="input" defaultValue={r.transferRef ?? ""} placeholder="Transfer reference" required />
                          <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="transferConfirmed" className="mt-1" required /> I have seen this transfer in the hotel's bank account</label>
                        </>}
                      </fieldset>
                      {can("pricing.negotiate") && (
                        <details className="rounded-lg border border-dashed border-gold-300 p-3 text-sm"><summary className="cursor-pointer font-medium">Negotiated price (managers)</summary>
                          <div className="mt-2 grid gap-2"><input name="rateOverride" className="input" placeholder={short ? "Package price ₦" : "Price per night ₦"} /><input name="negotiationReason" className="input" placeholder="Reason" /></div>
                        </details>
                      )}
                      {st.date === today && can("frontdesk.checkin") && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="checkInNow" defaultChecked /> Guest is here: go to check-in next</label>}
                      <SubmitButton className="btn-gold w-full">Confirm payment &amp; allocate room</SubmitButton>
                    </ActionForm>
                  )}
                </Card>
                <Card title="Decline">
                  <ActionForm action={`/staff/requests/${r.id}/decline`} requireReason reasonLabel="Reason (the guest will see this)" confirm="Decline this booking form?">
                    <SubmitButton className="btn-danger btn-sm">Decline form</SubmitButton>
                  </ActionForm>
                </Card>
              </div>
            )}
          </div>
        </div>
      );
    }}</Load>
  );
}

export function BookingQR() {
  const [svg, setSvg] = useState("");
  const settings = useApi<any>("/public/settings");
  const url = `${window.location.origin}/book`;
  useEffect(() => { import("qrcode").then((QR) => QR.toString(url, { type: "svg", margin: 1, width: 320, color: { dark: "#14141a", light: "#ffffff" } }).then(setSvg)); }, [url]);
  return (
    <div className="space-y-4">
      <PageHeader title="Booking QR code" subtitle="Print this and place it at reception and in the lobby. Guests scan it to open the booking form on their phones." actions={<button className="btn-primary no-print" onClick={() => window.print()}>Print poster</button>} />
      {url.includes("localhost") && <div className="no-print"><Alert tone="amber">This QR code points to {url}, which only works on this computer. Print the poster from the live web address once the system is online.</Alert></div>}
      <div className="print-area mx-auto max-w-md rounded-2xl border border-ink-200 bg-white p-8 text-center shadow-sm">
        <Logo className="mx-auto h-28" alt={settings.data?.hotel.name ?? "Asher Hotel and Suites"} />
        <p className="mt-2 text-lg">Scan to book a room</p>
        <div className="mx-auto mt-5 w-64" dangerouslySetInnerHTML={{ __html: svg }} data-testid="qr" />
        <ol className="mt-5 space-y-1 text-left text-sm text-ink-700">
          <li>1. Fill the short form</li>
          <li>2. Pay by transfer or at reception</li>
          <li>3. Get your room on your phone</li>
        </ol>
        <p className="mt-5 break-all font-mono text-xs text-ink-500">{url}</p>
      </div>
    </div>
  );
}
