import { useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useApi } from "@/lib/query";
import { useStaffMe } from "@/lib/auth";
import { downloadUrl, fileUrl } from "@/lib/api";
import { HOTEL_TZ, fmtDate, fmtDateTime, naira } from "@/lib/format";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { GetForm, qs } from "@/components/get-form";
import { Alert, Badge, Card, DL, EmptyState, Load, PageHeader, Pagination, StatusBadge, TableWrap } from "@/components/ui";

// ───────────────────────── Staff ─────────────────────────

export function Staff() {
  const { can } = useStaffMe();
  const q = useApi<any>("/staff/staff");
  return (
    <Load q={q}>{({ users }) => (
      <div className="space-y-4">
        <PageHeader title="Staff" subtitle={`${users.filter((u: any) => u.isActive).length} active accounts`} actions={can("staff.manage") && <Link className="btn-gold" to="/manage/staff/new">Add staff member</Link>} />
        <Card padded={false}>
          <TableWrap><table className="table">
            <thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Status</th><th>Last active</th></tr></thead>
            <tbody>{users.map((u: any) => (
              <tr key={u.id} className={u.isActive ? "" : "opacity-60"}>
                <td><Link className="link" to={`/manage/staff/${u.id}`}>{u.firstName} {u.lastName}</Link>{u.jobTitle && <p className="text-xs text-ink-500">{u.jobTitle}</p>}</td>
                <td>{u.email}</td>
                <td className="space-x-1">{u.roles.map((r: any) => <Badge key={r.roleId}>{r.role.name}</Badge>)}</td>
                <td>{u.isActive ? <StatusBadge status="VERIFIED" label="Active" /> : <StatusBadge status="CANCELLED" label="Deactivated" />}{u.mustChangePassword && <p className="text-xs text-amber-700">must change password</p>}</td>
                <td className="text-xs">{u.sessions[0] ? fmtDateTime(u.sessions[0].lastSeenAt) : "Never"}</td>
              </tr>
            ))}</tbody>
          </table></TableWrap>
        </Card>
      </div>
    )}</Load>
  );
}

export function NewStaff() {
  const q = useApi<any>("/staff/roles");
  return (
    <div className="space-y-4">
      <PageHeader title="Add staff member" back={{ href: "/manage/staff", label: "Staff" }} subtitle="The staff member must change the temporary password at first sign-in." />
      <Load q={q}>{({ roles }) => (
        <Card>
          <ActionForm action="/staff/staff" className="grid gap-3 sm:grid-cols-2">
            <label><span className="label">First name</span><input name="firstName" className="input" required /></label>
            <label><span className="label">Last name</span><input name="lastName" className="input" required /></label>
            <label><span className="label">Work email</span><input name="email" type="email" className="input" required /></label>
            <label><span className="label">Phone</span><input name="phone" className="input" /></label>
            <label><span className="label">Job title</span><input name="jobTitle" className="input" /></label>
            <label><span className="label">Temporary password</span><input name="tempPassword" className="input" minLength={8} required autoComplete="new-password" /></label>
            <fieldset className="sm:col-span-2"><legend className="label">Roles</legend>
              <div className="grid gap-1 text-sm sm:grid-cols-2">{roles.map((r: any) => <label key={r.id} className="flex items-start gap-2"><input type="checkbox" name="roleIds" value={r.id} className="mt-1" /><span><strong>{r.name}</strong><br /><span className="text-xs text-ink-500">{r.description}</span></span></label>)}</div>
            </fieldset>
            <div className="sm:col-span-2"><SubmitButton className="btn-gold">Create account</SubmitButton></div>
          </ActionForm>
        </Card>
      )}</Load>
    </div>
  );
}

export function StaffMember() {
  const { id } = useParams();
  const { can } = useStaffMe();
  const q = useApi<any>(`/staff/staff/${id}`);
  return (
    <Load q={q}>{({ user: u, roles, logins, activity, self }) => {
      const has = new Set(u.roles.map((r: any) => r.roleId));
      return (
        <div className="space-y-5">
          <PageHeader back={{ href: "/manage/staff", label: "Staff" }} title={`${u.firstName} ${u.lastName}`} subtitle={u.email} actions={u.isActive ? <StatusBadge status="VERIFIED" label="Active" /> : <StatusBadge status="CANCELLED" label="Deactivated" />} />
          <div className="grid gap-5 lg:grid-cols-2">
            {can("staff.manage") ? (
              <Card title="Account & roles">
                <ActionForm action={`/staff/staff/${u.id}`} className="grid gap-3 sm:grid-cols-2" confirm="Save changes? Role changes sign the user out so new permissions apply immediately.">
                  <label><span className="label">First name</span><input name="firstName" className="input" defaultValue={u.firstName} required /></label>
                  <label><span className="label">Last name</span><input name="lastName" className="input" defaultValue={u.lastName} required /></label>
                  <label><span className="label">Phone</span><input name="phone" className="input" defaultValue={u.phone ?? ""} /></label>
                  <label><span className="label">Job title</span><input name="jobTitle" className="input" defaultValue={u.jobTitle ?? ""} /></label>
                  <fieldset className="sm:col-span-2"><legend className="label">Roles {self && "(you cannot change your own roles)"}</legend>
                    <div className="grid gap-1 text-sm sm:grid-cols-2">{roles.map((r: any) => <label key={r.id} className="flex items-center gap-2"><input type="checkbox" name="roleIds" value={r.id} defaultChecked={has.has(r.id)} disabled={self} />{r.name}</label>)}</div>
                    {self && u.roles.map((r: any) => <input key={r.roleId} type="hidden" name="roleIds" value={r.roleId} />)}
                  </fieldset>
                  <div className="sm:col-span-2"><SubmitButton>Save</SubmitButton></div>
                </ActionForm>
              </Card>
            ) : <Card title="Account"><DL items={[["Roles", u.roles.map((r: any) => r.role.name).join(", ")], ["Job title", u.jobTitle], ["Phone", u.phone], ["Created", fmtDateTime(u.createdAt)]]} /></Card>}
            {can("staff.manage") && !self && (
              <div className="space-y-5">
                <Card title="Reset password">
                  <ActionForm action={`/staff/staff/${u.id}/reset-password`} className="flex flex-wrap gap-2" requireReason confirm="Set a temporary password? The user is signed out and must change it at next sign-in." resetOnSuccess>
                    <input name="tempPassword" className="input flex-1" placeholder="Temporary password" minLength={8} required autoComplete="new-password" />
                    <SubmitButton className="btn-secondary">Reset</SubmitButton>
                  </ActionForm>
                </Card>
                <Card title={u.isActive ? "Deactivate account" : "Reactivate account"}>
                  <ActionForm action={`/staff/staff/${u.id}/active`} requireReason confirm={u.isActive ? "Deactivate this account? They will be signed out immediately." : "Reactivate this account?"}>
                    <input type="hidden" name="active" value={u.isActive ? "" : "on"} />
                    <SubmitButton className={u.isActive ? "btn-danger" : "btn-primary"}>{u.isActive ? "Deactivate" : "Reactivate"}</SubmitButton>
                  </ActionForm>
                </Card>
              </div>
            )}
          </div>
          <Card title="Login history" padded={false}>
            <TableWrap><table className="table"><thead><tr><th>Time</th><th>Result</th><th>IP</th><th>Device</th></tr></thead>
              <tbody>{logins.map((l: any) => <tr key={l.id}><td className="text-xs">{fmtDateTime(l.createdAt)}</td><td>{l.success ? <StatusBadge status="SUCCESS" label="Success" /> : <StatusBadge status="FAILURE" label={l.reason ?? "Failed"} />}</td><td className="text-xs">{l.ipAddress ?? "—"}</td><td className="max-w-xs truncate text-xs">{l.userAgent}</td></tr>)}</tbody></table></TableWrap>
          </Card>
          {activity.length > 0 && (
            <Card title="Recent activity" actions={<Link className="link text-sm" to={`/manage/audit?user=${u.id}`}>Full audit trail →</Link>} padded={false}>
              <TableWrap><table className="table"><thead><tr><th>Time</th><th>Action</th><th>Module</th><th>Record</th></tr></thead>
                <tbody>{activity.map((a: any) => <tr key={a.id}><td className="text-xs">{fmtDateTime(a.createdAt)}</td><td className="font-mono text-xs">{a.action}</td><td className="text-xs">{a.module}</td><td className="text-xs">{a.recordType} {a.recordId?.slice(0, 10)}</td></tr>)}</tbody></table></TableWrap>
            </Card>
          )}
        </div>
      );
    }}</Load>
  );
}

// ───────────────────────── Roles ─────────────────────────

export function Roles() {
  const [sp] = useSearchParams();
  const { can } = useStaffMe();
  const q = useApi<any>("/staff/roles");
  return (
    <Load q={q}>{({ roles, catalog }) => {
      const sel = roles.find((r: any) => r.id === sp.get("role")) ?? roles[0];
      const editable = can("roles.manage") && sel && sel.key !== "super_admin";
      const modules = [...new Set(catalog.map((c: any) => c.module))] as string[];
      const PermGrid = ({ checked, disabled }: { checked: Set<string>; disabled: boolean }) => (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{modules.map((m) => (
          <fieldset key={m} className="rounded-lg border border-ink-100 p-3">
            <legend className="px-1 text-sm font-semibold">{m}</legend>
            {catalog.filter((c: any) => c.module === m).map((c: any) => (
              <label key={c.key} className="flex items-start gap-2 py-0.5 text-sm"><input type="checkbox" name="permissions" value={c.key} defaultChecked={checked.has(c.key)} disabled={disabled || !can(c.key)} className="mt-1" /><span>{c.description}<br /><span className="font-mono text-[10px] text-ink-400">{c.key}</span></span></label>
            ))}
          </fieldset>
        ))}</div>
      );
      return (
        <div className="space-y-5">
          <PageHeader title="Roles & permissions" subtitle="Roles bundle granular permissions. Every action is checked on the server against these permissions." />
          <div className="flex flex-wrap gap-2">{roles.map((r: any) => <Link key={r.id} to={`?role=${r.id}`} className={`btn-sm ${r.id === sel?.id ? "btn-primary" : "btn-secondary"}`}>{r.name} <span className="opacity-70">({r._count.users})</span></Link>)}</div>
          {sel && (
            <Card key={sel.id} title={<>{sel.name} {sel.isSystem && <Badge>default role</Badge>}</>}>
              <p className="mb-3 text-sm text-ink-600">{sel.description}</p>
              {sel.key === "super_admin" && <p className="mb-3 text-sm text-amber-700">The Super Administrator role always holds every permission.</p>}
              {editable ? (
                <ActionForm action="/staff/roles" className="space-y-4" requireReason confirm="Change this role's permissions? All staff with this role are affected.">
                  <input type="hidden" name="id" value={sel.id} />
                  <div className="grid gap-3 sm:grid-cols-2"><label><span className="label">Name</span><input name="name" className="input" defaultValue={sel.name} required /></label><label><span className="label">Description</span><input name="description" className="input" defaultValue={sel.description ?? ""} /></label></div>
                  <PermGrid checked={new Set(sel.permissions)} disabled={false} />
                  <p className="text-xs text-ink-500">You can only grant permissions you hold, and cannot edit a role you are assigned to.</p>
                  <SubmitButton>Save role</SubmitButton>
                </ActionForm>
              ) : <PermGrid checked={new Set(sel.permissions)} disabled />}
            </Card>
          )}
          {can("roles.manage") && (
            <Card title="Create a new role">
              <ActionForm action="/staff/roles" className="space-y-4" resetOnSuccess>
                <div className="grid gap-3 sm:grid-cols-2"><label><span className="label">Name</span><input name="name" className="input" required /></label><label><span className="label">Description</span><input name="description" className="input" /></label></div>
                <PermGrid checked={new Set()} disabled={false} />
                <SubmitButton className="btn-gold">Create role</SubmitButton>
              </ActionForm>
            </Card>
          )}
        </div>
      );
    }}</Load>
  );
}

// ───────────────────────── Audit ─────────────────────────

export function Audit() {
  const [sp] = useSearchParams();
  const { can } = useStaffMe();
  const p = Object.fromEntries(sp.entries());
  const q = useApi<any>(qs("/staff/audit", p));
  const { page: _p, ...filters } = p;
  return (
    <div className="space-y-4">
      <PageHeader title="Audit logs" subtitle={q.data && `${q.data.total} record(s) · permanent and read-only`} actions={can("audit.export") && <a className="btn-secondary" href={downloadUrl(qs("/staff/audit/export", filters))}>Export CSV</a>} />
      <Load q={q}>{(d) => (
        <>
          <GetForm className="card grid gap-3 p-3 sm:grid-cols-3 lg:grid-cols-7">
            <label><span className="label">User</span><select name="user" defaultValue={p.user ?? ""} className="input"><option value="">Anyone</option>{d.users.map((u: any) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>)}</select></label>
            <label><span className="label">Module</span><select name="module" defaultValue={p.module ?? ""} className="input"><option value="">All</option>{d.modules.map((m: string) => <option key={m}>{m}</option>)}</select></label>
            <label><span className="label">Action contains</span><input name="action" defaultValue={p.action} className="input" placeholder="e.g. negotiated" /></label>
            <label><span className="label">Outcome</span><select name="outcome" defaultValue={p.outcome ?? ""} className="input"><option value="">All</option><option>SUCCESS</option><option>FAILURE</option><option>DENIED</option></select></label>
            <label><span className="label">From</span><input type="date" name="from" defaultValue={p.from} className="input" /></label>
            <label><span className="label">To</span><input type="date" name="to" defaultValue={p.to} className="input" /></label>
            <button className="btn-primary self-end">Filter</button>
          </GetForm>
          <Card padded={false}>
            {d.rows.length === 0 ? <div className="p-4"><EmptyState title="No audit records match" /></div> : (
              <TableWrap><table className="table">
                <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Record</th><th>Changes</th><th>Outcome</th><th>Source</th></tr></thead>
                <tbody>{d.rows.map((a: any) => (
                  <tr key={a.id}>
                    <td className="whitespace-nowrap text-xs">{fmtDateTime(a.createdAt)}<p className="font-mono text-[10px] text-ink-400">{a.id}</p></td>
                    <td className="text-xs">{a.actorName}<p className="text-ink-400">{a.actorRole}</p></td>
                    <td><span className="font-mono text-xs">{a.action}</span><p className="text-xs text-ink-500">{a.module}</p></td>
                    <td className="text-xs">{a.recordType}<p className="font-mono text-[10px] text-ink-400">{a.recordId}</p></td>
                    <td className="max-w-md text-xs">
                      {a.oldValues != null && <details><summary className="cursor-pointer text-ink-500">before</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(a.oldValues, null, 1)}</pre></details>}
                      {a.newValues != null && <details><summary className="cursor-pointer text-ink-500">after</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(a.newValues, null, 1)}</pre></details>}
                      {a.reason && <p className="mt-1"><strong>Reason:</strong> {a.reason}</p>}
                    </td>
                    <td><StatusBadge status={a.outcome} /></td>
                    <td className="text-[10px] text-ink-500">{a.ipAddress ?? "—"}<p className="max-w-[10rem] truncate">{a.userAgent}</p></td>
                  </tr>
                ))}</tbody>
              </table></TableWrap>
            )}
          </Card>
          <Pagination page={d.page} pages={d.pages} makeHref={(n) => qs("/manage/audit", { ...filters, page: n })} />
        </>
      )}</Load>
    </div>
  );
}

// ───────────────────────── Settings ─────────────────────────

const TABS: [string, string][] = [["hotel", "Hotel"], ["policies", "Policies"], ["finance", "Finance & tax"], ["shortStay", "Short stays"], ["pricing", "Seasonal & discounts"], ["reservations", "Reservations"], ["notifications", "Notifications"], ["security", "Security"], ["integrations", "Integrations"]];

function F({ label, name, value, type = "text", wide, hint }: { label: string; name: string; value: string | number; type?: string; wide?: boolean; hint?: string }) {
  return <label className={wide ? "sm:col-span-2" : ""}><span className="label">{label}</span><input className="input" name={name} type={type} defaultValue={value} />{hint && <span className="mt-1 block text-xs text-ink-500">{hint}</span>}</label>;
}
function T({ label, name, value }: { label: string; name: string; value: string }) { return <label className="sm:col-span-2"><span className="label">{label}</span><textarea className="input min-h-24" name={name} defaultValue={value} /></label>; }
function C({ label, name, checked }: { label: string; name: string; checked: boolean }) { return <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name={name} defaultChecked={checked} /> {label}</label>; }

function TierRows({ tiers }: { tiers: any[] }) {
  const [rows, setRows] = useState(() => tiers.map((t, i) => ({ ...t, k: i })));
  return (
    <div className="space-y-2 sm:col-span-2">
      <div className="hidden grid-cols-[90px_1fr_1fr_1.4fr_40px] gap-2 text-xs font-medium text-ink-500 sm:grid"><span>Hours</span><span>Price (₦)</span><span>Evening price (₦)</span><span>Label shown</span><span /></div>
      {rows.map((t, i) => (
        <div key={t.k} className="grid grid-cols-2 gap-2 rounded-lg border border-ink-100 p-2 sm:grid-cols-[90px_1fr_1fr_1.4fr_40px] sm:border-0 sm:p-0">
          <input name="tierHours" type="number" min={1} max={23} className="input" defaultValue={t.hours} aria-label="Hours" required />
          <input name="tierPrice" className="input" inputMode="decimal" defaultValue={t.price} aria-label="Price" required />
          <input name="tierEveningPrice" className="input" inputMode="decimal" defaultValue={t.eveningPrice ?? ""} placeholder="Same as price" aria-label="Evening price" />
          <input name="tierLabel" className="input" defaultValue={t.label} aria-label="Label" />
          <button type="button" className="btn-ghost btn-sm" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove package">✕</button>
        </div>
      ))}
      <button type="button" className="btn-secondary btn-sm" onClick={() => setRows([...rows, { hours: "", price: "", eveningPrice: "", label: "", k: Date.now() }])}>Add package</button>
    </div>
  );
}

export function Settings() {
  const [sp] = useSearchParams();
  const { can } = useStaffMe();
  const tab = sp.get("tab") ?? "hotel";
  const q = useApi<any>("/staff/settings");
  const ro = !can("settings.manage");
  const Save = () => (ro ? <p className="text-sm text-ink-500">Read-only — you need the settings.manage permission to change settings.</p> : <SubmitButton>Save changes</SubmitButton>);
  const form = (section: string, children: ReactNode) => (
    <ActionForm key={section} action={`/staff/settings/${section}`} className="space-y-4" confirm="Save these settings? The change is recorded in the audit log.">
      <fieldset disabled={ro} className="grid gap-3 sm:grid-cols-2">{children}</fieldset>
      <Save />
    </ActionForm>
  );
  return (
    <Load q={q}>{({ settings: s, seasons, codes, types, integrations }) => {
      let body: ReactNode = null;
      if (tab === "hotel") body = form("hotel", <>
        <F label="Hotel name" name="name" value={s.hotel.name} /><F label="Tagline" name="tagline" value={s.hotel.tagline} />
        <F label="Address" name="address" value={s.hotel.address} wide /><F label="City" name="city" value={s.hotel.city} /><F label="State" name="state" value={s.hotel.state} />
        <F label="Country" name="country" value={s.hotel.country} /><F label="Phone" name="phone" value={s.hotel.phone} /><F label="Email" name="email" value={s.hotel.email} type="email" /><F label="Website" name="website" value={s.hotel.website} />
        <label className="sm:col-span-2"><span className="label">Logo (JPG/PNG/WEBP)</span>{s.hotel.logoPath && <img src={fileUrl(s.hotel.logoPath)!} alt="Logo" className="mb-2 h-14" />}<input type="file" name="logo" accept="image/jpeg,image/png,image/webp" className="text-sm" /></label>
        <p className="text-sm text-ink-600 sm:col-span-2">Currency: <strong>Nigerian Naira (NGN, ₦)</strong> · Timezone: <strong>{HOTEL_TZ}</strong> (all times are stored in UTC and shown in Lagos time).</p>
      </>);
      if (tab === "policies") body = form("policies", <>
        <F label="Check-in time" name="checkInTime" value={s.policies.checkInTime} type="time" /><F label="Check-out time" name="checkOutTime" value={s.policies.checkOutTime} type="time" />
        <F label="Free cancellation (hours before arrival)" name="freeCancellationHours" value={s.policies.freeCancellationHours} type="number" /><F label="Late cancellation fee (nights)" name="cancellationFeeNights" value={s.policies.cancellationFeeNights} type="number" />
        <F label="No-show fee (nights)" name="noShowFeeNights" value={s.policies.noShowFeeNights} type="number" /><F label="Guests may modify online until (hours before arrival)" name="guestModificationHours" value={s.policies.guestModificationHours} type="number" />
        <T label="Cancellation policy (shown to guests)" name="cancellationPolicy" value={s.policies.cancellationPolicy} />
        <T label="House rules" name="houseRules" value={s.policies.houseRules} /><T label="Children policy" name="childPolicy" value={s.policies.childPolicy} />
      </>);
      if (tab === "finance") body = form("finance", <>
        <F label="Tax label" name="taxLabel" value={s.finance.taxLabel} /><F label="Tax rate (%)" name="taxRate" value={s.finance.taxRate} />
        <F label="Service charge (%)" name="serviceChargeRate" value={s.finance.serviceChargeRate} /><F label="Deposit required (%)" name="depositPercent" value={s.finance.depositPercent} hint="Also the threshold that auto-confirms online bookings once paid." />
        <C label="Prices already include tax and service charge (VAT-inclusive). Untick to add tax on top of prices." name="taxInclusive" checked={s.finance.taxInclusive !== false} />
        <F label="Bank name" name="bankName" value={s.finance.bankName} /><F label="Account name" name="accountName" value={s.finance.accountName} /><F label="Account number" name="accountNumber" value={s.finance.accountNumber} />
        <T label="Payment instructions (shown to guests)" name="paymentInstructions" value={s.finance.paymentInstructions} />
        <fieldset className="sm:col-span-2"><legend className="label">Accepted payment methods</legend><div className="flex flex-wrap gap-4 text-sm">{[["CASH", "Cash"], ["BANK_TRANSFER", "Bank transfer"], ["POS", "POS / card at hotel"], ["CARD_ONLINE", "Card online (gateway)"]].map(([k, l]) => <label key={k} className="flex items-center gap-2"><input type="checkbox" name="acceptedMethods" value={k} defaultChecked={s.finance.acceptedMethods.includes(k)} />{l}</label>)}</div></fieldset>
        <p className="text-xs text-ink-500 sm:col-span-2">Changes apply to new bookings and re-priced stays. Existing bill lines are never rewritten.</p>
      </>);
      if (tab === "shortStay") body = (
        <div className="space-y-4">
          <Alert>Short stays are hourly packages for rooms marked “Offer short stays” (Rooms → Manage). Prices are final and include VAT. From the evening start time, the evening price applies where one is set.</Alert>
          {form("shortStay", <>
            <C label="Offer short stays" name="enabled" checked={s.shortStay.enabled} />
            <C label="Show short stays on the online booking form / QR code" name="onlineBooking" checked={s.shortStay.onlineBooking} />
            <F label="Evening rate starts at" name="eveningFrom" value={s.shortStay.eveningFrom} type="time" />
            <F label="Grace period before overtime (minutes)" name="graceMinutes" value={s.shortStay.graceMinutes} type="number" hint="After this, check-out moves the guest to the next package, or the overnight rate past the longest one." />
            <TierRows tiers={s.shortStay.tiers} />
            <p className="text-xs text-ink-500 sm:col-span-2">Current: {s.shortStay.tiers.map((t: any) => `${t.label} ${naira(t.price)}${t.eveningPrice ? ` (evening ${naira(t.eveningPrice)})` : ""}`).join(" · ")}</p>
          </>)}
        </div>
      );
      if (tab === "reservations") body = form("reservations", <>
        <F label="Unpaid online booking hold (hours)" name="holdHours" value={s.reservations.holdHours} type="number" /><F label="Book up to (days ahead)" name="maxAdvanceDays" value={s.reservations.maxAdvanceDays} type="number" />
        <F label="Maximum nights per booking" name="maxNights" value={s.reservations.maxNights} type="number" /><F label="Housekeeping task overdue after (hours)" name="housekeepingOverdueHours" value={s.reservations.housekeepingOverdueHours} type="number" />
        <F label="Booking reference prefix" name="bookingRefPrefix" value={s.reservations.bookingRefPrefix} hint="e.g. ASH → ASH-7KQ2M9" /><F label="Invoice number prefix" name="invoicePrefix" value={s.reservations.invoicePrefix} hint="e.g. INV → INV-2026-000123" />
        <F label="Receipt number prefix" name="receiptPrefix" value={s.reservations.receiptPrefix} />
        <C label="Rooms must pass inspection before check-in" name="requireInspectionBeforeCheckIn" checked={s.reservations.requireInspectionBeforeCheckIn} />
        <C label="Allow 'pay at hotel' for online bookings" name="allowPayAtHotel" checked={s.reservations.allowPayAtHotel} />
        <C label="Require deposit for online bookings" name="requireDepositForOnline" checked={s.reservations.requireDepositForOnline} />
      </>);
      const email = integrations.find((i: any) => i.name.startsWith("Email"))?.ok, sms = integrations.find((i: any) => i.name.startsWith("SMS"))?.ok;
      if (tab === "notifications") body = <>
        <div className="mb-4 space-y-2"><Alert tone={email ? "green" : "amber"}>Email delivery: {email ? "SMTP configured." : "not configured — set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM on the server. In-app notifications still work."}</Alert>
          <Alert tone={sms ? "green" : "amber"}>SMS delivery: {sms ? "Termii configured." : "not configured — set TERMII_API_KEY and TERMII_SENDER_ID on the server."}</Alert></div>
        {form("notifications", <>
          <C label="Send guest emails" name="emailEnabled" checked={s.notifications.emailEnabled} /><C label="Send guest SMS" name="smsEnabled" checked={s.notifications.smsEnabled} />
          <F label="Arrival reminder (hours before)" name="arrivalReminderHours" value={s.notifications.arrivalReminderHours} type="number" /><F label="Departure reminder (hours before)" name="departureReminderHours" value={s.notifications.departureReminderHours} type="number" />
        </>)}
      </>;
      if (tab === "security") body = form("security", <>
        <F label="Staff session length (hours)" name="staffSessionHours" value={s.security.staffSessionHours} type="number" /><F label="Guest session length (hours)" name="guestSessionHours" value={s.security.guestSessionHours} type="number" />
        <F label="Failed sign-ins before lockout" name="maxFailedLogins" value={s.security.maxFailedLogins} type="number" /><F label="Lockout duration (minutes)" name="lockoutMinutes" value={s.security.lockoutMinutes} type="number" />
        <F label="Minimum password length" name="passwordMinLength" value={s.security.passwordMinLength} type="number" />
        <p className="text-xs text-ink-500 sm:col-span-2">Staff permissions are managed under <Link className="link" to="/manage/roles">Roles &amp; permissions</Link>.</p>
      </>);
      if (tab === "integrations") body = (
        <div className="space-y-3 text-sm">
          <p className="text-ink-600">Credentials are read from server environment variables only and are never sent to the browser.</p>
          {integrations.map((i: any) => <div key={i.name} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-100 p-3"><div><p className="font-medium">{i.name}</p><p className="font-mono text-xs text-ink-500">{i.env}</p></div>{i.ok ? <StatusBadge status="VERIFIED" label="Configured" /> : <StatusBadge status="PENDING" label="Not configured" />}</div>)}
        </div>
      );
      if (tab === "pricing") {
        const canRates = can("rooms.rates");
        body = (
          <div className="space-y-6">
            <section>
              <h3 className="mb-2 font-semibold">Seasonal pricing (overnight rates)</h3>
              <ul className="mb-3 space-y-1 text-sm">{seasons.map((x: any) => <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-ink-100 px-3 py-2"><span><strong>{x.name}</strong> · {fmtDate(x.startDate)} – {fmtDate(x.endDate)} · {x.roomType?.name ?? "All rooms"} · {Number(x.adjustmentPercent) > 0 ? "+" : ""}{x.adjustmentPercent}% {!x.isActive && <Badge>inactive</Badge>}</span>{canRates && <ActionForm action="/staff/pricing/seasonal"><input type="hidden" name="toggleId" value={x.id} /><SubmitButton className="btn-ghost btn-sm" pendingText="…">{x.isActive ? "Deactivate" : "Activate"}</SubmitButton></ActionForm>}</li>)}{!seasons.length && <li className="text-ink-500">No seasonal rules.</li>}</ul>
              {canRates && <ActionForm action="/staff/pricing/seasonal" className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6" resetOnSuccess>
                <input name="name" className="input" placeholder="Name e.g. Festive" required /><select name="roomTypeId" className="input"><option value="">All room types</option>{types.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
                <input type="date" name="startDate" className="input" required /><input type="date" name="endDate" className="input" required /><input name="adjustmentPercent" className="input" placeholder="% e.g. 20 or -10" required />
                <SubmitButton className="btn-secondary">Add rule</SubmitButton></ActionForm>}
            </section>
            <section>
              <h3 className="mb-2 font-semibold">Discount codes</h3>
              <ul className="mb-3 space-y-1 text-sm">{codes.map((c: any) => <li key={c.id} className="rounded border border-ink-100 px-3 py-2"><span className="font-mono font-semibold">{c.code}</span> · {c.percent}% off rooms {c.validFrom && `· from ${fmtDate(c.validFrom)}`} {c.validTo && `to ${fmtDate(c.validTo)}`} · {c.isActive ? <Badge tone="green">active</Badge> : <Badge>inactive</Badge>} {c.description && <span className="text-ink-500">· {c.description}</span>}</li>)}{!codes.length && <li className="text-ink-500">No discount codes.</li>}</ul>
              {canRates && <ActionForm action="/staff/pricing/discount-codes" className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6" resetOnSuccess>
                <input name="code" className="input uppercase" placeholder="CODE" required /><input name="percent" className="input" placeholder="% off" required /><input name="description" className="input" placeholder="Description" />
                <input type="date" name="validFrom" className="input" /><input type="date" name="validTo" className="input" />
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isActive" defaultChecked /> Active <SubmitButton className="btn-secondary btn-sm">Save</SubmitButton></label>
              </ActionForm>}
              <p className="mt-2 text-xs text-ink-500">Saving an existing code updates it. For one-off deals, a manager can set a negotiated price on the booking itself.</p>
            </section>
          </div>
        );
      }
      return (
        <div className="space-y-4">
          <PageHeader title="System settings" />
          <div className="-mx-4 overflow-x-auto px-4"><div className="flex min-w-max gap-1 border-b border-ink-200">{TABS.map(([k, l]) => <Link key={k} to={`?tab=${k}`} className={`border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? "border-gold-500 text-ink-900" : "border-transparent text-ink-500"}`}>{l}</Link>)}</div></div>
          <Card>{body}</Card>
          {tab === "hotel" && <Card title="Hotel facilities (shown on the website)">{form("facilities", <>{[...s.facilities, "", "", ""].map((f: string, i: number) => <input key={i} name="facilities" className="input" defaultValue={f} />)}</>)}</Card>}
        </div>
      );
    }}</Load>
  );
}

// ───────────────────────── Notifications & profile ─────────────────────────

export function StaffNotifications() {
  const [sp] = useSearchParams();
  const p = Object.fromEntries(sp.entries());
  const q = useApi<any>(qs("/staff/notifications", p), { refetchInterval: 30_000 });
  return (
    <div className="space-y-4">
      <PageHeader title="Notifications" subtitle={q.data && `${q.data.unread} unread`} actions={<ActionForm action="/staff/notifications/read"><SubmitButton className="btn-secondary">Mark all as read</SubmitButton></ActionForm>} />
      <Load q={q}>{(d) => (
        <>
          <GetForm className="card flex flex-wrap items-end gap-3 p-3">
            <label><span className="label">Category</span><select name="category" className="input" defaultValue={p.category ?? ""}><option value="">All</option>{d.categories.map((c: string) => <option key={c}>{c}</option>)}</select></label>
            <label><span className="label">Priority</span><select name="priority" className="input" defaultValue={p.priority ?? ""}><option value="">All</option>{["LOW", "NORMAL", "HIGH", "URGENT"].map((c) => <option key={c}>{c}</option>)}</select></label>
            <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" name="unread" value="1" defaultChecked={!!p.unread} /> Unread only</label>
            <button className="btn-secondary">Filter</button>
          </GetForm>
          <Card padded={false}>
            {d.items.length === 0 ? <div className="p-4"><EmptyState title="No notifications" /></div> : (
              <ul className="divide-y divide-ink-100">{d.items.map((n: any) => (
                <li key={n.id} className={`flex items-start justify-between gap-3 px-4 py-3 ${n.readAt ? "" : "bg-gold-50/60"}`}>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{!n.readAt && <span className="mr-2 inline-block h-2 w-2 rounded-full bg-gold-500" />}{n.title}</p>
                    <p className="text-sm text-ink-600">{n.body}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-400">{fmtDateTime(n.createdAt)} <Badge>{n.category}</Badge>{n.priority !== "NORMAL" && <StatusBadge status={n.priority} />}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {n.link && <Link to={n.link} className="btn-secondary btn-sm">Open</Link>}
                    {!n.readAt && <ActionForm action="/staff/notifications/read"><input type="hidden" name="id" value={n.id} /><SubmitButton className="btn-ghost btn-sm" pendingText="…">Read</SubmitButton></ActionForm>}
                  </div>
                </li>
              ))}</ul>
            )}
          </Card>
          <Pagination page={d.page} pages={d.pages} makeHref={(n) => qs("/manage/notifications", { ...p, page: n })} />
        </>
      )}</Load>
    </div>
  );
}

export function StaffProfile() {
  const [sp] = useSearchParams();
  const { user } = useStaffMe();
  const q = useApi<any>("/staff/me/profile");
  return (
    <Load q={q}>{({ user: u, roles, permissionCount, logins, categories }) => {
      const muted: string[] = u.notificationPrefs?.muted ?? [];
      return (
        <div className="space-y-5">
          <PageHeader title="My profile" />
          {(sp.get("first") || u.mustChangePassword) && <Alert tone="amber">For security, please set a new password before continuing.</Alert>}
          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Account">
              <DL items={[["Name", user?.name], ["Email", u.email], ["Job title", u.jobTitle ?? "—"], ["Roles", roles.join(", ")], ["Permissions", `${permissionCount} granted`], ["Member since", fmtDateTime(u.createdAt)]]} />
            </Card>
            <Card title="Change password">
              <ActionForm action="/auth/staff/change-password" className="space-y-3" resetOnSuccess successRedirect={u.mustChangePassword ? "/manage" : undefined}>
                <label className="block"><span className="label">Current password</span><input className="input" type="password" name="current" required autoComplete="current-password" /></label>
                <label className="block"><span className="label">New password</span><input className="input" type="password" name="password" minLength={8} required autoComplete="new-password" /></label>
                <label className="block"><span className="label">Confirm new password</span><input className="input" type="password" name="confirm" required autoComplete="new-password" /></label>
                <SubmitButton>Change password</SubmitButton>
              </ActionForm>
            </Card>
            <Card title="Notification preferences">
              <ActionForm action="/staff/me/notification-prefs" className="space-y-3">
                <p className="text-sm text-ink-600">Tick categories to mute. Urgent alerts are always delivered.</p>
                <div className="grid grid-cols-2 gap-1 text-sm">{categories.map((c: string) => <label key={c} className="flex items-center gap-2"><input type="checkbox" name="muted" value={c} defaultChecked={muted.includes(c)} /> Mute {c}</label>)}</div>
                <SubmitButton className="btn-secondary">Save preferences</SubmitButton>
              </ActionForm>
            </Card>
            <Card title="Recent sign-ins">
              <ul className="space-y-1 text-sm">{logins.map((l: any) => <li key={l.id} className="flex justify-between gap-2"><span>{fmtDateTime(l.createdAt)} · {l.ipAddress ?? "unknown IP"}</span><span className={l.success ? "text-emerald-700" : "text-red-600"}>{l.success ? "Success" : l.reason}</span></li>)}</ul>
            </Card>
          </div>
        </div>
      );
    }}</Load>
  );
}
