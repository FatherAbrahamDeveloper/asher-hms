import { Link, useParams, useSearchParams, useNavigate } from "react-router-dom";
import { useApi } from "@/lib/query";
import { useGuestMe } from "@/lib/auth";
import { METHOD_LABEL, STATUS_LABEL, dateOnly, fmtDate, fmtDateTime, naira, num, stayWhen } from "@/lib/format";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert, Badge, Card, DL, EmptyState, Load, Money, Stat, StatusBadge, TableWrap, PageHeader } from "@/components/ui";
import { MessageThread } from "@/components/message-thread";
import { Gallery, Photo } from "@/components/gallery";
import { fileUrl } from "@/lib/api";
import { useHotel } from "@/layouts/GuestLayout";

function MyForms() {
  const q = useApi<any>("/guest/requests", { refetchInterval: 30_000 });
  const list = q.data?.requests ?? [];
  if (!list.length) return null;
  return (
    <Card title="My booking forms" actions={<Link to="/book" className="btn-gold btn-sm">New booking</Link>}>
      <ul className="divide-y divide-ink-100">{list.map((r: any) => (
        <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="flex items-center gap-3">
            {r.reservation?.room.images[0] && <Photo src={fileUrl(r.reservation.room.images[0].path)!} alt="" className="h-12 w-16 rounded" />}
            <div><p className="font-medium">{r.status === "ALLOCATED" && r.reservation ? `Room ${r.reservation.room.number} · ${r.roomType.name}` : r.roomType.name} <StatusBadge status={r.status === "NEW" ? "PENDING" : r.status === "ALLOCATED" ? "CONFIRMED" : r.status} label={r.status === "NEW" ? "Waiting for front desk" : r.status === "ALLOCATED" ? "Room allocated" : r.status.toLowerCase()} /></p>
            <p className="text-sm text-ink-500">{r.reference} · {fmtDate(r.checkInDate)} at {r.checkInTime}</p></div>
          </div>
          <Link to={r.link} className="btn-secondary btn-sm">Open</Link>
        </li>
      ))}</ul>
    </Card>
  );
}

export function AccountHome() {
  const q = useApi<any>("/guest/overview");
  return (
    <Load q={q}>{(d) => (
      <div className="space-y-6">
        {!d.emailVerified && (
          <Alert tone="amber"><div className="flex flex-wrap items-center justify-between gap-2">Please verify your email address to receive booking updates.
            <ActionForm action="/auth/guest/resend-verification"><SubmitButton className="btn-secondary btn-sm">Resend email</SubmitButton></ActionForm></div></Alert>
        )}
        {d.current && (
          <div className="card overflow-hidden border-gold-200">
            <div className="bg-ink-900 px-5 py-4 text-white">
              <p className="text-xs uppercase tracking-wide text-gold-300">You are staying with us</p>
              <p className="font-display text-2xl font-semibold">Room {d.current.room.number}</p>
              {d.current.room.images?.[0] && <div className="mt-3"><Gallery images={d.current.room.images} alt={`Room ${d.current.room.number}`} height="h-48" /></div>}
              <p className="text-sm text-ink-300">{d.current.stayType === "SHORT" ? `Until ${fmtDateTime(d.current.endAt)}` : `Until ${fmtDate(d.current.departureDate)}`} · Booking {d.current.reference}</p>
            </div>
            <div className="flex flex-wrap gap-2 p-4">
              <Link to="/account/services" className="btn-gold btn-sm">Request service</Link>
              <Link to="/account/messages" className="btn-secondary btn-sm">Message front desk</Link>
              <Link to={`/account/billing?ref=${d.current.reference}`} className="btn-secondary btn-sm">View bill ({naira(d.balances[d.current.id]?.balance)} due)</Link>
            </div>
          </div>
        )}
        <MyForms />
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat label="Upcoming stays" value={d.upcoming.length} href="/account/reservations" />
          <Stat label="Open requests" value={d.openRequests} href="/account/services" />
          <Stat label="Unread messages" value={d.unreadMsgs} href="/account/messages" tone={d.unreadMsgs ? "warn" : undefined} />
        </div>
        <Card title="Upcoming reservations" actions={<Link to="/book" className="btn-gold btn-sm">Book a room</Link>}>
          {d.upcoming.length === 0 ? <EmptyState title="No upcoming stays" body="When you book a room it will appear here." /> : (
            <ul className="divide-y divide-ink-100">
              {d.upcoming.map((r: any) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div><p className="font-medium">{r.room.roomType.name} {r.room.number} <StatusBadge status={r.status} label={STATUS_LABEL[r.status]} /></p><p className="text-sm text-ink-500">{stayWhen(r)} · {r.reference}</p></div>
                  <div className="flex items-center gap-3 text-sm">{num(d.balances[r.id]?.balance) > 0 && <span className="text-ink-600">Balance {naira(d.balances[r.id].balance)}</span>}<Link to={`/account/reservations/${r.reference}`} className="btn-secondary btn-sm">Manage</Link></div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    )}</Load>
  );
}

export function MyReservations() {
  const q = useApi<any>("/guest/reservations");
  return (
    <Load q={q}>{(d) => {
      if (!d.reservations.length) return <EmptyState title="You have no reservations yet" action={<Link className="btn-gold" to="/book">Book a room</Link>} />;
      const today = d.today;
      const groups: [string, any[]][] = [
        ["Active", d.reservations.filter((r: any) => r.status === "CHECKED_IN")],
        ["Upcoming", d.reservations.filter((r: any) => ["PENDING", "CONFIRMED"].includes(r.status) && dateOnly(r.departureDate) >= today)],
        ["Completed", d.reservations.filter((r: any) => r.status === "CHECKED_OUT")],
        ["Cancelled / no-show", d.reservations.filter((r: any) => ["CANCELLED", "NO_SHOW"].includes(r.status) || (["PENDING", "CONFIRMED"].includes(r.status) && dateOnly(r.departureDate) < today))],
      ];
      return (
        <div className="space-y-6">
          {groups.filter(([, l]) => l.length).map(([title, list]) => (
            <Card key={title} title={`${title} (${list.length})`} padded={false}>
              <TableWrap><table className="table">
                <thead><tr><th>Reference</th><th>Room</th><th>When</th><th>Status</th><th className="text-right">Total</th><th className="text-right">Balance</th><th /></tr></thead>
                <tbody>{list.map((r) => (
                  <tr key={r.id}>
                    <td className="font-mono">{r.reference}</td><td>{r.room.roomType.name} {r.room.number}</td><td className="whitespace-nowrap">{stayWhen(r)}</td>
                    <td><StatusBadge status={r.status} label={STATUS_LABEL[r.status]} /></td>
                    <td className="text-right"><Money value={d.balances[r.id]?.total} /></td><td className="text-right"><Money value={d.balances[r.id]?.balance} /></td>
                    <td className="text-right"><Link className="link" to={`/account/reservations/${r.reference}`}>Open</Link></td>
                  </tr>
                ))}</tbody>
              </table></TableWrap>
            </Card>
          ))}
        </div>
      );
    }}</Load>
  );
}

export function MyReservation() {
  const { ref } = useParams();
  const q = useApi<any>(`/guest/reservations/${ref}`);
  const { data: s } = useHotel();
  return (
    <Load q={q}>{({ reservation: r, folio }) => {
      if (!s) return null;
      const upcoming = ["PENDING", "CONFIRMED"].includes(r.status);
      const hoursToArrival = (new Date(r.startAt).getTime() - Date.now()) / 3600_000;
      const freeCancel = r.stayType === "SHORT" || hoursToArrival >= s.policies.freeCancellationHours;
      const due = num(folio.balance) - num(folio.pending);
      return (
        <div className="space-y-5">
          <PageHeader title={<>Booking <span className="font-mono">{r.reference}</span></>} subtitle={`${r.room.roomType.name} ${r.room.number} · ${stayWhen(r)}`} back={{ href: "/account/reservations", label: "All reservations" }} actions={<StatusBadge status={r.status} label={STATUS_LABEL[r.status]} />} />
          {r.holdExpiresAt && r.status === "PENDING" && <Alert tone="amber">Awaiting payment. This booking is held until <strong>{fmtDateTime(r.holdExpiresAt)}</strong>.</Alert>}
          {r.status === "PENDING" && r.paymentPlan === "PAY_AT_HOTEL" && <Alert>The hotel will review and confirm your booking shortly.</Alert>}
          <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
            <div className="space-y-5">
              <Card title={`Room ${r.room.number}`}><Gallery images={r.room.images} alt={`Room ${r.room.number}`} /></Card>
              <Card title="Stay details">
                <DL items={[
                  ["Room", `${r.room.roomType.name} ${r.room.number}`], ["Stay type", r.stayType === "SHORT" ? `Short stay (${r.shortStayHours} hours)` : "Overnight"],
                  ["Arrival", r.stayType === "SHORT" ? fmtDateTime(r.startAt) : `${fmtDate(r.arrivalDate)} from ${s.policies.checkInTime}`],
                  ["Departure", r.stayType === "SHORT" ? fmtDateTime(r.endAt) : `${fmtDate(r.departureDate)} by ${s.policies.checkOutTime}`],
                  ["Guests", `${r.adults} adult(s)${r.children ? `, ${r.children} child(ren)` : ""}`], ["Other guests", r.extraGuests.map((e: any) => e.fullName).join(", ") || "—"],
                  ["Pre-arrival check-in", r.preCheckInAt ? `Completed ${fmtDateTime(r.preCheckInAt)}` : "Not yet"], ["Special requests", r.specialRequests ?? "—"],
                ]} />
              </Card>
              <Card title="Charges & payments" actions={<Link className="link text-sm" to={`/account/billing?ref=${r.reference}`}>Full bill →</Link>}>
                <dl className="space-y-1 text-sm">
                  {folio.byCategory.map((c: any) => <div key={c.category} className="flex justify-between"><dt>{c.label}</dt><dd><Money value={c.amount} /></dd></div>)}
                  <div className="flex justify-between border-t border-ink-100 pt-1 font-semibold"><dt>Total</dt><dd><Money value={folio.total} /></dd></div>
                  <div className="flex justify-between text-emerald-700"><dt>Paid</dt><dd><Money value={folio.netPaid} /></dd></div>
                  {num(folio.pending) > 0 && <div className="flex justify-between text-amber-700"><dt>Awaiting verification</dt><dd><Money value={folio.pending} /></dd></div>}
                  <div className="flex justify-between text-base font-semibold"><dt>Balance</dt><dd><Money value={folio.balance} /></dd></div>
                </dl>
                {folio.payments.length > 0 && (
                  <ul className="mt-4 divide-y divide-ink-100 text-sm">{folio.payments.map((p: any) => (
                    <li key={p.id} className="flex flex-wrap justify-between gap-2 py-2"><span>{fmtDateTime(p.receivedAt)} · {METHOD_LABEL[p.method]} <StatusBadge status={p.status} /></span><span className="flex items-center gap-3"><Money value={p.amount} />{p.receipt && <Link className="link" target="_blank" to={`/documents/receipt/${p.id}`}>Receipt</Link>}</span></li>
                  ))}</ul>
                )}
                {r.invoices.length > 0 && <p className="mt-3 text-sm">Invoices: {r.invoices.map((i: any) => <Link key={i.id} className="link mr-2" target="_blank" to={`/documents/invoice/${i.id}`}>{i.number}</Link>)}</p>}
              </Card>
              {upcoming && <Alert>To change dates or rooms, please contact the front desk. <Link className="link" to="/account/messages">Message us</Link>.</Alert>}
            </div>
            <aside className="space-y-4">
              <Card title="Actions">
                <div className="flex flex-col gap-2">
                  {num(folio.balance) > 0 && !["CANCELLED", "NO_SHOW"].includes(r.status) && <Link to={`/account/reservations/${r.reference}/pay`} className="btn-gold">Pay {naira(due > 0 ? due : folio.balance)}</Link>}
                  {upcoming && !r.preCheckInAt && <Link to={`/account/reservations/${r.reference}/check-in`} className="btn-primary">Complete digital check-in</Link>}
                  {r.status === "CHECKED_IN" && (r.checkoutRequestedAt ? <Alert tone="green">Express checkout requested {fmtDateTime(r.checkoutRequestedAt)}.</Alert> : (
                    <ActionForm action={`/guest/reservations/${r.reference}/express-checkout`} confirm={`I confirm my bill of ${naira(folio.total)} is correct and I'd like express checkout.`}><SubmitButton className="btn-primary w-full">Request express checkout</SubmitButton></ActionForm>
                  ))}
                  {r.status === "CHECKED_IN" && <Link to="/account/services" className="btn-secondary">Request a service</Link>}
                  {r.status === "CHECKED_OUT" && !r.review && <Link to={`/account/reviews?stay=${r.id}`} className="btn-secondary">Review your stay</Link>}
                  <Link to="/account/messages" className="btn-secondary">Message the hotel</Link>
                </div>
              </Card>
              {upcoming && (
                <Card title="Cancel booking">
                  <p className="text-sm text-ink-600">{freeCancel ? "Free cancellation is available for this booking." : "A late cancellation fee will apply under the hotel's policy."}</p>
                  <p className="mt-1 text-xs text-ink-500">{s.policies.cancellationPolicy}</p>
                  <ActionForm action={`/guest/reservations/${r.reference}/cancel`} className="mt-3" requireReason reasonLabel="Why are you cancelling?" confirm={freeCancel ? "Cancel this booking?" : "A late cancellation fee will be charged. Cancel this booking?"}>
                    <SubmitButton className="btn-danger w-full">Cancel booking</SubmitButton>
                  </ActionForm>
                </Card>
              )}
            </aside>
          </div>
        </div>
      );
    }}</Load>
  );
}

export function PreCheckIn() {
  const { ref } = useParams();
  const q = useApi<any>(`/guest/reservations/${ref}`);
  const { data: s } = useHotel();
  const navigate = useNavigate();
  return (
    <Load q={q}>{({ reservation: r }) => (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Digital pre-arrival check-in" subtitle={`Room ${r.room.number} · ${stayWhen(r)}`} back={{ href: `/account/reservations/${ref}`, label: "Back to booking" }} />
        <Card>
          <ActionForm action={`/guest/reservations/${ref}/pre-checkin`} className="space-y-4" onSuccess={() => navigate(`/account/reservations/${ref}`)}>
            <div className="grid gap-3 sm:grid-cols-2">
              <label><span className="label">Phone</span><input className="input" name="phone" defaultValue={r.guest.phone ?? ""} required /></label>
              <label><span className="label">Nationality</span><input className="input" name="nationality" defaultValue={r.guest.nationality ?? "Nigerian"} required /></label>
              <label className="sm:col-span-2"><span className="label">Home address</span><input className="input" name="address" defaultValue={r.guest.address ?? ""} required /></label>
              <label><span className="label">ID type</span>
                <select className="input" name="idType" defaultValue={r.guest.idType ?? "NIN"} required><option value="NIN">National ID (NIN)</option><option value="PASSPORT">International passport</option><option value="DRIVERS_LICENCE">Driver's licence</option><option value="VOTERS_CARD">Voter's card</option></select>
              </label>
              <label><span className="label">ID number</span><input className="input" name="idNumber" autoComplete="off" required /></label>
              <label className="sm:col-span-2"><span className="label">Photo or scan of ID (optional, JPG/PNG/PDF, max 5 MB)</span><input className="input" type="file" name="idDocument" accept="image/jpeg,image/png,image/webp,application/pdf" /></label>
              <label><span className="label">Expected arrival time</span><input className="input" type="time" name="expectedArrival" defaultValue={r.expectedArrival ?? s?.policies.checkInTime} required /></label>
            </div>
            <label className="block"><span className="label">Special requests</span><textarea className="input" name="specialRequests" defaultValue={r.specialRequests ?? ""} /></label>
            {s && <div className="rounded-lg bg-ink-50 p-3 text-sm text-ink-600"><p className="whitespace-pre-line">{s.policies.houseRules}</p><p className="mt-2">{s.policies.cancellationPolicy}</p></div>}
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="acceptPolicies" required className="mt-1" /><span>I confirm my details are correct and I accept the hotel policies.</span></label>
            <p className="text-xs text-ink-500">Your ID details are encrypted and only visible to authorised front-desk staff.</p>
            <SubmitButton className="btn-gold w-full">Complete check-in</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    )}</Load>
  );
}

export function Pay() {
  const { ref } = useParams();
  const [sp] = useSearchParams();
  const q = useApi<any>(`/guest/reservations/${ref}`);
  const { data: s } = useHotel();
  const { user } = useGuestMe();
  return (
    <Load q={q}>{({ reservation: r, folio, depositDue }) => {
      const due = num(folio.balance) - num(folio.pending);
      const deposit = num(depositDue) - num(folio.netPaid) - num(folio.pending);
      const suggested = r.paymentPlan === "DEPOSIT" && r.status === "PENDING" && deposit > 0 ? deposit : due;
      return (
        <div className="mx-auto max-w-3xl space-y-5">
          <PageHeader title="Make a payment" subtitle={<>Booking <span className="font-mono">{r.reference}</span> · Balance <Money value={folio.balance} /></>} back={{ href: `/account/reservations/${ref}`, label: "Back to booking" }} />
          {sp.get("status") === "success" && <Alert tone="green">Thank you — your card payment was received and verified.</Alert>}
          {sp.get("status") === "pending" && <Alert tone="amber">We are still confirming your card payment with the bank. You'll be notified shortly.</Alert>}
          {num(folio.pending) > 0 && <Alert tone="amber"><Money value={folio.pending} /> is awaiting verification by our finance team.</Alert>}
          {due <= 0 ? <Alert tone="green">Nothing to pay right now.</Alert> : (
            <div className="grid gap-5 md:grid-cols-2">
              <Card title="Bank transfer">
                <div className="rounded-lg bg-ink-50 p-3 text-sm">
                  {s?.finance.bankName ? (<><p><span className="text-ink-500">Bank:</span> <strong>{s.finance.bankName}</strong></p><p><span className="text-ink-500">Account name:</span> <strong>{s.finance.accountName}</strong></p><p><span className="text-ink-500">Account number:</span> <strong className="font-mono">{s.finance.accountNumber}</strong></p></>) : <p className="text-ink-600">Contact the hotel for bank details.</p>}
                  <p className="mt-2 text-xs text-ink-500">Narration: <strong>{r.reference}</strong>. {s?.finance.paymentInstructions}</p>
                </div>
                <ActionForm action={`/guest/reservations/${ref}/transfer`} className="mt-4 space-y-3" resetOnSuccess>
                  <label className="block"><span className="label">Amount sent (₦)</span><input className="input" name="amount" inputMode="decimal" defaultValue={suggested.toFixed(2)} required /></label>
                  <label className="block"><span className="label">Transfer reference / session ID</span><input className="input" name="externalRef" required /></label>
                  <label className="block"><span className="label">Sender's name</span><input className="input" name="payerName" defaultValue={user?.name} required /></label>
                  <label className="block"><span className="label">Proof of payment (optional)</span><input className="input" type="file" name="proof" accept="image/jpeg,image/png,image/webp,application/pdf" /></label>
                  <SubmitButton className="btn-primary w-full">I have made this transfer</SubmitButton>
                </ActionForm>
              </Card>
              <Card title="Card payment">
                {s?.cardPayments ? (
                  <ActionForm action={`/guest/reservations/${ref}/card`} className="space-y-3">
                    <label className="block"><span className="label">Amount (₦)</span><input className="input" name="amount" inputMode="decimal" defaultValue={suggested.toFixed(2)} required /></label>
                    <p className="text-xs text-ink-500">You'll be taken to our secure payment partner. Card details are never stored by the hotel.</p>
                    <SubmitButton className="btn-gold w-full" pendingText="Redirecting…">Pay by card</SubmitButton>
                  </ActionForm>
                ) : <p className="text-sm text-ink-600">Online card payments are not enabled yet. You can pay by card (POS) at the front desk, or by bank transfer.</p>}
              </Card>
            </div>
          )}
        </div>
      );
    }}</Load>
  );
}

export function Services() {
  const q = useApi<any>("/guest/services", { refetchInterval: 20_000 });
  return (
    <Load q={q}>{(d) => (
      <div className="grid gap-5 lg:grid-cols-[380px_1fr]">
        <Card title="New request">
          <ActionForm action="/guest/services" className="space-y-3" resetOnSuccess>
            <label className="block"><span className="label">For stay</span>
              <select className="input" name="reservationId" defaultValue={d.stays.find((s: any) => s.status === "CHECKED_IN")?.id ?? d.stays[0]?.id ?? ""}>
                {d.stays.map((s: any) => <option key={s.id} value={s.id}>Room {s.room.number} · {s.reference}</option>)}<option value="">General enquiry (no stay)</option>
              </select>
            </label>
            <label className="block"><span className="label">What do you need?</span><select className="input" name="category" required>{d.categories.map((c: string) => <option key={c}>{c}</option>)}</select></label>
            <label className="block"><span className="label">Details</span><textarea className="input min-h-24" name="description" required maxLength={1000} placeholder="E.g. 2 bottles of water and fresh towels please" /></label>
            <label className="block"><span className="label">Priority</span><select className="input" name="priority" defaultValue="NORMAL"><option value="LOW">Whenever convenient</option><option value="NORMAL">Normal</option><option value="HIGH">Soon</option><option value="URGENT">Urgent</option></select></label>
            <SubmitButton className="btn-gold w-full">Send request</SubmitButton>
          </ActionForm>
        </Card>
        <Card title="My requests" padded={false}>
          {d.requests.length === 0 ? <div className="p-4"><EmptyState title="No requests yet" /></div> : (
            <ul className="divide-y divide-ink-100">{d.requests.map((r: any) => (
              <li key={r.id} className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{r.category}{r.room && <span className="text-ink-500"> · Room {r.room.number}</span>}</p><StatusBadge status={r.status} /></div>
                <p className="mt-1 text-sm text-ink-600">{r.description}</p>
                <p className="mt-1 text-xs text-ink-400">{r.reference} · {fmtDateTime(r.createdAt)}{r.assignedToName && ` · Handled by ${r.assignedToName}`}</p>
                {r.completionNotes && <p className="mt-2 rounded bg-emerald-50 px-2 py-1 text-sm text-emerald-800">{r.completionNotes}</p>}
                {r.status === "OPEN" && <ActionForm action={`/guest/services/${r.id}/cancel`} className="mt-2" confirm="Cancel this request?"><SubmitButton className="btn-ghost btn-sm">Cancel request</SubmitButton></ActionForm>}
              </li>
            ))}</ul>
          )}
        </Card>
      </div>
    )}</Load>
  );
}

export function Messages() {
  const q = useApi<any>("/guest/conversations", { refetchInterval: 20_000 });
  const navigate = useNavigate();
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
      <Card title="Conversations" padded={false}>
        <Load q={q}>{(d) => d.conversations.length === 0 ? <div className="p-4"><EmptyState title="No messages yet" body="Start a conversation with the front desk or concierge." /></div> : (
          <ul className="divide-y divide-ink-100">{d.conversations.map((c: any) => (
            <li key={c.id}><Link to={`/account/messages/${c.id}`} className="block p-4 hover:bg-ink-50">
              <div className="flex items-center justify-between gap-2"><p className="font-medium">{c.subject}</p><span className="flex items-center gap-2">{c._count.messages > 0 && <Badge tone="gold">{c._count.messages} new</Badge>}<Badge>{c.channel === "CONCIERGE" ? "Concierge" : "Front desk"}</Badge></span></div>
              <p className="mt-1 line-clamp-1 text-sm text-ink-500">{c.messages[0]?.body}</p>
              <p className="mt-1 text-xs text-ink-400">{fmtDateTime(c.lastMessageAt)}{c.isClosed && " · Closed"}</p>
            </Link></li>
          ))}</ul>
        )}</Load>
      </Card>
      <Card title="New message">
        <ActionForm action="/guest/conversations" className="space-y-3" resetOnSuccess onSuccess={(r) => navigate(`/account/messages/${r.data?.id}`)}>
          <label className="block"><span className="label">To</span><select className="input" name="channel"><option value="FRONT_DESK">Front desk</option><option value="CONCIERGE">Concierge</option></select></label>
          <label className="block"><span className="label">Subject</span><input className="input" name="subject" required maxLength={120} /></label>
          <label className="block"><span className="label">Message</span><textarea className="input min-h-28" name="body" required maxLength={2000} /></label>
          <label className="block"><span className="label">Photo (optional)</span><input className="input" type="file" name="attachment" accept="image/jpeg,image/png,image/webp" /></label>
          <SubmitButton className="btn-primary w-full">Send</SubmitButton>
        </ActionForm>
      </Card>
    </div>
  );
}

export function Thread() {
  const { id } = useParams();
  const q = useApi<any>(`/guest/conversations/${id}`, { refetchInterval: 10_000 });
  return (
    <Load q={q}>{({ conversation: c }) => (
      <div className="mx-auto max-w-3xl">
        <PageHeader title={c.subject} subtitle={`${c.channel === "CONCIERGE" ? "Concierge" : "Front desk"}${c.assignedToName ? ` · ${c.assignedToName}` : ""}`} back={{ href: "/account/messages", label: "All messages" }} />
        <Card><MessageThread messages={c.messages} viewer="guest" /></Card>
        <Card className="mt-4">
          <ActionForm action={`/guest/conversations/${c.id}/messages`} className="space-y-3" resetOnSuccess>
            <textarea className="input min-h-20" name="body" placeholder="Write a reply…" maxLength={2000} />
            <div className="flex flex-wrap items-center justify-between gap-2"><input type="file" name="attachment" accept="image/jpeg,image/png,image/webp" className="text-sm" /><SubmitButton pendingText="Sending…">Send</SubmitButton></div>
          </ActionForm>
        </Card>
      </div>
    )}</Load>
  );
}

export function Billing() {
  const [sp, setSp] = useSearchParams();
  const q = useApi<any>(`/guest/billing${sp.get("ref") ? `/${sp.get("ref")}` : ""}`);
  return (
    <Load q={q}>{(d) => {
      if (!d.current) return <EmptyState title="No bills yet" />;
      const { current, folio } = d;
      return (
        <div className="space-y-5">
          <label className="block max-w-md"><span className="label">Booking</span>
            <select className="input" value={current.reference} onChange={(e) => setSp({ ref: e.target.value })}>{d.stays.map((s: any) => <option key={s.id} value={s.reference}>{s.reference} · Room {s.room.number} · {fmtDate(s.arrivalDate)}</option>)}</select>
          </label>
          <Card title={<>Itemised account · <span className="font-mono">{current.reference}</span> <StatusBadge status={folio.paymentStatus} /></>} padded={false}
            actions={<>{current.invoices[0] && <Link className="btn-secondary btn-sm" target="_blank" to={`/documents/invoice/${current.invoices[0].id}`}>Download invoice</Link>}{num(folio.balance) > 0 && !["CANCELLED", "NO_SHOW"].includes(current.status) && <Link className="btn-gold btn-sm" to={`/account/reservations/${current.reference}/pay`}>Pay balance</Link>}</>}>
            <TableWrap><table className="table">
              <thead><tr><th>Date</th><th>Description</th><th className="text-right">Amount</th></tr></thead>
              <tbody>{folio.lines.map((l: any) => <tr key={l.id} className={l.reversalOfId || l.isReversed ? "text-ink-400" : ""}><td className="whitespace-nowrap">{fmtDate(l.serviceDate)}</td><td>{l.description}</td><td className="text-right font-medium"><Money value={l.lineTotal} /></td></tr>)}</tbody>
            </table></TableWrap>
            <dl className="ml-auto max-w-sm space-y-1 p-4 text-sm">
              {folio.byCategory.map((c: any) => <div key={c.category} className="flex justify-between text-ink-600"><dt>{c.label}</dt><dd><Money value={c.amount} /></dd></div>)}
              <div className="flex justify-between border-t border-ink-100 pt-1 font-semibold"><dt>Total charges</dt><dd><Money value={folio.total} /></dd></div>
              <div className="flex justify-between text-xs text-ink-500"><dt>Includes tax</dt><dd><Money value={folio.tax} /></dd></div>
              {num(folio.deposits) > 0 && <div className="flex justify-between text-ink-600"><dt>Deposits received</dt><dd><Money value={folio.deposits} /></dd></div>}
              <div className="flex justify-between text-emerald-700"><dt>Payments</dt><dd>−<Money value={folio.paid} /></dd></div>
              {num(folio.refunded) > 0 && <div className="flex justify-between"><dt>Refunds</dt><dd>+<Money value={folio.refunded} /></dd></div>}
              <div className="flex justify-between border-t border-ink-200 pt-1 text-base font-semibold"><dt>{num(folio.balance) < 0 ? "Credit" : "Balance due"}</dt><dd><Money value={Math.abs(num(folio.balance))} /></dd></div>
            </dl>
          </Card>
        </div>
      );
    }}</Load>
  );
}

export function Payments() {
  const q = useApi<any>("/guest/payments");
  return (
    <Load q={q}>{(d) => d.payments.length === 0 ? <EmptyState title="No payments yet" /> : (
      <Card title="Payment history" padded={false}>
        <TableWrap><table className="table">
          <thead><tr><th>Date</th><th>Booking</th><th>Method</th><th>Status</th><th className="text-right">Amount</th><th>Refunds</th><th /></tr></thead>
          <tbody>{d.payments.map((p: any) => (
            <tr key={p.id}>
              <td className="whitespace-nowrap">{fmtDateTime(p.receivedAt)}</td><td className="font-mono">{p.reservation?.reference ?? "—"}</td><td>{METHOD_LABEL[p.method]}</td>
              <td><StatusBadge status={p.status} />{p.rejectionReason && <p className="text-xs text-red-600">{p.rejectionReason}</p>}</td>
              <td className="text-right"><Money value={p.amount} /></td>
              <td className="text-xs">{p.refunds.map((r: any) => <div key={r.id}><Money value={r.amount} /> <StatusBadge status={r.status} /></div>)}</td>
              <td>{p.receipt && <Link target="_blank" className="link" to={`/documents/receipt/${p.id}`}>Receipt</Link>}</td>
            </tr>
          ))}</tbody>
        </table></TableWrap>
      </Card>
    )}</Load>
  );
}

export function Profile() {
  const q = useApi<any>("/guest/profile");
  return (
    <Load q={q}>{({ guest, email, prefs }) => (
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Personal details">
          <ActionForm action="/guest/profile" className="grid gap-3 sm:grid-cols-2">
            <label><span className="label">First name</span><input className="input" name="firstName" defaultValue={guest.firstName} required /></label>
            <label><span className="label">Last name</span><input className="input" name="lastName" defaultValue={guest.lastName} required /></label>
            <label className="sm:col-span-2"><span className="label">Email</span><input className="input" value={email} disabled /></label>
            <label><span className="label">Phone</span><input className="input" name="phone" defaultValue={guest.phone ?? ""} required /></label>
            <label><span className="label">Nationality</span><input className="input" name="nationality" defaultValue={guest.nationality ?? ""} /></label>
            <label className="sm:col-span-2"><span className="label">Address</span><input className="input" name="address" defaultValue={guest.address ?? ""} /></label>
            <label><span className="label">City</span><input className="input" name="city" defaultValue={guest.city ?? ""} /></label>
            <label><span className="label">Country</span><input className="input" name="country" defaultValue={guest.country ?? ""} /></label>
            <fieldset className="space-y-1 text-sm sm:col-span-2"><legend className="label">Notifications</legend>
              <label className="flex items-center gap-2"><input type="checkbox" name="emailPrefs" defaultChecked={prefs.email !== false} /> Email me booking and payment updates</label>
              <label className="flex items-center gap-2"><input type="checkbox" name="smsPrefs" defaultChecked={prefs.sms !== false} /> Send SMS for important updates</label>
              <label className="flex items-center gap-2"><input type="checkbox" name="marketingOptIn" defaultChecked={guest.marketingOptIn} /> Send me occasional offers</label>
            </fieldset>
            <div className="sm:col-span-2"><SubmitButton>Save profile</SubmitButton></div>
          </ActionForm>
        </Card>
        <div className="space-y-5">
          <Card title="Stay preferences">
            <ul className="mb-3 space-y-1 text-sm">
              {guest.preferences.map((p: any) => <li key={p.id} className="flex items-center justify-between rounded bg-ink-50 px-3 py-1.5"><span><span className="text-ink-500">{p.category}:</span> {p.value}</span><ActionForm action="/guest/preferences"><input type="hidden" name="removeId" value={p.id} /><SubmitButton className="btn-ghost btn-sm" pendingText="…">Remove</SubmitButton></ActionForm></li>)}
              {!guest.preferences.length && <li className="text-ink-500">No preferences saved.</li>}
            </ul>
            <ActionForm action="/guest/preferences" className="flex flex-wrap gap-2" resetOnSuccess>
              <select name="category" className="input w-auto"><option>Room</option><option>Pillow</option><option>Diet</option><option>Floor</option><option>Other</option></select>
              <input name="value" className="input min-w-0 flex-1" placeholder="E.g. quiet room, extra pillows" required />
              <SubmitButton className="btn-secondary">Add</SubmitButton>
            </ActionForm>
          </Card>
          <Card title="Change password">
            <ActionForm action="/auth/guest/change-password" className="space-y-3" resetOnSuccess>
              <label className="block"><span className="label">Current password</span><input className="input" type="password" name="current" required /></label>
              <label className="block"><span className="label">New password</span><input className="input" type="password" name="password" minLength={8} required /></label>
              <label className="block"><span className="label">Confirm new password</span><input className="input" type="password" name="confirm" required /></label>
              <SubmitButton>Change password</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      </div>
    )}</Load>
  );
}

const SERVICES = [["cleanliness", "Cleanliness"], ["staff", "Staff"], ["comfort", "Comfort"], ["value", "Value"], ["food", "Food & drink"]] as const;
function Stars({ name, required }: { name: string; required?: boolean }) {
  return <select name={name} className="input w-auto" required={required} defaultValue=""><option value="">—</option>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{"★".repeat(n)} ({n})</option>)}</select>;
}

export function Reviews() {
  const [sp] = useSearchParams();
  const q = useApi<any>("/guest/reviews");
  return (
    <Load q={q}>{({ eligible, mine }) => (
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-5">
          <Card title="Review a stay">
            {eligible.length === 0 ? <p className="text-sm text-ink-500">Verified reviews can be written after you check out. You have no stays awaiting a review.</p> : (
              <ActionForm action="/guest/reviews" className="space-y-3" resetOnSuccess>
                <input type="hidden" name="kind" value="REVIEW" />
                <label className="block"><span className="label">Stay</span><select name="reservationId" className="input" defaultValue={sp.get("stay") ?? eligible[0].id}>{eligible.map((r: any) => <option key={r.id} value={r.id}>Room {r.room.number} · {fmtDate(r.arrivalDate)} ({r.reference})</option>)}</select></label>
                <label className="block"><span className="label">Overall rating</span><Stars name="rating" required /></label>
                <div className="grid grid-cols-2 gap-2 text-sm">{SERVICES.map(([k, l]) => <label key={k} className="flex items-center justify-between gap-2"><span>{l}</span><Stars name={`svc_${k}`} /></label>)}</div>
                <label className="block"><span className="label">Title</span><input className="input" name="title" maxLength={120} /></label>
                <label className="block"><span className="label">Your review</span><textarea className="input min-h-24" name="body" required maxLength={3000} /></label>
                <SubmitButton className="btn-gold">Submit review</SubmitButton>
              </ActionForm>
            )}
          </Card>
          <Card title="Complaint or suggestion">
            <ActionForm action="/guest/reviews" className="space-y-3" resetOnSuccess>
              <label className="block"><span className="label">Type</span><select name="kind" className="input"><option value="COMPLAINT">Complaint</option><option value="SUGGESTION">Suggestion for improvement</option></select></label>
              <label className="block"><span className="label">Subject</span><input className="input" name="title" maxLength={120} required /></label>
              <label className="block"><span className="label">Details</span><textarea className="input min-h-24" name="body" required maxLength={3000} /></label>
              <SubmitButton>Send to management</SubmitButton>
            </ActionForm>
          </Card>
        </div>
        <Card title="My feedback">
          {mine.length === 0 ? <EmptyState title="Nothing submitted yet" /> : (
            <ul className="space-y-3">{mine.map((r: any) => (
              <li key={r.id} className="rounded-lg border border-ink-100 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2"><Badge tone={r.kind === "COMPLAINT" ? "red" : r.kind === "REVIEW" ? "gold" : "blue"}>{r.kind.toLowerCase()}</Badge>{r.rating && <span className="text-gold-500">{"★".repeat(r.rating)}</span>}{r.isVerifiedStay && <Badge tone="green">Verified stay</Badge>}</div>
                {r.title && <p className="mt-1 font-medium">{r.title}</p>}
                <p className="mt-1 text-ink-600">{r.body}</p>
                <p className="mt-1 text-xs text-ink-400">{fmtDateTime(r.createdAt)}</p>
                {r.staffResponse && <p className="mt-2 rounded bg-ink-50 p-2 text-ink-700"><strong>Hotel response:</strong> {r.staffResponse}</p>}
              </li>
            ))}</ul>
          )}
        </Card>
      </div>
    )}</Load>
  );
}

export function GuestNotifications() {
  const q = useApi<any>("/guest/notifications");
  return (
    <Card title="Notifications" padded={false} actions={<ActionForm action="/guest/notifications/read"><SubmitButton className="btn-secondary btn-sm">Mark all as read</SubmitButton></ActionForm>}>
      <Load q={q}>{(d) => d.notifications.length === 0 ? <div className="p-4"><EmptyState title="You're all caught up" /></div> : (
        <ul className="divide-y divide-ink-100">{d.notifications.map((n: any) => (
          <li key={n.id} className={`flex items-start justify-between gap-3 p-4 ${n.readAt ? "" : "bg-gold-50/50"}`}>
            <div className="min-w-0">
              <p className="font-medium">{!n.readAt && <span className="mr-2 inline-block h-2 w-2 rounded-full bg-gold-500" />}{n.title} <Badge>{n.category}</Badge></p>
              <p className="mt-0.5 text-sm text-ink-600">{n.body}</p>
              <p className="mt-1 text-xs text-ink-400">{fmtDateTime(n.createdAt)}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {n.link && <Link className="link text-sm" to={n.link}>Open</Link>}
              {!n.readAt && <ActionForm action="/guest/notifications/read"><input type="hidden" name="id" value={n.id} /><SubmitButton className="btn-ghost btn-sm" pendingText="…">Mark read</SubmitButton></ActionForm>}
            </div>
          </li>
        ))}</ul>
      )}</Load>
    </Card>
  );
}

