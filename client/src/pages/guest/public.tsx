import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useApi } from "@/lib/query";
import { useGuestMe } from "@/lib/auth";
import { fmtDate, fmtDateTime, naira, nowLagosHHMM, num, todayLagos } from "@/lib/format";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert, Card, EmptyState, Load, Money, PageHeader } from "@/components/ui";
import { Gallery, Photo, SITE_PHOTOS } from "@/components/gallery";
import { useHotel } from "@/layouts/GuestLayout";
import { Logo } from "@/components/logo";

// ───────────────────────── Home & rooms (no availability is ever shown) ─────────────────────────

function RoomTypeCard({ t, s }: { t: any; s: any }) {
  return (
    <article className="card overflow-hidden">
      <div className="p-3 pb-0"><Gallery images={t.images} alt={t.name} height="h-72 sm:h-80" /></div>
      <div className="p-4">
        <h3 className="font-display text-xl font-semibold">{t.name}</h3>
        <p className="mt-1 text-sm text-ink-500">{t.bedConfiguration ?? "Double bed"} · Up to {t.maxOccupancy} guest{t.maxOccupancy > 1 ? "s" : ""}</p>
        {t.description && <p className="mt-2 text-sm text-ink-600">{t.description}</p>}
        <div className="mt-3 flex flex-wrap gap-1">{t.amenities.slice(0, 8).map((a: string) => <span key={a} className="rounded bg-ink-50 px-2 py-0.5 text-xs text-ink-600">{a}</span>)}</div>
        <div className="mt-4 rounded-lg bg-ink-50 p-3 text-sm">
          <p className="flex justify-between"><span>Overnight</span><strong><Money value={t.nightlyFrom} /> / night</strong></p>
          {t.shortStay && s.shortStay.tiers.map((x: any) => <p key={x.hours} className="flex justify-between text-ink-600"><span>{x.label}</span><span><Money value={x.price} />{x.eveningPrice && <span className="text-xs"> ({naira(x.eveningPrice)} from {s.shortStay.eveningFrom})</span>}</span></p>)}
          {!t.shortStay && <p className="mt-1 text-xs text-ink-500">Overnight stays only.</p>}
        </div>
        <Link to={`/book?roomType=${t.id}`} className="btn-gold mt-4 w-full">Book this room</Link>
      </div>
    </article>
  );
}

export function Home() {
  const { data: s } = useHotel();
  const types = useApi<any>("/public/room-types");
  const reviews = useApi<any>("/public/reviews");
  if (!s) return null;
  return (
    <>
      <section className="relative overflow-hidden bg-ink-900 text-white">
        <Photo src="/images/site/outside-night.jpg" alt="" className="absolute inset-0 h-full w-full opacity-55" />
        <div className="absolute inset-0 bg-gradient-to-t from-ink-950/90 via-ink-900/40 to-ink-900/30" />
        <div className="relative mx-auto max-w-6xl px-4 pb-14 pt-20 sm:pb-20 sm:pt-28">
          <Logo variant="light" className="h-28 sm:h-36" alt={s.hotel.name} />
          <h1 className="sr-only">{s.hotel.name}</h1>
          <p className="mt-3 max-w-xl text-ink-100">{s.hotel.tagline}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/book" className="btn-gold px-6 py-3 text-base">Book a room</Link>
            <Link to="/track" className="btn-secondary px-6 py-3 text-base">Track my booking</Link>
          </div>
          <p className="mt-4 max-w-xl text-sm text-ink-200">Fill a short form, pay by transfer or at reception, and the front desk will give you your room. You'll see your room on your phone as soon as it's ready.</p>
        </div>
      </section>
      <section className="mx-auto max-w-6xl px-4 py-12">
        <div className="mb-6 flex items-end justify-between"><h2 className="font-display text-2xl font-semibold">Our rooms</h2><Link to="/rooms" className="link text-sm">Room details →</Link></div>
        <Load q={types}>{(d) => <div className="grid gap-5 md:grid-cols-2">{d.types.map((t: any) => <RoomTypeCard key={t.id} t={t} s={s} />)}</div>}</Load>
      </section>
      <section className="border-y border-ink-100 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-12">
          <h2 className="font-display text-2xl font-semibold">Around the hotel</h2>
          <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            {SITE_PHOTOS.map((p) => <figure key={p.src} className="overflow-hidden rounded-xl"><Photo src={p.src} alt={p.caption} className="h-40 w-full sm:h-56" /><figcaption className="mt-1 text-xs text-ink-500">{p.caption}</figcaption></figure>)}
          </div>
        </div>
      </section>
      <section className="mx-auto grid max-w-6xl gap-8 px-4 py-12 md:grid-cols-2">
        <div>
          <h2 className="font-display text-2xl font-semibold">Hotel facilities</h2>
          <ul className="mt-4 grid grid-cols-2 gap-2 text-sm text-ink-700">{s.facilities.map((f: string) => <li key={f} className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-gold-500" />{f}</li>)}</ul>
        </div>
        <div>
          <h2 className="font-display text-2xl font-semibold">Good to know</h2>
          <dl className="mt-4 space-y-2 text-sm text-ink-700">
            <div className="flex justify-between border-b border-ink-100 pb-2"><dt>Check-in</dt><dd className="font-medium">From {s.policies.checkInTime}</dd></div>
            <div className="flex justify-between border-b border-ink-100 pb-2"><dt>Check-out</dt><dd className="font-medium">By {s.policies.checkOutTime}</dd></div>
            <div className="pt-1"><dt className="font-medium">Cancellation</dt><dd className="mt-1 text-ink-600">{s.policies.cancellationPolicy}</dd></div>
          </dl>
          <Link to="/policies" className="link mt-3 inline-block text-sm">Read all policies →</Link>
        </div>
      </section>
      {reviews.data?.reviews?.length > 0 && (
        <section className="mx-auto max-w-6xl px-4 pb-12">
          <h2 className="font-display text-2xl font-semibold">What guests say</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-3">{reviews.data.reviews.map((r: any) => (
            <blockquote key={r.id} className="card p-5">
              <p className="text-gold-500">{"★".repeat(r.rating ?? 0)}<span className="text-ink-200">{"★".repeat(5 - (r.rating ?? 0))}</span></p>
              {r.title && <p className="mt-2 font-semibold">{r.title}</p>}
              <p className="mt-1 text-sm text-ink-600">{r.body}</p>
              <footer className="mt-3 text-xs text-ink-500">{r.guest.firstName} · Verified stay</footer>
            </blockquote>
          ))}</div>
        </section>
      )}
    </>
  );
}

export function Rooms() {
  const { data: s } = useHotel();
  const types = useApi<any>("/public/room-types");
  if (!s) return null;
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <PageHeader title="Rooms & prices" subtitle={`Prices are final and include ${s.finance.taxLabel}. The front desk allocates your room once your booking is confirmed.`} actions={<Link to="/book" className="btn-gold">Book a room</Link>} />
      <Load q={types}>{(d) => <div className="grid gap-5 md:grid-cols-2">{d.types.map((t: any) => <RoomTypeCard key={t.id} t={t} s={s} />)}</div>}</Load>
    </div>
  );
}

export function OldRoomLink() { return <Navigate to="/rooms" replace />; }

// ───────────────────────── Booking form ─────────────────────────

function Field({ label, children, hint, wide }: { label: string; children: React.ReactNode; hint?: string; wide?: boolean }) {
  return <label className={`block ${wide ? "sm:col-span-2" : ""}`}><span className="label">{label}</span>{children}{hint && <span className="mt-1 block text-xs text-ink-500">{hint}</span>}</label>;
}

export function Book() {
  const { data: s } = useHotel();
  const { user } = useGuestMe();
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const types = useApi<any>("/public/room-types");
  const today = todayLagos();
  const [roomTypeId, setRoomTypeId] = useState(sp.get("roomType") ?? "");
  const [stayType, setStayType] = useState<"NIGHT" | "SHORT">(sp.get("stay") === "SHORT" ? "SHORT" : "NIGHT");
  const [date, setDate] = useState(today);
  const [time, setTime] = useState("");
  const [nights, setNights] = useState(1);
  const [hours, setHours] = useState(2);
  const [pay, setPay] = useState<"TRANSFER" | "CASH">("TRANSFER");
  const [email, setEmail] = useState("");
  const [makeAccount, setMakeAccount] = useState(false);

  const list: any[] = types.data?.types ?? [];
  const type = list.find((t) => t.id === roomTypeId);
  useEffect(() => { if (!roomTypeId && list.length) setRoomTypeId(list[0].id); }, [list.length]);
  useEffect(() => { if (type && !type.shortStay && stayType === "SHORT") setStayType("NIGHT"); }, [type?.id]);
  useEffect(() => { if (s && !time) setTime(stayType === "SHORT" || date === today ? roundUp(nowLagosHHMM()) : s.policies.checkInTime); }, [s, stayType]);
  useEffect(() => { if (s?.shortStay.tiers[0] && !s.shortStay.tiers.some((t: any) => t.hours === hours)) setHours(s.shortStay.tiers[0].hours); }, [s]);

  const quoteUrl = roomTypeId && time ? `/public/request-quote?${new URLSearchParams({ roomTypeId, stayType, date, time, ...(stayType === "SHORT" ? { hours: String(hours) } : { nights: String(nights) }) })}` : null;
  const quote = useApi<any>(quoteUrl, { retry: false });
  if (!s) return null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <PageHeader title="Book a room" subtitle="Fill this short form. After you pay, the front desk confirms and allocates your room, and you'll see it on your phone." />
      <ActionForm action="/public/booking-requests" className="space-y-5" onSuccess={(r) => navigate(r.data?.link)}>
        <section className="card space-y-4 p-5" key={user?.id ?? "guest"}>
          <h2 className="font-semibold">1. Your details</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Full name" wide><input className="input" name="fullName" autoComplete="name" defaultValue={user ? `${user.firstName} ${user.lastName}` : ""} required /></Field>
            <Field label="Phone"><input className="input" type="tel" name="phone" autoComplete="tel" defaultValue={user?.phone ?? ""} placeholder="080…" required /></Field>
            <Field label="Email (optional)"><input className="input" type="email" name="email" autoComplete="email" defaultValue={user?.email ?? ""} onChange={(e) => setEmail(e.target.value)} /></Field>
            <Field label="Address" wide><textarea className="input min-h-16" name="address" autoComplete="street-address" required /></Field>
            <Field label="Company / organisation (optional)" wide><input className="input" name="company" autoComplete="organization" /></Field>
            <Field label="Next of kin name"><input className="input" name="nextOfKinName" required /></Field>
            <Field label="Next of kin phone"><input className="input" type="tel" name="nextOfKinPhone" required /></Field>
          </div>
        </section>

        <section className="card space-y-4 p-5">
          <h2 className="font-semibold">2. Your stay</h2>
          <Load q={types}>{() => (
            <div className="grid gap-2 sm:grid-cols-2">
              {list.map((t) => (
                <label key={t.id} className="flex cursor-pointer gap-3 rounded-lg border border-ink-200 p-3 has-[:checked]:border-gold-500 has-[:checked]:bg-gold-50">
                  <input type="radio" name="roomTypeId" value={t.id} checked={roomTypeId === t.id} onChange={() => setRoomTypeId(t.id)} className="mt-1" />
                  <span className="text-sm"><strong>{t.name}</strong><br /><span className="text-ink-600"><Money value={t.nightlyFrom} /> a night{t.shortStay ? " · short stays available" : ""}</span></span>
                </label>
              ))}
            </div>
          )}</Load>
          {type?.shortStay && s.shortStay.enabled && s.shortStay.onlineBooking && (
            <div className="flex flex-wrap gap-2 text-sm">
              {([["NIGHT", "Overnight"], ["SHORT", "Short stay (hours)"]] as const).map(([k, l]) => (
                <label key={k} className={`cursor-pointer rounded-full border px-4 py-1.5 ${stayType === k ? "border-gold-500 bg-gold-50 font-semibold text-gold-700" : "border-ink-200 text-ink-600"}`}>
                  <input type="radio" name="stayType" value={k} checked={stayType === k} onChange={() => setStayType(k)} className="sr-only" />{l}
                </label>
              ))}
            </div>
          )}
          {!(type?.shortStay && s.shortStay.enabled && s.shortStay.onlineBooking) && <input type="hidden" name="stayType" value="NIGHT" />}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Check-in date"><input className="input" type="date" name="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
            <Field label="Check-in time" hint={stayType === "NIGHT" ? `Check-in is from ${s.policies.checkInTime}; check-out by ${s.policies.checkOutTime}.` : undefined}><input className="input" type="time" name="time" value={time} onChange={(e) => setTime(e.target.value)} required /></Field>
            {stayType === "NIGHT" ? (
              <Field label="Number of nights"><input className="input" type="number" name="nights" min={1} max={s.reservations.maxNights} value={nights} onChange={(e) => setNights(Math.max(1, Number(e.target.value) || 1))} required /></Field>
            ) : (
              <Field label="Package"><select className="input" name="hours" value={hours} onChange={(e) => setHours(Number(e.target.value))}>{s.shortStay.tiers.map((t: any) => <option key={t.hours} value={t.hours}>{t.label} — {naira(t.price)}{t.eveningPrice ? ` (${naira(t.eveningPrice)} from ${s.shortStay.eveningFrom})` : ""}</option>)}</select></Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Adults"><input className="input" type="number" name="adults" min={1} max={type?.maxOccupancy ?? 2} defaultValue={1} /></Field>
              <Field label="Children"><input className="input" type="number" name="children" min={0} max={4} defaultValue={0} /></Field>
            </div>
          </div>
          <div className="rounded-xl border border-gold-200 bg-gold-50/60 p-4">
            {quote.isLoading ? <p className="text-sm text-ink-500">Working out your price…</p> : quote.error ? <p className="text-sm text-red-700">{(quote.error as Error).message}</p> : quote.data ? (
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <p className="text-sm text-ink-600">{type?.name} · {stayType === "SHORT" ? `${quote.data.quote.label}, ${fmtDate(date)} from ${time}` : `${nights} night${nights > 1 ? "s" : ""}, ${fmtDate(date)} → ${fmtDate(quote.data.departure)}`}</p>
                  <p className="text-xs text-ink-500">Includes {quote.data.quote.taxLabel}{quote.data.quote.evening ? " · evening rate" : ""}</p>
                </div>
                <p className="text-2xl font-semibold" data-testid="price">{naira(quote.data.quote.total)}</p>
              </div>
            ) : <p className="text-sm text-ink-500">Choose a room and dates to see the price.</p>}
          </div>
          <Field label="Anything we should know? (optional)"><textarea className="input min-h-16" name="specialRequests" maxLength={1000} /></Field>
        </section>

        <section className="card space-y-4 p-5">
          <h2 className="font-semibold">3. Payment</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex cursor-pointer gap-3 rounded-lg border border-ink-200 p-3 text-sm has-[:checked]:border-gold-500 has-[:checked]:bg-gold-50"><input type="radio" name="paymentMethod" value="TRANSFER" checked={pay === "TRANSFER"} onChange={() => setPay("TRANSFER")} className="mt-1" /><span><strong>Bank transfer</strong><br /><span className="text-ink-600">Pay into the hotel account below.</span></span></label>
            <label className="flex cursor-pointer gap-3 rounded-lg border border-ink-200 p-3 text-sm has-[:checked]:border-gold-500 has-[:checked]:bg-gold-50"><input type="radio" name="paymentMethod" value="CASH" checked={pay === "CASH"} onChange={() => setPay("CASH")} className="mt-1" /><span><strong>Cash or POS at reception</strong><br /><span className="text-ink-600">Pay the receptionist when you arrive.</span></span></label>
          </div>
          {pay === "TRANSFER" ? (
            <div className="space-y-3">
              <div className="rounded-lg bg-ink-50 p-3 text-sm">
                {s.finance.bankName ? <><p>Bank: <strong>{s.finance.bankName}</strong></p><p>Account name: <strong>{s.finance.accountName}</strong></p><p>Account number: <strong className="font-mono">{s.finance.accountNumber}</strong></p></> : <p>Ask the front desk for the hotel's account details.</p>}
                {quote.data && <p className="mt-1">Amount: <strong>{naira(quote.data.quote.total)}</strong></p>}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Transfer reference (if you've paid)" hint="You can also add this later from your booking page."><input className="input" name="transferRef" /></Field>
                <Field label="Sender's name (if different)"><input className="input" name="payerName" /></Field>
                <Field label="Receipt / screenshot (optional)" wide><input className="input" type="file" name="proof" accept="image/jpeg,image/png,image/webp,application/pdf" /></Field>
              </div>
            </div>
          ) : <p className="text-sm text-ink-600">The receptionist will take your payment, confirm it, and give you your room.</p>}
        </section>

        <section className="card space-y-3 p-5 text-sm">
          {!user && (
            <div>
              <label className="flex items-start gap-2"><input type="checkbox" checked={makeAccount} onChange={(e) => setMakeAccount(e.target.checked)} className="mt-1" /><span>Create an account so your details are filled in next time (needs your email)</span></label>
              {makeAccount && <div className="mt-2 max-w-sm"><Field label="Choose a password" hint="At least 8 characters with letters and numbers."><input className="input" type="password" name="password" minLength={8} autoComplete="new-password" required={makeAccount} /></Field>{!email && <p className="mt-1 text-xs text-amber-700">Add your email above to create an account.</p>}</div>}
            </div>
          )}
          <label className="flex items-start gap-2"><input type="checkbox" name="acceptPolicies" required className="mt-1" /><span>I accept the <Link to="/policies" className="link" target="_blank">hotel policies</Link>.</span></label>
          <SubmitButton className="btn-gold w-full py-3 text-base" pendingText="Sending…">Send booking form{quote.data ? ` · ${naira(quote.data.quote.total)}` : ""}</SubmitButton>
          <p className="text-xs text-ink-500">Your room number is given by the front desk after your payment is confirmed.</p>
        </section>
      </ActionForm>
    </div>
  );
}

function roundUp(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const t = Math.min(23 * 60 + 45, Math.ceil((h * 60 + m) / 15) * 15);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

// ───────────────────────── Booking status (private link) ─────────────────────────

const STEPS = ["Form received", "Payment confirmed", "Room allocated"];

export function BookingStatus() {
  const { ref } = useParams();
  const [sp] = useSearchParams();
  const t = sp.get("t") ?? "";
  const q = useApi<any>(`/public/booking-requests/${ref}?t=${encodeURIComponent(t)}`, { refetchInterval: 20_000 });
  const [copied, setCopied] = useState(false);
  const link = typeof window !== "undefined" ? window.location.href : "";
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Load q={q}>{({ booking: b }) => {
        const allocated = b.status === "ALLOCATED" && b.reservation;
        const step = allocated ? 3 : b.status === "NEW" ? 1 : 0;
        return (
          <div className="space-y-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-sm text-ink-500">Booking form</p>
                <h1 className="font-display text-3xl font-semibold" data-testid="booking-ref">{b.reference}</h1>
              </div>
              <button type="button" className="btn-secondary btn-sm" onClick={() => { navigator.clipboard?.writeText(link); setCopied(true); }}>{copied ? "Link copied" : "Copy this page's link"}</button>
            </div>
            {b.status !== "DECLINED" && b.status !== "CANCELLED" && (
              <ol className="grid grid-cols-3 gap-2 text-xs sm:text-sm">
                {STEPS.map((label, i) => (
                  <li key={label} className={`rounded-lg border px-2 py-2 text-center ${i < step || (i === 1 && allocated) ? "border-emerald-300 bg-emerald-50 text-emerald-800" : i === step ? "border-gold-300 bg-gold-50 text-gold-800" : "border-ink-200 text-ink-400"}`}>{i < step || allocated ? "✓ " : ""}{label}</li>
                ))}
              </ol>
            )}
            {b.status === "DECLINED" && <Alert tone="red">We couldn't confirm this booking: {b.declineReason}. Please call {b.hotel.phone || "the front desk"}.</Alert>}
            {b.status === "CANCELLED" && <Alert tone="amber">This booking form was cancelled.</Alert>}

            {allocated ? (
              <Card>
                <p className="text-sm font-semibold uppercase tracking-wide text-emerald-700">Your room is ready</p>
                <p className="mt-1 font-display text-4xl font-semibold" data-testid="room-number">Room {b.reservation.room.number}</p>
                <p className="text-ink-600">{b.reservation.room.name || b.reservation.room.typeName} · Booking {b.reservation.reference}</p>
                <div className="mt-4"><Gallery images={b.reservation.room.images} alt={`Room ${b.reservation.room.number}`} /></div>
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                  <div><dt className="text-ink-500">Check-in</dt><dd className="font-medium">{fmtDateTime(b.reservation.startAt)}</dd></div>
                  <div><dt className="text-ink-500">Check-out</dt><dd className="font-medium">{fmtDateTime(b.reservation.endAt)}</dd></div>
                  {b.folio && <div><dt className="text-ink-500">Paid</dt><dd className="font-medium">{naira(b.folio.paid)} of {naira(b.folio.total)}</dd></div>}
                  {b.folio && num(b.folio.balance) > 0 && <div><dt className="text-ink-500">Balance to pay at reception</dt><dd className="font-semibold text-amber-700">{naira(b.folio.balance)}</dd></div>}
                </dl>
                {b.reservation.room.amenities.length > 0 && <div className="mt-4 flex flex-wrap gap-1">{b.reservation.room.amenities.map((a: string) => <span key={a} className="rounded bg-ink-50 px-2 py-0.5 text-xs text-ink-600">{a}</span>)}</div>}
                {b.reservation.room.description && <p className="mt-3 text-sm text-ink-600">{b.reservation.room.description}</p>}
                <p className="mt-4 text-sm text-ink-600">Show this page or your booking reference at reception to collect your key.</p>
              </Card>
            ) : (
              <Card title="Your booking">
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div><dt className="text-ink-500">Name</dt><dd className="font-medium">{b.fullName}</dd></div>
                  <div><dt className="text-ink-500">Room type</dt><dd className="font-medium">{b.roomType.name}</dd></div>
                  <div><dt className="text-ink-500">Check-in</dt><dd className="font-medium">{fmtDate(b.checkInDate)} at {b.checkInTime}</dd></div>
                  <div><dt className="text-ink-500">Length</dt><dd className="font-medium">{b.stayType === "SHORT" ? `${b.hours} hours (short stay)` : `${b.nights} night${b.nights > 1 ? "s" : ""}`}</dd></div>
                  <div><dt className="text-ink-500">Price</dt><dd className="text-lg font-semibold">{naira(b.quotedTotal)}</dd></div>
                  <div><dt className="text-ink-500">Payment</dt><dd className="font-medium">{b.paymentMethod === "CASH" ? "Cash / POS at reception" : b.transferRef ? `Transfer (ref ${b.transferRef})` : "Bank transfer"}</dd></div>
                </dl>
              </Card>
            )}

            {b.status === "NEW" && b.paymentMethod === "CASH" && <Alert>Please go to reception and pay {naira(b.quotedTotal)}. The receptionist will confirm it and allocate your room. This page updates by itself.</Alert>}
            {b.status === "NEW" && b.paymentMethod === "TRANSFER" && (
              <Card title={b.transferRef ? "Transfer details sent" : "Pay by bank transfer"}>
                <div className="rounded-lg bg-ink-50 p-3 text-sm">
                  {b.bank.bankName ? <><p>Bank: <strong>{b.bank.bankName}</strong></p><p>Account name: <strong>{b.bank.accountName}</strong></p><p>Account number: <strong className="font-mono">{b.bank.accountNumber}</strong></p></> : <p>Ask the front desk for the account details.</p>}
                  <p className="mt-1">Amount: <strong>{naira(b.quotedTotal)}</strong> · Narration: <strong>{b.reference}</strong></p>
                </div>
                {b.transferRef && <p className="mt-3 text-sm text-emerald-700">We have your transfer reference ({b.transferRef}). The front desk will confirm it and allocate your room.</p>}
                <ActionForm action={`/public/booking-requests/${b.reference}/transfer?t=${encodeURIComponent(t)}`} className="mt-3 grid gap-3 sm:grid-cols-2" resetOnSuccess>
                  <label className="block"><span className="label">Transfer reference</span><input className="input" name="transferRef" required /></label>
                  <label className="block"><span className="label">Sender's name</span><input className="input" name="payerName" defaultValue={b.fullName} /></label>
                  <label className="block sm:col-span-2"><span className="label">Receipt / screenshot (optional)</span><input className="input" type="file" name="proof" accept="image/jpeg,image/png,image/webp,application/pdf" /></label>
                  <div className="sm:col-span-2"><SubmitButton className="btn-primary">{b.transferRef ? "Update transfer details" : "I have paid"}</SubmitButton></div>
                </ActionForm>
              </Card>
            )}
            {b.status === "NEW" && (
              <ActionForm action={`/public/booking-requests/${b.reference}/cancel?t=${encodeURIComponent(t)}`} confirm="Cancel this booking form?"><SubmitButton className="btn-ghost btn-sm">Cancel this booking form</SubmitButton></ActionForm>
            )}
            <p className="text-xs text-ink-500">Keep this page's link private: anyone with it can see your booking. Lost it? Use <Link className="link" to="/track">Track my booking</Link> with your reference and phone number.</p>
          </div>
        );
      }}</Load>
    </div>
  );
}

export function Track() {
  const navigate = useNavigate();
  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <PageHeader title="Track my booking" subtitle="Enter the reference from your booking form (it starts with REQ-) and the phone number you used." />
      <Card>
        <ActionForm action="/public/booking-lookup" className="space-y-3" onSuccess={(r) => navigate(r.data?.redirect)}>
          <label className="block"><span className="label">Reference</span><input className="input uppercase" name="reference" placeholder="REQ-…" required /></label>
          <label className="block"><span className="label">Phone</span><input className="input" type="tel" name="phone" required /></label>
          <SubmitButton className="btn-primary w-full">Find my booking</SubmitButton>
        </ActionForm>
      </Card>
      <p className="mt-4 text-center text-sm"><Link className="link" to="/book">Make a new booking</Link></p>
    </div>
  );
}

/** Kept for old links. */
export function Confirmation() { return <EmptyState title="Booking received" body="Check your booking page for updates." action={<Link className="btn-primary" to="/track">Track my booking</Link>} />; }


export function Policies() {
  const { data: s } = useHotel();
  if (!s) return null;
  const block = (title: string, text: string) => <section className="card p-5"><h2 className="font-semibold">{title}</h2><p className="mt-2 whitespace-pre-line text-sm text-ink-600">{text}</p></section>;
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-10">
      <PageHeader title="Hotel policies" />
      {block("Check-in and check-out", `Check-in from ${s.policies.checkInTime}. Check-out by ${s.policies.checkOutTime}.`)}
      {s.shortStay.enabled && block("Short stays", `${s.shortStay.tiers.map((t: any) => `${t.label}: ${naira(t.price)}${t.eveningPrice ? ` (${naira(t.eveningPrice)} when starting from ${s.shortStay.eveningFrom})` : ""}`).join("\n")}\n\nIf you stay longer than your package, the bill moves to the next package; beyond the longest package, the overnight rate applies.`)}
      {block("Cancellations", s.policies.cancellationPolicy)}
      {block("House rules", s.policies.houseRules)}
      {block("Children", s.policies.childPolicy)}
      {block("Payments", `${s.finance.paymentInstructions}${s.finance.bankName ? `\n\nBank: ${s.finance.bankName}\nAccount name: ${s.finance.accountName}\nAccount number: ${s.finance.accountNumber}` : ""}\n\n${s.finance.taxInclusive ? `All prices include ${s.finance.taxLabel} (${s.finance.taxRate}%).` : `Prices exclude ${s.finance.taxLabel} at ${s.finance.taxRate}%.`}`)}
    </div>
  );
}
