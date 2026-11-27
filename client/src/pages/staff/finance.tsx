import { Link, useSearchParams } from "react-router-dom";
import { useApi } from "@/lib/query";
import { useStaffMe } from "@/lib/auth";
import { downloadUrl, fileUrl } from "@/lib/api";
import { CHARGE_LABELS, METHOD_LABEL, STATUS_LABEL, fmtDate, fmtDateTime, naira, num, stayWhen } from "@/lib/format";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { GetForm, qs } from "@/components/get-form";
import { Alert, Card, EmptyState, Load, Money, PageHeader, Pagination, Stat, StatusBadge, TableWrap } from "@/components/ui";
import { PrintButton } from "@/components/print-button";

export function PaymentsAdmin() {
  const [sp] = useSearchParams();
  const { can } = useStaffMe();
  const p = Object.fromEntries(sp.entries());
  const q = useApi<any>(qs("/staff/payments", p));
  return (
    <div className="space-y-4">
      <PageHeader title="Payments" subtitle={q.data && <>{q.data.total} payment(s) · verified total <Money value={q.data.verifiedTotal} /></>} actions={can("payments.record") && <Link className="btn-gold" to="/manage/front-desk/check-out?mode=pay">Record payment</Link>} />
      <GetForm className="card grid gap-3 p-3 sm:grid-cols-3 lg:grid-cols-6">
        <label className="lg:col-span-2"><span className="label">Search</span><input name="q" defaultValue={p.q} className="input" placeholder="Payment, transfer or booking ref, surname" /></label>
        <label><span className="label">Status</span><select name="status" defaultValue={p.status ?? ""} className="input"><option value="">All</option><option value="PENDING">Pending verification</option><option value="VERIFIED">Verified</option><option value="REJECTED">Rejected</option><option value="FAILED">Failed</option></select></label>
        <label><span className="label">Method</span><select name="method" defaultValue={p.method ?? ""} className="input"><option value="">All</option>{Object.entries(METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label><span className="label">From</span><input type="date" name="from" defaultValue={p.from} className="input" /></label>
        <label><span className="label">To</span><input type="date" name="to" defaultValue={p.to} className="input" /></label>
        <div className="flex gap-2 sm:col-span-3 lg:col-span-6"><button className="btn-primary">Filter</button><Link className="btn-ghost" to="/manage/payments">Reset</Link></div>
      </GetForm>
      <Load q={q}>{(d) => (
        <>
          <Card padded={false}>
            {d.rows.length === 0 ? <div className="p-4"><EmptyState title="No payments" /></div> : (
              <TableWrap><table className="table">
                <thead><tr><th>Received</th><th>Reference</th><th>Guest / booking</th><th>Method</th><th>Status</th><th className="text-right">Amount</th><th>Recorded / verified</th><th /></tr></thead>
                <tbody>{d.rows.map((x: any) => (
                  <tr key={x.id}>
                    <td className="whitespace-nowrap text-xs">{fmtDateTime(x.receivedAt)}</td>
                    <td className="font-mono text-xs">{x.reference}{x.externalRef && <p className="text-ink-500">ext: {x.externalRef}</p>}{x.proofPath && <a className="link" target="_blank" rel="noreferrer" href={fileUrl(x.proofPath)!}>proof</a>}</td>
                    <td>{x.guest.firstName} {x.guest.lastName}{x.reservation && <p><Link className="link text-xs" to={`/manage/reservations/${x.reservation.id}`}>{x.reservation.reference}</Link></p>}</td>
                    <td className="text-xs">{METHOD_LABEL[x.method]}{x.isDeposit && " · deposit"}</td>
                    <td><StatusBadge status={x.status} />{x.rejectionReason && <p className="text-xs text-red-600">{x.rejectionReason}</p>}</td>
                    <td className="text-right font-medium"><Money value={x.amount} /></td>
                    <td className="text-xs">{x.recordedByName ?? "—"}<br />{x.verifiedByName && `✓ ${x.verifiedByName}`}</td>
                    <td className="whitespace-nowrap text-right">
                      {x.status === "PENDING" && can("payments.verify") && <div className="flex justify-end gap-1">
                        <ActionForm action={`/staff/payments/${x.id}/verify`} confirm={`Confirm this ${naira(x.amount)} payment has been received?`}><SubmitButton className="btn-primary btn-sm" pendingText="…">Verify</SubmitButton></ActionForm>
                        <ActionForm action={`/staff/payments/${x.id}/reject`} requireReason confirm="Reject this payment?"><SubmitButton className="btn-danger btn-sm" pendingText="…">Reject</SubmitButton></ActionForm>
                      </div>}
                      {x.receipt && <Link className="link text-xs" target="_blank" to={`/documents/receipt/${x.id}`}>{x.receipt.number}</Link>}
                    </td>
                  </tr>
                ))}</tbody>
              </table></TableWrap>
            )}
          </Card>
          <Pagination page={d.page} pages={d.pages} makeHref={(n) => qs("/manage/payments", { ...p, page: n })} />
        </>
      )}</Load>
    </div>
  );
}

export function Invoices() {
  const [sp] = useSearchParams();
  const p = Object.fromEntries(sp.entries());
  const q = useApi<any>(qs("/staff/invoices", p));
  return (
    <div className="space-y-4">
      <PageHeader title="Invoices" subtitle="Invoices are fixed snapshots. Generate a new one from the reservation if the bill changes." />
      <GetForm className="flex gap-2"><input name="q" defaultValue={p.q} className="input max-w-xs" placeholder="Invoice or booking ref" /><button className="btn-secondary">Search</button></GetForm>
      <Load q={q}>{(d) => (
        <>
          <Card padded={false}>
            {d.rows.length === 0 ? <div className="p-4"><EmptyState title="No invoices yet" /></div> : (
              <TableWrap><table className="table">
                <thead><tr><th>Number</th><th>Issued</th><th>Guest</th><th>Booking</th><th className="text-right">Total</th><th className="text-right">Paid</th><th className="text-right">Balance</th><th>By</th></tr></thead>
                <tbody>{d.rows.map((i: any) => (
                  <tr key={i.id}>
                    <td><Link target="_blank" className="link font-mono" to={`/documents/invoice/${i.id}`}>{i.number}</Link>{i.isFinal && <span className="ml-1 text-xs text-ink-500">final</span>}</td>
                    <td className="text-xs">{fmtDateTime(i.issuedAt)}</td><td>{i.reservation.guest.firstName} {i.reservation.guest.lastName}</td>
                    <td><Link className="link font-mono text-xs" to={`/manage/reservations/${i.reservationId}`}>{i.reservation.reference}</Link></td>
                    <td className="text-right"><Money value={i.total} /></td><td className="text-right"><Money value={i.paid} /></td><td className="text-right"><Money value={i.balance} /></td><td className="text-xs">{i.issuedByName}</td>
                  </tr>
                ))}</tbody>
              </table></TableWrap>
            )}
          </Card>
          <Pagination page={d.page} pages={d.pages} makeHref={(n) => qs("/manage/invoices", { ...p, page: n })} />
        </>
      )}</Load>
    </div>
  );
}

export function Refunds() {
  const { can } = useStaffMe();
  const q = useApi<any>("/staff/refunds");
  return (
    <div className="space-y-4">
      <PageHeader title="Refunds" subtitle="Refunds are requested from a verified payment on the reservation page and must be approved by finance." />
      <Alert>To request a refund, open the reservation, find the verified payment and choose “Request refund”.</Alert>
      <Load q={q}>{({ refunds }) => (
        <Card padded={false}>
          {refunds.length === 0 ? <div className="p-4"><EmptyState title="No refunds" /></div> : (
            <TableWrap><table className="table">
              <thead><tr><th>Reference</th><th>Requested</th><th>Guest / booking</th><th>Original payment</th><th className="text-right">Amount</th><th>Method</th><th>Reason</th><th>Status</th><th /></tr></thead>
              <tbody>{refunds.map((r: any) => (
                <tr key={r.id}>
                  <td className="font-mono text-xs">{r.reference}</td>
                  <td className="text-xs">{fmtDateTime(r.createdAt)}<br />{r.requestedByName}</td>
                  <td>{r.payment.guest.firstName} {r.payment.guest.lastName}{r.payment.reservation && <p><Link className="link text-xs" to={`/manage/reservations/${r.payment.reservation.id}`}>{r.payment.reservation.reference}</Link></p>}</td>
                  <td className="text-xs">{r.payment.reference} · <Money value={r.payment.amount} /></td>
                  <td className="text-right font-medium"><Money value={r.amount} /></td>
                  <td className="text-xs">{METHOD_LABEL[r.method]}</td>
                  <td className="max-w-48 text-xs">{r.reason}{r.rejectionReason && <p className="text-red-600">Rejected: {r.rejectionReason}</p>}</td>
                  <td><StatusBadge status={r.status} />{r.processedByName && <p className="text-xs text-ink-500">{r.processedByName}</p>}</td>
                  <td className="whitespace-nowrap">{["REQUESTED", "APPROVED"].includes(r.status) && can("refunds.process") && <div className="flex gap-1">
                    <ActionForm action={`/staff/refunds/${r.id}/decide`} requireReason reasonLabel="Payout reference / note" confirm={`Confirm ${naira(r.amount)} has been paid back to the guest?`}><input type="hidden" name="decision" value="PROCESS" /><SubmitButton className="btn-primary btn-sm" pendingText="…">Process</SubmitButton></ActionForm>
                    <ActionForm action={`/staff/refunds/${r.id}/decide`} requireReason confirm="Reject this refund request?"><input type="hidden" name="decision" value="REJECT" /><SubmitButton className="btn-danger btn-sm" pendingText="…">Reject</SubmitButton></ActionForm>
                  </div>}</td>
                </tr>
              ))}</tbody>
            </table></TableWrap>
          )}
        </Card>
      )}</Load>
    </div>
  );
}

export function Expenses() {
  const [sp] = useSearchParams();
  const { can } = useStaffMe();
  const p = Object.fromEntries(sp.entries());
  const q = useApi<any>(qs("/staff/expenses", p));
  return (
    <Load q={q}>{({ from, to, rows, total, categories, today }) => (
      <div className="space-y-4">
        <PageHeader title="Expenses" subtitle={<>{fmtDate(from)} – {fmtDate(to)} · total <Money value={total} /></>} />
        <GetForm className="card flex flex-wrap items-end gap-3 p-3">
          <label><span className="label">From</span><input type="date" name="from" defaultValue={from} className="input" /></label>
          <label><span className="label">To</span><input type="date" name="to" defaultValue={to} className="input" /></label>
          <label><span className="label">Category</span><select name="category" defaultValue={p.category ?? ""} className="input"><option value="">All</option>{categories.map((c: string) => <option key={c}>{c}</option>)}</select></label>
          <button className="btn-secondary">Filter</button>
        </GetForm>
        <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
          <Card padded={false}>
            {rows.length === 0 ? <div className="p-4"><EmptyState title="No expenses in this period" /></div> : (
              <TableWrap><table className="table">
                <thead><tr><th>Date</th><th>Ref</th><th>Category</th><th>Description</th><th>Paid via</th><th className="text-right">Amount</th><th /></tr></thead>
                <tbody>{rows.map((e: any) => (
                  <tr key={e.id} className={e.voidedAt ? "text-ink-400 line-through" : ""}>
                    <td className="whitespace-nowrap">{fmtDate(e.expenseDate)}</td><td className="font-mono text-xs">{e.reference}</td><td>{e.category}</td>
                    <td>{e.description}{e.vendor && <p className="text-xs text-ink-500">{e.vendor}</p>}<p className="text-xs text-ink-400">by {e.recordedByName}</p>{e.voidReason && <p className="text-xs text-red-600">Voided: {e.voidReason}</p>}</td>
                    <td className="text-xs">{e.paymentMethod}</td><td className="text-right"><Money value={e.amount} /></td>
                    <td>{e.voidedAt ? <StatusBadge status="CANCELLED" label="Voided" /> : can("expenses.manage") && <ActionForm action={`/staff/expenses/${e.id}/void`} requireReason confirm="Void this expense? It stays on record but is excluded from totals."><SubmitButton className="btn-ghost btn-sm" pendingText="…">Void</SubmitButton></ActionForm>}</td>
                  </tr>
                ))}</tbody>
              </table></TableWrap>
            )}
          </Card>
          {can("expenses.manage") && (
            <Card title="Record expense">
              <ActionForm action="/staff/expenses" className="space-y-3" resetOnSuccess>
                <label className="block"><span className="label">Date</span><input type="date" name="expenseDate" defaultValue={today} className="input" required /></label>
                <label className="block"><span className="label">Category</span><select name="category" className="input">{categories.map((c: string) => <option key={c}>{c}</option>)}</select></label>
                <label className="block"><span className="label">Description</span><input name="description" className="input" required /></label>
                <label className="block"><span className="label">Vendor</span><input name="vendor" className="input" /></label>
                <label className="block"><span className="label">Amount (₦)</span><input name="amount" className="input" inputMode="decimal" required /></label>
                <label className="block"><span className="label">Paid via</span><select name="paymentMethod" className="input"><option>Cash</option><option>Bank transfer</option><option>POS / card</option><option>Cheque</option></select></label>
                <SubmitButton className="btn-gold w-full">Record expense</SubmitButton>
              </ActionForm>
            </Card>
          )}
        </div>
      </div>
    )}</Load>
  );
}

// ───────────────────────── Reports ─────────────────────────

function Bars({ rows }: { rows: { key: string; amount: unknown }[] }) {
  const max = rows.reduce((m, r) => Math.max(m, num(r.amount)), 0);
  return (
    <ul className="space-y-1.5 text-sm">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[120px_1fr_auto] items-center gap-2">
          <span className="truncate text-ink-600">{r.key}</span>
          <span className="h-2.5 rounded bg-ink-100"><span className="block h-2.5 rounded bg-gold-500" style={{ width: `${max ? (num(r.amount) / max) * 100 : 0}%` }} /></span>
          <Money value={r.amount as string} className="text-xs" />
        </li>
      ))}
      {!rows.length && <li className="text-ink-500">No data for this period.</li>}
    </ul>
  );
}

export function Reports() {
  const [sp] = useSearchParams();
  const { can } = useStaffMe();
  const tab = sp.get("tab") ?? "financial";
  const params = { preset: sp.get("preset"), from: sp.get("from"), to: sp.get("to") };
  const path = tab === "outstanding" ? "/staff/reports/outstanding" : tab === "bookings" ? "/staff/reports/bookings" : "/staff/reports/financial";
  const q = useApi<any>(qs(path, params));
  const range = q.data?.range;
  const link = (extra: Record<string, string | null>) => qs("/manage/reports", { tab, ...(range ? { from: range.from, to: range.to } : {}), ...extra });
  const exportHref = (type: string) => downloadUrl(qs("/staff/reports/export", { type, from: range?.from, to: range?.to }));
  const canExport = can("reports.export");
  return (
    <div className="space-y-5">
      <PageHeader title="Reports" subtitle={range ? `${fmtDate(range.from)} – ${fmtDate(range.to)} · all figures from recorded transactions` : undefined} actions={<div className="no-print flex gap-2"><PrintButton /></div>} />
      <div className="no-print flex flex-wrap items-end gap-2">
        {[["today", "Today"], ["week", "Last 7 days"], ["month", "This month"], ["last-month", "Last month"], ["year", "This year"]].map(([k, l]) => <Link key={k} className="btn-secondary btn-sm" to={qs("/manage/reports", { tab, preset: k })}>{l}</Link>)}
        <GetForm keep={["tab"]} className="ml-auto flex items-end gap-2"><input type="date" name="from" defaultValue={range?.from} key={range?.from} className="input" /><input type="date" name="to" defaultValue={range?.to} key={range?.to} className="input" /><button className="btn-primary btn-sm">Apply</button></GetForm>
      </div>
      <div className="no-print flex gap-1 border-b border-ink-200">
        {[["financial", "Financial"], ["outstanding", "Outstanding balances"], ["bookings", "Bookings & guests"]].map(([k, l]) => <Link key={k} to={link({ tab: k })} className={`border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? "border-gold-500" : "border-transparent text-ink-500"}`}>{l}</Link>)}
      </div>
      <Load q={q}>{(d) => tab === "outstanding" ? <Outstanding rows={d.rows} canExport={canExport} exportHref={exportHref} /> : tab === "bookings" ? <Bookings b={d} canExport={canExport} exportHref={exportHref} /> : <Financial f={d} canExport={canExport} exportHref={exportHref} />}</Load>
    </div>
  );
}

function Financial({ f, canExport, exportHref }: { f: any; canExport: boolean; exportHref: (t: string) => string }) {
  return (
    <div className="space-y-5">
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-500">Revenue earned (accrual)</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          <Stat label="Revenue earned" value={<Money value={f.revenue} />} hint="excl. VAT, net of discounts" />
          <Stat label="Overnight room revenue" value={<Money value={f.nightRevenue} />} />
          <Stat label="Short-stay revenue" value={<Money value={f.shortStayRevenue} />} hint={`${f.shortStays} short stay(s)`} />
          <Stat label="Other revenue" value={<Money value={f.otherRevenue} />} />
          <Stat label="Occupancy" value={`${Number(f.occupancy).toFixed(1)}%`} hint={`${f.soldNights} of ${f.availableNights} room-nights`} />
          <Stat label="ADR" value={<Money value={f.adr} />} hint="Average nightly rate" />
          <Stat label="RevPAR" value={<Money value={f.revpar} />} hint="incl. short stays" />
        </div>
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-500">Cash (payments)</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Payments received" value={<Money value={f.paymentsTotal} />} hint="verified only" />
          <Stat label="of which deposits" value={<Money value={f.depositsTotal} />} />
          <Stat label="Refunds paid" value={<Money value={f.refundsTotal} />} />
          <Stat label="Net cash in" value={<Money value={f.netCash} />} />
          <Stat label="VAT collected" value={<Money value={f.taxCollected} />} />
          <Stat label="Service charges" value={<Money value={f.serviceCharges} />} />
        </div>
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-500">Costs</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <Stat label="Expenses" value={<Money value={f.expensesTotal} />} />
          <Stat label="Revenue less expenses" value={<Money value={f.netOperating} />} tone={num(f.netOperating) < 0 ? "bad" : "good"} />
        </div>
      </section>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Daily revenue earned"><Bars rows={f.dailyRevenue.map((d: any) => ({ key: fmtDate(d.day), amount: d.amount }))} /></Card>
        <Card title="Revenue by room"><Bars rows={f.revenueByRoom.map((r: any) => ({ key: `Room ${r.key} (${r.nights}n)`, amount: r.amount }))} /></Card>
        <Card title="Revenue by category"><Bars rows={f.revenueByCategory.map((r: any) => ({ key: CHARGE_LABELS[r.key] ?? r.key, amount: r.amount }))} /></Card>
        <Card title="Payments by method"><Bars rows={f.paymentsByMethod.map((r: any) => ({ key: METHOD_LABEL[r.key] ?? r.key, amount: r.amount }))} /></Card>
        <Card title="Expenses by category"><Bars rows={f.expensesByCategory} /></Card>
        <Card title="Definitions">
          <ul className="list-disc space-y-1 pl-5 text-xs text-ink-600">
            <li><strong>Revenue earned</strong>: charges for nights, short stays and services in the period plus cancellation/no-show fees, net of reversals and discounts, before VAT. Prices are VAT-inclusive, so VAT is taken out of each price.</li>
            <li><strong>Payments received</strong>: verified money received in the period, whichever stay it pays for.</li>
            <li>The two are never added together. Outstanding balances are on their own tab.</li>
            <li><strong>ADR</strong> = overnight room revenue ÷ room-nights sold. <strong>RevPAR</strong> = all room revenue (overnight + short stays) ÷ available room-nights.</li>
          </ul>
        </Card>
      </div>
      {canExport && <div className="no-print flex flex-wrap gap-2">{[["revenue", "revenue lines"], ["payments", "payments"], ["refunds", "refunds"], ["expenses", "expenses"]].map(([k, l]) => <a key={k} className="btn-secondary btn-sm" href={exportHref(k)}>Export {l} (CSV)</a>)}</div>}
    </div>
  );
}

function Outstanding({ rows, canExport, exportHref }: { rows: any[]; canExport: boolean; exportHref: (t: string) => string }) {
  const owed = rows.filter((r) => num(r.balance) > 0), credit = rows.filter((r) => num(r.balance) < 0);
  const tbl = (list: any[]) => (
    <TableWrap><table className="table"><thead><tr><th>Booking</th><th>Guest</th><th>Room</th><th>Stay</th><th>Status</th><th className="text-right">Charges</th><th className="text-right">Paid</th><th className="text-right">Balance</th></tr></thead>
      <tbody>{list.map((r) => <tr key={r.id}><td><Link className="link font-mono" to={`/manage/reservations/${r.id}`}>{r.reference}</Link></td><td>{r.guest.firstName} {r.guest.lastName}<p className="text-xs text-ink-500">{r.guest.phone}</p></td><td>{r.room.number}</td><td className="whitespace-nowrap text-xs">{stayWhen(r)}</td><td><StatusBadge status={r.status} label={STATUS_LABEL[r.status]} /></td><td className="text-right"><Money value={r.total} /></td><td className="text-right"><Money value={r.paid} /></td><td className="text-right font-semibold"><Money value={r.balance} /></td></tr>)}</tbody></table></TableWrap>
  );
  return (
    <div className="space-y-5">
      <Card title={`Guests owing the hotel (${owed.length})`} padded={false} actions={canExport && <a className="btn-secondary btn-sm no-print" href={exportHref("outstanding")}>Export CSV</a>}>{tbl(owed)}</Card>
      <Card title={`Credits owed to guests — refunds due (${credit.length})`} padded={false}>{tbl(credit)}</Card>
    </div>
  );
}

function Bookings({ b, canExport, exportHref }: { b: any; canExport: boolean; exportHref: (t: string) => string }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Bookings made" value={b.created} />
        <Stat label="Cancellations" value={b.cancelled} hint={`${Number(b.cancellationRate).toFixed(1)}% of bookings made`} />
        <Stat label="No-shows" value={b.noShows} />
        <Stat label="Overnight stays in period" value={b.staysInPeriod - (b.shortStaysInPeriod ?? 0)} hint={`avg ${Number(b.avgLengthOfStay).toFixed(1)} nights`} />
        <Stat label="Short stays in period" value={b.shortStaysInPeriod ?? 0} />
        <Stat label="Guests served" value={b.guestsServed} />
        <Stat label="Unique guests" value={b.uniqueGuests} />
        <Stat label="New guest profiles" value={b.newGuests} />
        <Stat label="Repeat guests (all time)" value={b.repeatGuests} />
      </div>
      <Card title="Booking sources" actions={canExport && <a className="btn-secondary btn-sm no-print" href={exportHref("bookings")}>Export bookings (CSV)</a>}>
        <ul className="space-y-1 text-sm">{b.bySource.map((s: any) => <li key={s.key} className="flex justify-between"><span className="capitalize">{s.key.replace("_", " ").toLowerCase()}</span><strong>{s.count}</strong></li>)}{!b.bySource.length && <li className="text-ink-500">No bookings in this period.</li>}</ul>
      </Card>
    </div>
  );
}
