import { Link, useParams, useSearchParams } from "react-router-dom";
import { useApi } from "@/lib/query";
import { useStaffMe } from "@/lib/auth";
import { fileUrl } from "@/lib/api";
import { OPERATIONAL_LABEL, STATUS_LABEL, fmtDate, fmtDateTime, fmtTime, label, stayWhen, todayLagos } from "@/lib/format";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { GetForm, qs } from "@/components/get-form";
import { Badge, Card, DL, EmptyState, Load, Money, PageHeader, Stat, StatusBadge, TableWrap } from "@/components/ui";
import { MessageThread } from "@/components/message-thread";

const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"];

function Tabs({ items, current, base }: { items: [string, string][]; current: string; base: (k: string) => string }) {
  return <div className="flex flex-wrap gap-1">{items.map(([k, l]) => <Link key={k} className={`btn-sm ${current === k ? "btn-primary" : "btn-secondary"}`} to={base(k)}>{l}</Link>)}</div>;
}

// ───────────────────────── Rooms ─────────────────────────

export function RoomsAdmin() {
  const { can } = useStaffMe();
  const q = useApi<any>("/staff/rooms", { refetchInterval: 60_000 });
  return (
    <Load q={q}>{({ board }) => (
      <div className="space-y-4">
        <PageHeader title="Rooms" subtitle={`${board.filter((b: any) => b.room.isActive).length} active of ${board.length}`} actions={<>
          {(can("rooms.rates") || can("rooms.manage")) && <Link to="/manage/rooms/types" className="btn-secondary">Room types & amenities</Link>}
          {can("rooms.manage") && <Link to="/manage/rooms/new" className="btn-gold">Add room</Link>}
        </>} />
        <Card padded={false}>
          <TableWrap><table className="table">
            <thead><tr><th>Room</th><th>Type</th><th>Status now</th><th>Housekeeping</th><th>Maintenance</th><th>Current / next guest</th><th className="text-right">Night rate</th><th>Short stays</th><th>Max</th><th /></tr></thead>
            <tbody>{board.map(({ room: r, status, inHouse, arriving, block }: any) => (
              <tr key={r.id} className={r.isActive ? "" : "opacity-60"}>
                <td className="font-display text-lg font-semibold">{r.number}{!r.isActive && <span className="ml-1 text-xs font-normal text-red-600">inactive</span>}</td>
                <td>{r.roomType.name}</td>
                <td><StatusBadge status={status} label={OPERATIONAL_LABEL[status]} /></td>
                <td><StatusBadge status={r.housekeepingStatus} /></td>
                <td><StatusBadge status={r.maintenanceState} />{block && <p className="text-xs text-ink-500">{block.reason}</p>}</td>
                <td className="text-xs">{inHouse ? `${inHouse.guest.firstName} ${inHouse.guest.lastName} → ${inHouse.stayType === "SHORT" ? fmtTime(inHouse.endAt) : fmtDate(inHouse.departureDate)}` : arriving ? `Arriving: ${arriving.guest.firstName} ${arriving.guest.lastName}` : "—"}</td>
                <td className="text-right"><Money value={r.nightlyRate} /></td>
                <td>{r.allowShortStay ? <Badge tone="blue">Yes</Badge> : <span className="text-xs text-ink-400">No</span>}</td>
                <td>{r.maxOccupancy}</td>
                <td className="text-right"><Link className="link" to={`/manage/rooms/${r.id}`}>Manage</Link></td>
              </tr>
            ))}</tbody>
          </table></TableWrap>
        </Card>
      </div>
    )}</Load>
  );
}

function RoomForm({ action, room, types, amenities, canRates, canManage }: { action: string; room?: any; types: any[]; amenities: any[]; canRates: boolean; canManage: boolean }) {
  const has = new Set(room?.amenities.map((a: any) => a.amenityId));
  const ro = !canManage;
  return (
    <ActionForm action={action} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" confirm={room ? "Save changes to this room?" : undefined}>
      <label><span className="label">Room number</span><input name="number" className="input" defaultValue={room?.number} required readOnly={ro} /></label>
      <label><span className="label">Room type</span><select name="roomTypeId" className="input" defaultValue={room?.roomTypeId ?? types[0]?.id} disabled={ro}>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>{ro && <input type="hidden" name="roomTypeId" value={room?.roomTypeId} />}</label>
      <label><span className="label">Floor</span><input name="floor" className="input" defaultValue={room?.floor ?? ""} readOnly={ro} /></label>
      <label><span className="label">Display name (optional)</span><input name="name" className="input" defaultValue={room?.name ?? ""} readOnly={ro} /></label>
      <label><span className="label">Nightly rate (₦, incl. VAT)</span><input name="nightlyRate" className="input" defaultValue={room?.nightlyRate ?? types[0]?.baseRate} readOnly={!canRates} required /></label>
      <label><span className="label">Max occupancy</span><input name="maxOccupancy" type="number" min={1} className="input" defaultValue={room?.maxOccupancy ?? types[0]?.maxOccupancy ?? 2} readOnly={ro} /></label>
      <label><span className="label">Bed configuration</span><input name="bedConfiguration" className="input" defaultValue={room?.bedConfiguration ?? ""} readOnly={ro} /></label>
      <label><span className="label">Display order</span><input name="sortOrder" type="number" className="input" defaultValue={room?.sortOrder ?? 0} readOnly={ro} /></label>
      <label className="flex items-center gap-2 text-sm sm:col-span-2 lg:col-span-4"><input type="checkbox" name="allowShortStay" defaultChecked={room?.allowShortStay ?? false} disabled={ro} /> Offer short stays (hourly packages) in this room</label>
      {ro && room?.allowShortStay && <input type="hidden" name="allowShortStay" value="on" />}
      <label className="sm:col-span-2 lg:col-span-4"><span className="label">Description</span><textarea name="description" className="input min-h-24" defaultValue={room?.description ?? ""} readOnly={ro} /></label>
      <fieldset className="sm:col-span-2 lg:col-span-4">
        <legend className="label">Amenities</legend>
        <div className="grid grid-cols-2 gap-1 text-sm sm:grid-cols-3 lg:grid-cols-5">{amenities.map((a) => <label key={a.id} className="flex items-center gap-2"><input type="checkbox" name="amenityIds" value={a.id} defaultChecked={has.has(a.id)} disabled={ro} />{a.name}</label>)}</div>
        {ro && room?.amenities.map((a: any) => <input key={a.amenityId} type="hidden" name="amenityIds" value={a.amenityId} />)}
      </fieldset>
      <div className="sm:col-span-2 lg:col-span-4"><SubmitButton className="btn-gold">{room ? "Save room" : "Create room"}</SubmitButton></div>
    </ActionForm>
  );
}

export function NewRoom() {
  const { can } = useStaffMe();
  const meta = useApi<any>("/staff/rooms/meta");
  return (
    <div className="space-y-4">
      <PageHeader title="Add room" back={{ href: "/manage/rooms", label: "Rooms" }} subtitle="New rooms start as 'dirty' and must be cleaned and inspected before the first check-in." />
      <Load q={meta}>{(m) => <Card><RoomForm action="/staff/rooms" types={m.types.filter((t: any) => t.isActive)} amenities={m.amenities} canRates={can("rooms.rates")} canManage /></Card>}</Load>
    </div>
  );
}

export function RoomDetail() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const { can } = useStaffMe();
  const tab = sp.get("tab") ?? "reservations";
  const q = useApi<any>(`/staff/rooms/${id}`);
  const meta = useApi<any>(can("rooms.manage") || can("rooms.rates") ? "/staff/rooms/meta" : null);
  const tabs: [string, string][] = [["reservations", "Reservations"], ["housekeeping", "Housekeeping"], ["maintenance", "Maintenance"], ["blocks", "Blocks"]];
  return (
    <Load q={q}>{({ room, status }) => {
      const activeBlocks = room.blocks.filter((b: any) => !b.releasedAt);
      return (
        <div className="space-y-5">
          <PageHeader back={{ href: "/manage/rooms", label: "Rooms" }} title={`Room ${room.number}`} subtitle={`${room.roomType.name}${room.floor ? ` · Floor ${room.floor}` : ""}${room.allowShortStay ? " · short stays offered" : ""}`}
            actions={<><StatusBadge status={status} label={OPERATIONAL_LABEL[status]} /><StatusBadge status={room.housekeepingStatus} label={`HK: ${room.housekeepingStatus.toLowerCase()}`} />{!room.isActive && <StatusBadge status="CANCELLED" label="Inactive" />}</>} />
          {meta.data && <Card title="Room details"><RoomForm action={`/staff/rooms/${room.id}`} room={room} types={meta.data.types} amenities={meta.data.amenities} canRates={can("rooms.rates")} canManage={can("rooms.manage")} /></Card>}
          <div className="grid gap-5 lg:grid-cols-2">
            <Card title={`Photographs (${room.images.length})`}>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{room.images.map((img: any, i: number) => (
                <div key={img.id} className="overflow-hidden rounded-lg border border-ink-100">
                  <img src={fileUrl(img.path)!} alt={img.caption ?? ""} className="h-24 w-full object-cover" />
                  {can("rooms.manage") && <div className="flex justify-between p-1 text-xs">
                    {i === 0 ? <span className="px-1 text-gold-700">Cover</span> : <ActionForm action={`/staff/room-images/${img.id}`}><input type="hidden" name="op" value="cover" /><SubmitButton className="btn-ghost btn-sm" pendingText="…">Make cover</SubmitButton></ActionForm>}
                    <ActionForm action={`/staff/room-images/${img.id}`} confirm="Remove this photo?"><input type="hidden" name="op" value="delete" /><SubmitButton className="btn-ghost btn-sm text-red-600" pendingText="…">Remove</SubmitButton></ActionForm>
                  </div>}
                </div>
              ))}</div>
              {can("rooms.manage") && (
                <ActionForm action={`/staff/rooms/${room.id}/images`} className="mt-3 flex flex-wrap items-center gap-2" resetOnSuccess>
                  <input type="file" name="images" accept="image/jpeg,image/png,image/webp" multiple className="text-sm" required />
                  <input name="caption" className="input w-40" placeholder="Caption" />
                  <SubmitButton className="btn-secondary btn-sm">Upload</SubmitButton>
                </ActionForm>
              )}
            </Card>
            <div className="space-y-5">
              {can("rooms.block") && (
                <Card title="Block room (maintenance / out of order)">
                  <ActionForm action={`/staff/rooms/${room.id}/block`} className="grid gap-2 sm:grid-cols-2" confirm="Block this room? It will not be bookable for these dates.">
                    <select name="type" className="input"><option value="MAINTENANCE">Maintenance</option><option value="OUT_OF_ORDER">Out of order</option></select>
                    <input name="reason" className="input" placeholder="Reason" required />
                    <label><span className="label">From</span><input type="date" name="startDate" className="input" defaultValue={todayLagos()} required /></label>
                    <label><span className="label">Until (exclusive, optional)</span><input type="date" name="endDate" className="input" /></label>
                    <div className="sm:col-span-2"><SubmitButton className="btn-secondary btn-sm">Block room</SubmitButton></div>
                  </ActionForm>
                </Card>
              )}
              {activeBlocks.length > 0 && (
                <Card title="Active blocks">
                  <ul className="space-y-2 text-sm">{activeBlocks.map((b: any) => (
                    <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-ink-100 p-2">
                      <span><StatusBadge status={b.type} /> {b.reason} · {fmtDate(b.startDate)} → {b.endDate ? fmtDate(b.endDate) : "open"}{b.ticket && <> · <Link className="link" to={`/manage/maintenance/${b.ticket.id}`}>{b.ticket.reference}</Link></>}</span>
                      {can("rooms.return_to_service") && <ActionForm action={`/staff/blocks/${b.id}/release`} requireReason confirm="Return this room to service? It will need cleaning and inspection before the next check-in."><SubmitButton className="btn-primary btn-sm">Return to service</SubmitButton></ActionForm>}
                    </li>
                  ))}</ul>
                </Card>
              )}
              {can("rooms.manage") && (
                <Card title={room.isActive ? "Deactivate room" : "Reactivate room"}>
                  <ActionForm action={`/staff/rooms/${room.id}/active`} requireReason confirm={room.isActive ? "Deactivate this room? It will no longer appear for booking." : "Reactivate this room?"}>
                    <input type="hidden" name="active" value={room.isActive ? "" : "on"} />
                    <p className="mb-2 text-sm text-ink-600">{room.isActive ? "Removes the room from sale. Rooms are never deleted so their history is kept." : "Puts the room back on sale."}</p>
                    <SubmitButton className={room.isActive ? "btn-danger btn-sm" : "btn-primary btn-sm"}>{room.isActive ? "Deactivate" : "Reactivate"}</SubmitButton>
                  </ActionForm>
                </Card>
              )}
            </div>
          </div>
          <Card padded={false} title={<div className="flex gap-1">{tabs.map(([k, l]) => <Link key={k} to={`?tab=${k}`} className={`rounded-md px-3 py-1 text-sm ${tab === k ? "bg-ink-900 text-white" : "text-ink-600 hover:bg-ink-100"}`}>{l}</Link>)}</div>}>
            <TableWrap>
              {tab === "reservations" && <table className="table"><thead><tr><th>Ref</th><th>Guest</th><th>When</th><th>Status</th></tr></thead><tbody>{room.reservations.map((r: any) => <tr key={r.id}><td><Link className="link font-mono" to={`/manage/reservations/${r.id}`}>{r.reference}</Link></td><td>{r.guest.firstName} {r.guest.lastName}</td><td>{stayWhen(r)}</td><td><StatusBadge status={r.status} label={STATUS_LABEL[r.status]} /></td></tr>)}</tbody></table>}
              {tab === "housekeeping" && <table className="table"><thead><tr><th>Task</th><th>Type</th><th>Status</th><th>Assigned</th><th>Created</th><th>Completed</th></tr></thead><tbody>
                {room.housekeepingTasks.map((t: any) => <tr key={t.id}><td className="font-mono">{t.reference}</td><td className="text-xs">{label(t.type)}</td><td><StatusBadge status={t.status} /></td><td>{t.assignedToName ?? "—"}</td><td className="text-xs">{fmtDateTime(t.createdAt)}</td><td className="text-xs">{t.completedAt ? fmtDateTime(t.completedAt) : "—"}</td></tr>)}
                {room.inspections.map((i: any) => <tr key={i.id} className="bg-ink-50/50"><td colSpan={2} className="text-xs">Inspection by {i.inspectorName}</td><td><StatusBadge status={i.passed ? "VERIFIED" : "FAILED"} label={i.passed ? "Passed" : "Failed"} /></td><td colSpan={2} className="text-xs">{i.notes}</td><td className="text-xs">{fmtDateTime(i.createdAt)}</td></tr>)}
              </tbody></table>}
              {tab === "maintenance" && <table className="table"><thead><tr><th>Ticket</th><th>Category</th><th>Priority</th><th>Status</th><th>Reported</th></tr></thead><tbody>{room.maintenance.map((t: any) => <tr key={t.id}><td><Link className="link font-mono" to={`/manage/maintenance/${t.id}`}>{t.reference}</Link></td><td>{t.category}</td><td><StatusBadge status={t.priority} /></td><td><StatusBadge status={t.status} /></td><td className="text-xs">{fmtDateTime(t.createdAt)} · {t.reportedByName}</td></tr>)}</tbody></table>}
              {tab === "blocks" && <table className="table"><thead><tr><th>Type</th><th>Reason</th><th>From</th><th>To</th><th>Released</th></tr></thead><tbody>{room.blocks.map((b: any) => <tr key={b.id}><td><StatusBadge status={b.type} /></td><td>{b.reason}</td><td>{fmtDate(b.startDate)}</td><td>{b.endDate ? fmtDate(b.endDate) : "open"}</td><td className="text-xs">{b.releasedAt ? fmtDateTime(b.releasedAt) : "Active"}</td></tr>)}</tbody></table>}
            </TableWrap>
          </Card>
        </div>
      );
    }}</Load>
  );
}

export function RoomTypes() {
  const { can } = useStaffMe();
  const q = useApi<any>("/staff/rooms/meta");
  return (
    <Load q={q}>{({ types, amenities }) => (
      <div className="space-y-5">
        <PageHeader title="Room types & amenities" back={{ href: "/manage/rooms", label: "Rooms" }} subtitle="Room types are categories. Each room keeps its own nightly rate; a type's base rate is the default for new rooms. Short-stay prices are set in Settings." />
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-4">
            {types.map((t: any) => (
              <Card key={t.id} title={<>{t.name} <span className="text-xs font-normal text-ink-500">· {t._count.rooms} room(s) · base <Money value={t.baseRate} /></span></>}>
                {can("rooms.rates") ? (
                  <ActionForm action="/staff/room-types" className="grid gap-2 sm:grid-cols-2">
                    <input type="hidden" name="id" value={t.id} />
                    <input name="name" className="input" defaultValue={t.name} required />
                    <input name="baseRate" className="input" defaultValue={t.baseRate} required />
                    <input name="maxOccupancy" type="number" min={1} className="input" defaultValue={t.maxOccupancy} />
                    <input name="bedConfiguration" className="input" defaultValue={t.bedConfiguration ?? ""} placeholder="Beds" />
                    <textarea name="description" className="input sm:col-span-2" defaultValue={t.description ?? ""} />
                    <div><SubmitButton className="btn-secondary btn-sm">Save</SubmitButton></div>
                  </ActionForm>
                ) : <p className="text-sm text-ink-600">{t.description}</p>}
              </Card>
            ))}
            {can("rooms.rates") && (
              <Card title="Add room type">
                <ActionForm action="/staff/room-types" className="grid gap-2 sm:grid-cols-2" resetOnSuccess>
                  <input name="name" className="input" placeholder="Name" required />
                  <input name="baseRate" className="input" placeholder="Base rate ₦" required />
                  <input name="maxOccupancy" type="number" min={1} defaultValue={2} className="input" />
                  <input name="bedConfiguration" className="input" placeholder="Beds" />
                  <textarea name="description" className="input sm:col-span-2" placeholder="Description" />
                  <div><SubmitButton className="btn-gold btn-sm">Add type</SubmitButton></div>
                </ActionForm>
              </Card>
            )}
          </div>
          <Card title="Amenities">
            <ul className="mb-4 grid grid-cols-2 gap-1 text-sm">{amenities.map((a: any) => <li key={a.id}>{a.name} <span className="text-xs text-ink-400">({a._count.rooms})</span></li>)}</ul>
            {can("rooms.manage") && <ActionForm action="/staff/amenities" className="flex gap-2" resetOnSuccess><input name="name" className="input" placeholder="New amenity" required /><SubmitButton className="btn-secondary">Add</SubmitButton></ActionForm>}
          </Card>
        </div>
      </div>
    )}</Load>
  );
}

// ───────────────────────── Housekeeping ─────────────────────────

export function Housekeeping() {
  const [sp] = useSearchParams();
  const { can } = useStaffMe();
  const q = useApi<any>(qs("/staff/housekeeping", { show: sp.get("show") }), { refetchInterval: 30_000 });
  const manage = can("housekeeping.manage");
  return (
    <Load q={q}>{({ tasks, rooms, team, done, mineOnly, me }) => {
      const overdue = (t: any) => t.dueAt && new Date(t.dueAt) < new Date() && ["PENDING", "IN_PROGRESS"].includes(t.status);
      return (
        <div className="space-y-5">
          <PageHeader title="Housekeeping" subtitle={mineOnly ? "Your assigned rooms" : "All rooms and open tasks"} actions={can("housekeeping.view") && <div className="flex gap-1">
            <Link className={`btn-sm ${!mineOnly ? "btn-primary" : "btn-secondary"}`} to="/manage/housekeeping">All tasks</Link>
            <Link className={`btn-sm ${mineOnly ? "btn-primary" : "btn-secondary"}`} to="/manage/housekeeping?show=mine">My tasks</Link>
            {can("housekeeping.inspect") && <Link className="btn-gold btn-sm" to="/manage/housekeeping/inspections">Inspections</Link>}
          </div>} />
          {rooms.length > 0 && (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-10">{rooms.map((r: any) => (
              <div key={r.id} className="card p-2 text-center"><p className="font-display text-lg font-semibold">{r.number}</p><StatusBadge status={r.housekeepingStatus} />{r.reservations.length > 0 && <p className="mt-1 text-[10px] text-violet-700">occupied</p>}</div>
            ))}</div>
          )}
          <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
            <div className="space-y-3">
              {tasks.length === 0 && <EmptyState title="No open housekeeping tasks" body={mineOnly ? "Nothing is assigned to you right now." : undefined} />}
              {tasks.map((t: any) => {
                const canAct = manage || (can("housekeeping.work") && t.assignedToId === me);
                return (
                  <div key={t.id} className={`card p-4 ${overdue(t) ? "border-red-300" : ""}`}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-display text-xl font-semibold">Room {t.room.number} <span className="font-sans text-sm font-normal text-ink-500">· {label(t.type)}</span></p>
                        <p className="text-xs text-ink-500">{t.reference} · created {fmtDateTime(t.createdAt)}{t.dueAt && ` · due ${fmtTime(t.dueAt)}`}{overdue(t) && <span className="ml-1 font-semibold text-red-600">OVERDUE</span>}</p>
                        {t.notes && <p className="mt-1 text-sm text-ink-700">{t.notes}</p>}
                      </div>
                      <div className="flex items-center gap-2">{t.priority !== "NORMAL" && <StatusBadge status={t.priority} />}<StatusBadge status={t.status} /></div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-end gap-2">
                      <span className="text-sm text-ink-600">Assigned: <strong>{t.assignedToName ?? "unassigned"}</strong></span>
                      {manage && (
                        <ActionForm action={`/staff/housekeeping/tasks/${t.id}/assign`} className="flex gap-1">
                          <select name="assignedToId" className="input py-1 text-xs" defaultValue={t.assignedToId ?? ""} required><option value="" disabled>Assign to…</option>{team.map((u: any) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>)}</select>
                          <SubmitButton className="btn-secondary btn-sm" pendingText="…">Assign</SubmitButton>
                        </ActionForm>
                      )}
                    </div>
                    {canAct && (
                      <div className="mt-3">
                        {["PENDING", "FAILED_INSPECTION"].includes(t.status) && <ActionForm action={`/staff/housekeeping/tasks/${t.id}/start`}><SubmitButton className="btn-primary w-full sm:w-auto">Start cleaning</SubmitButton></ActionForm>}
                        {t.status === "IN_PROGRESS" && (
                          <ActionForm action={`/staff/housekeeping/tasks/${t.id}/complete`} className="grid gap-2 sm:grid-cols-3">
                            <input name="notes" className="input" placeholder="Notes (optional)" />
                            <input name="damageReport" className="input" placeholder="Damaged items (if any)" />
                            <input name="missingItems" className="input" placeholder="Missing items (if any)" />
                            <div className="sm:col-span-3"><SubmitButton className="btn-gold w-full sm:w-auto">Mark clean</SubmitButton></div>
                          </ActionForm>
                        )}
                        {t.status === "COMPLETED" && <p className="text-sm text-gold-700">Cleaned {t.completedAt && fmtTime(t.completedAt)} — awaiting supervisor inspection.</p>}
                      </div>
                    )}
                  </div>
                );
              })}
              {done.length > 0 && <Card title="Completed in the last 24 hours"><ul className="space-y-1 text-sm">{done.map((t: any) => <li key={t.id}>Room {t.room.number} · {label(t.type)} · {t.assignedToName ?? "—"} <StatusBadge status={t.status} /></li>)}</ul></Card>}
            </div>
            {manage && (
              <Card title="New task">
                <ActionForm action="/staff/housekeeping/tasks" className="space-y-3" resetOnSuccess>
                  <label className="block"><span className="label">Room</span><select name="roomId" className="input" required>{rooms.map((r: any) => <option key={r.id} value={r.id}>Room {r.number} ({r.housekeepingStatus.toLowerCase()})</option>)}</select></label>
                  <label className="block"><span className="label">Type</span><select name="type" className="input"><option value="STAYOVER_CLEAN">Stay-over clean</option><option value="CHECKOUT_CLEAN">Check-out clean</option><option value="DEEP_CLEAN">Deep clean</option><option value="GUEST_REQUEST">Guest request</option><option value="RECLEAN">Re-clean</option></select></label>
                  <label className="block"><span className="label">Priority</span><select name="priority" className="input" defaultValue="NORMAL">{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></label>
                  <label className="block"><span className="label">Assign to</span><select name="assignedToId" className="input"><option value="">Unassigned</option>{team.map((u: any) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>)}</select></label>
                  <label className="block"><span className="label">Notes</span><input name="notes" className="input" /></label>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="markDirty" /> Mark room dirty now</label>
                  <SubmitButton className="btn-gold w-full">Create task</SubmitButton>
                </ActionForm>
              </Card>
            )}
          </div>
        </div>
      );
    }}</Load>
  );
}

const CHECKS = [["bed", "Bed made, linen fresh"], ["bathroom", "Bathroom clean & stocked"], ["floor", "Floors & surfaces clean"], ["towels", "Towels replaced"], ["amenities", "Amenities replenished"], ["ac", "AC working"], ["lights", "Lights & sockets working"]] as const;

export function Inspections() {
  const q = useApi<any>("/staff/inspections", { refetchInterval: 30_000 });
  return (
    <Load q={q}>{({ rooms, recent }) => (
      <div className="space-y-5">
        <PageHeader title="Room inspections" subtitle="Only inspected rooms can receive a new check-in." back={{ href: "/manage/housekeeping", label: "Housekeeping" }} />
        {rooms.length === 0 && <EmptyState title="No rooms awaiting inspection" body="Rooms appear here once housekeeping marks them clean." />}
        <div className="grid gap-4 md:grid-cols-2">{rooms.map((r: any) => (
          <Card key={r.id} title={<>Room {r.number} <StatusBadge status={r.housekeepingStatus} /></>}>
            {r.housekeepingTasks[0] && <p className="mb-2 text-xs text-ink-500">Cleaned by {r.housekeepingTasks[0].assignedToName ?? "—"} at {fmtDateTime(r.housekeepingTasks[0].completedAt)}{r.housekeepingTasks[0].damageReport && ` · Damage: ${r.housekeepingTasks[0].damageReport}`}</p>}
            <ActionForm action="/staff/inspections" className="space-y-2">
              <input type="hidden" name="roomId" value={r.id} />
              <input type="hidden" name="taskId" value={r.housekeepingTasks[0]?.id ?? ""} />
              <div className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">{CHECKS.map(([k, l]) => <label key={k} className="flex items-center gap-2"><input type="checkbox" name={`chk_${k}`} defaultChecked />{l}</label>)}</div>
              <input name="notes" className="input" placeholder="Notes (required if failing)" />
              <div className="flex gap-2">
                <button name="result" value="pass" className="btn-primary flex-1">Pass — ready for guests</button>
                <button name="result" value="fail" className="btn-danger flex-1">Fail — re-clean</button>
              </div>
            </ActionForm>
          </Card>
        ))}</div>
        <Card title="Recent inspections">
          <ul className="space-y-1 text-sm">{recent.map((i: any) => <li key={i.id} className="flex flex-wrap justify-between gap-2"><span>Room {i.room.number} · {i.inspectorName} · {fmtDateTime(i.createdAt)}{i.notes && ` · ${i.notes}`}</span><StatusBadge status={i.passed ? "VERIFIED" : "FAILED"} label={i.passed ? "Passed" : "Failed"} /></li>)}</ul>
        </Card>
      </div>
    )}</Load>
  );
}

// ───────────────────────── Maintenance ─────────────────────────

export function Maintenance() {
  const [sp] = useSearchParams();
  const { can } = useStaffMe();
  const closed = sp.get("status") === "closed";
  const q = useApi<any>(qs("/staff/maintenance", { status: closed ? "closed" : null }));
  return (
    <Load q={q}>{({ tickets, rooms, techs, counts, categories, scope }) => (
      <div className="space-y-5">
        <PageHeader title="Maintenance" subtitle={scope === "mine" ? "Tickets assigned to you" : scope === "all" ? "All maintenance tickets" : "Issues you reported"}
          actions={<Tabs current={closed ? "closed" : ""} items={[["", "Open"], ["closed", "Resolved / closed"]]} base={(k) => qs("/manage/maintenance", { status: k })} />} />
        {scope === "all" && <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">{["OPEN", "ASSIGNED", "IN_PROGRESS", "AWAITING_PARTS", "RESOLVED"].map((s) => <Stat key={s} label={label(s)} value={counts[s] ?? 0} />)}</div>}
        <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
          <Card padded={false}>
            {tickets.length === 0 ? <div className="p-4"><EmptyState title="No tickets" /></div> : (
              <TableWrap><table className="table">
                <thead><tr><th>Ticket</th><th>Room</th><th>Issue</th><th>Priority</th><th>Status</th><th>Assigned</th><th>Reported</th></tr></thead>
                <tbody>{tickets.map((t: any) => (
                  <tr key={t.id}>
                    <td><Link className="link font-mono" to={`/manage/maintenance/${t.id}`}>{t.reference}</Link></td>
                    <td>{t.room?.number ?? "General"}{t.blocks.length > 0 && <p className="text-[10px] font-semibold text-red-600">ROOM BLOCKED</p>}</td>
                    <td><p className="font-medium">{t.category}</p><p className="line-clamp-1 text-xs text-ink-500">{t.description}</p></td>
                    <td><StatusBadge status={t.priority} /></td><td><StatusBadge status={t.status} /></td>
                    <td className="text-xs">{t.assignedToName ?? "—"}</td><td className="text-xs">{fmtDateTime(t.createdAt)}<br />{t.reportedByName}</td>
                  </tr>
                ))}</tbody>
              </table></TableWrap>
            )}
          </Card>
          {can("maintenance.report") && (
            <Card title="Report an issue">
              <ActionForm action="/staff/maintenance" className="space-y-3" resetOnSuccess>
                <label className="block"><span className="label">Room</span><select name="roomId" className="input"><option value="">General / common area</option>{rooms.map((r: any) => <option key={r.id} value={r.id}>Room {r.number}</option>)}</select></label>
                <label className="block"><span className="label">Category</span><select name="category" className="input">{categories.map((m: string) => <option key={m}>{m}</option>)}</select></label>
                <label className="block"><span className="label">Description</span><textarea name="description" className="input min-h-20" required autoFocus={sp.get("new") === "1"} /></label>
                <label className="block"><span className="label">Priority</span><select name="priority" className="input" defaultValue="NORMAL">{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></label>
                {can("rooms.block") && <label className="block"><span className="label">Block the room?</span><select name="block" className="input"><option value="">No — room can still be sold</option><option value="MAINTENANCE">Maintenance (temporarily unsellable)</option><option value="OUT_OF_ORDER">Out of order</option></select></label>}
                {techs.length > 0 && <label className="block"><span className="label">Assign technician</span><select name="assignedToId" className="input"><option value="">Unassigned</option>{techs.map((u: any) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>)}</select></label>}
                <SubmitButton className="btn-gold w-full">Create ticket</SubmitButton>
              </ActionForm>
            </Card>
          )}
        </div>
      </div>
    )}</Load>
  );
}

export function Ticket() {
  const { id } = useParams();
  const { can, user } = useStaffMe();
  const q = useApi<any>(`/staff/maintenance/${id}`);
  return (
    <Load q={q}>{({ ticket: t, techs }) => {
      const manage = can("maintenance.manage");
      const canWork = manage || (can("maintenance.work") && t.assignedToId === user?.id);
      const activeBlock = t.blocks.find((b: any) => !b.releasedAt);
      return (
        <div className="space-y-5">
          <PageHeader back={{ href: "/manage/maintenance", label: "Maintenance" }} title={<span className="font-mono">{t.reference}</span>} subtitle={`${t.category}${t.room ? ` · Room ${t.room.number}` : ""}`} actions={<><StatusBadge status={t.priority} /><StatusBadge status={t.status} /></>} />
          <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
            <div className="space-y-5">
              <Card title="Issue">
                <p className="whitespace-pre-wrap text-sm">{t.description}</p>
                <div className="mt-4"><DL cols={3} items={[["Room", t.room ? <Link key="r" className="link" to={`/manage/rooms/${t.room.id}`}>{t.room.number}</Link> : "General"], ["Reported by", t.reportedByName], ["Reported", fmtDateTime(t.createdAt)], ["Assigned to", t.assignedToName], ["Resolved", t.resolvedAt ? fmtDateTime(t.resolvedAt) : null], ["Closed", t.closedAt ? fmtDateTime(t.closedAt) : null], ["Resolution", t.resolution]]} /></div>
              </Card>
              {activeBlock && (
                <Card title="Room block">
                  <p className="text-sm"><StatusBadge status={activeBlock.type} /> since {fmtDate(activeBlock.startDate)} — {activeBlock.reason}</p>
                  {can("rooms.return_to_service") && ["RESOLVED", "CLOSED"].includes(t.status) && <ActionForm action={`/staff/blocks/${activeBlock.id}/release`} className="mt-3" requireReason confirm="Return this room to service? Housekeeping will clean and inspect it first."><SubmitButton className="btn-primary btn-sm">Return room to service</SubmitButton></ActionForm>}
                  {!["RESOLVED", "CLOSED"].includes(t.status) && <p className="mt-2 text-xs text-ink-500">The room can be returned to service once this ticket is resolved.</p>}
                </Card>
              )}
              <Card title="Activity">
                <ol className="space-y-3 text-sm">{t.updates.map((u: any) => <li key={u.id} className="border-l-2 border-gold-300 pl-3"><p>{u.body}</p><p className="text-xs text-ink-500">{u.authorName} · {fmtDateTime(u.createdAt)}{u.status && <> · <StatusBadge status={u.status} /></>}</p></li>)}{!t.updates.length && <li className="text-ink-500">No updates yet.</li>}</ol>
              </Card>
            </div>
            {canWork && t.status !== "CLOSED" && (
              <Card title="Update ticket">
                <ActionForm action={`/staff/maintenance/${t.id}`} className="space-y-3" resetOnSuccess>
                  <label className="block"><span className="label">Status</span><select name="status" className="input" defaultValue=""><option value="">No change</option><option value="IN_PROGRESS">In progress</option><option value="AWAITING_PARTS">Awaiting parts</option><option value="RESOLVED">Resolved</option>{manage && <option value="CLOSED">Closed</option>}{manage && <option value="OPEN">Re-open</option>}</select></label>
                  {manage && <label className="block"><span className="label">Assign technician</span><select name="assignedToId" className="input" defaultValue=""><option value="">No change</option>{techs.map((u: any) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>)}</select></label>}
                  {manage && <label className="block"><span className="label">Priority</span><select name="priority" className="input" defaultValue=""><option value="">No change</option>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></label>}
                  <label className="block"><span className="label">Note</span><textarea name="note" className="input" /></label>
                  <label className="block"><span className="label">Resolution (when resolving)</span><textarea name="resolution" className="input" defaultValue={t.resolution ?? ""} /></label>
                  <SubmitButton>Save update</SubmitButton>
                </ActionForm>
              </Card>
            )}
          </div>
        </div>
      );
    }}</Load>
  );
}

// ───────────────────────── Service requests, messages, reviews ─────────────────────────

export function ServiceRequests() {
  const [sp] = useSearchParams();
  const { can } = useStaffMe();
  const closed = sp.get("status") === "closed";
  const q = useApi<any>(qs("/staff/service-requests", { status: sp.get("status"), q: sp.get("q") }), { refetchInterval: 30_000 });
  return (
    <div className="space-y-4">
      <PageHeader title="Guest service requests" actions={<Tabs current={closed ? "closed" : ""} items={[["", "Open"], ["closed", "Closed"]]} base={(k) => qs("/manage/service-requests", { status: k })} />} />
      <GetForm keep={["status"]} className="flex gap-2"><input name="q" defaultValue={sp.get("q") ?? ""} className="input max-w-xs" placeholder="Reference, room, category" /><button className="btn-secondary">Search</button></GetForm>
      <Load q={q}>{({ requests, team }) => requests.length === 0 ? <EmptyState title="No requests" /> : (
        <div className="grid gap-3 md:grid-cols-2">{requests.map((r: any) => (
          <Card key={r.id}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-semibold">{r.category}{r.room && <span className="text-ink-500"> · Room {r.room.number}</span>}</p>
                <p className="text-xs text-ink-500">{r.reference} · {r.guest.firstName} {r.guest.lastName} · {fmtDateTime(r.createdAt)}{r.reservation && <> · <Link className="link" to={`/manage/reservations/${r.reservation.id}`}>{r.reservation.reference}</Link></>}</p>
              </div>
              <div className="flex gap-1">{r.priority !== "NORMAL" && <StatusBadge status={r.priority} />}<StatusBadge status={r.status} /></div>
            </div>
            <p className="mt-2 text-sm">{r.description}</p>
            {r.assignedToName && <p className="mt-1 text-xs text-ink-500">Assigned to {r.assignedToName}</p>}
            {r.completionNotes && <p className="mt-1 rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-800">{r.completionNotes}</p>}
            {can("services.manage") && !["COMPLETED", "CANCELLED"].includes(r.status) && (
              <ActionForm action={`/staff/service-requests/${r.id}`} className="mt-3 grid grid-cols-2 gap-2" resetOnSuccess>
                <select name="assignedToId" className="input py-1 text-xs" defaultValue=""><option value="">{r.assignedToName ? "Keep assignee" : "Assign to…"}</option>{team.map((u: any) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName}{u.jobTitle ? ` (${u.jobTitle})` : ""}</option>)}</select>
                <select name="status" className="input py-1 text-xs" defaultValue=""><option value="">Status: no change</option><option value="IN_PROGRESS">In progress</option><option value="COMPLETED">Completed</option><option value="CANCELLED">Cancel</option></select>
                <input name="completionNotes" className="input col-span-2 py-1 text-xs" placeholder="Notes to guest (required to complete)" />
                <div className="col-span-2"><SubmitButton className="btn-secondary btn-sm">Update</SubmitButton></div>
              </ActionForm>
            )}
          </Card>
        ))}</div>
      )}</Load>
    </div>
  );
}

export function StaffMessages() {
  const [sp] = useSearchParams();
  const f = sp.get("filter") ?? "";
  const q = useApi<any>(qs("/staff/conversations", { filter: f }), { refetchInterval: 15_000 });
  return (
    <div className="space-y-4">
      <PageHeader title="Messaging centre" actions={<Tabs current={f} items={[["", "Open"], ["mine", "Assigned to me"], ["unassigned", "Unassigned"], ["closed", "Closed"]]} base={(k) => qs("/manage/messages", { filter: k })} />} />
      <Card padded={false}>
        <Load q={q}>{({ conversations }) => conversations.length === 0 ? <div className="p-4"><EmptyState title="No conversations" /></div> : (
          <ul className="divide-y divide-ink-100">{conversations.map((c: any) => (
            <li key={c.id}><Link to={`/manage/messages/${c.id}`} className={`block px-4 py-3 hover:bg-ink-50 ${c._count.messages ? "bg-gold-50/50" : ""}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{c.guest.firstName} {c.guest.lastName} · <span className="font-normal">{c.subject}</span></p>
                <span className="flex items-center gap-2">{c._count.messages > 0 && <Badge tone="gold">{c._count.messages} unread</Badge>}<Badge>{c.channel === "CONCIERGE" ? "Concierge" : "Front desk"}</Badge></span>
              </div>
              <p className="mt-0.5 line-clamp-1 text-sm text-ink-500">{c.messages[0]?.fromGuest ? "" : "You: "}{c.messages[0]?.body}</p>
              <p className="text-xs text-ink-400">{fmtDateTime(c.lastMessageAt)} · {c.assignedToName ? `Assigned to ${c.assignedToName}` : "Unassigned"}</p>
            </Link></li>
          ))}</ul>
        )}</Load>
      </Card>
    </div>
  );
}

export function StaffThread() {
  const { id } = useParams();
  const { can } = useStaffMe();
  const q = useApi<any>(`/staff/conversations/${id}`, { refetchInterval: 10_000 });
  return (
    <Load q={q}>{({ conversation: c, team }) => (
      <div className="space-y-4">
        <PageHeader back={{ href: "/manage/messages", label: "Messages" }} title={c.subject} subtitle={<>{c.guest.firstName} {c.guest.lastName} · {c.channel === "CONCIERGE" ? "Concierge" : "Front desk"} · {c.isClosed ? "Closed" : "Open"}</>} />
        <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
          <div className="space-y-4">
            <Card><MessageThread messages={c.messages} viewer="staff" /></Card>
            {can("messages.reply") && (
              <Card>
                <ActionForm action={`/staff/conversations/${c.id}/messages`} className="space-y-2" resetOnSuccess>
                  <textarea name="body" className="input min-h-20" placeholder="Reply to guest…" maxLength={2000} />
                  <div className="flex flex-wrap items-center justify-between gap-2"><input type="file" name="attachment" accept="image/jpeg,image/png,image/webp" className="text-sm" /><SubmitButton pendingText="Sending…">Send reply</SubmitButton></div>
                </ActionForm>
              </Card>
            )}
          </div>
          <div className="space-y-4">
            <Card title="Guest">
              <p className="text-sm"><Link className="link" to={`/manage/guests/${c.guestId}`}>{c.guest.firstName} {c.guest.lastName}</Link></p>
              <p className="text-xs text-ink-500">{c.guest.phone} · {c.guest.email}</p>
              <ul className="mt-2 space-y-1 text-xs">{c.guest.reservations.map((r: any) => <li key={r.id}><Link className="link" to={`/manage/reservations/${r.id}`}>{r.reference}</Link> · Room {r.room.number} · {stayWhen(r)}</li>)}</ul>
            </Card>
            {can("messages.reply") && (
              <Card title="Assignment">
                <p className="mb-2 text-sm">Assigned to: <strong>{c.assignedToName ?? "nobody"}</strong></p>
                <ActionForm action={`/staff/conversations/${c.id}/manage`} className="flex gap-2"><input type="hidden" name="op" value="assign" /><select name="assignedToId" className="input" required defaultValue=""><option value="" disabled>Choose…</option>{team.map((u: any) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>)}</select><SubmitButton className="btn-secondary btn-sm">Assign</SubmitButton></ActionForm>
                <ActionForm action={`/staff/conversations/${c.id}/manage`} className="mt-3"><input type="hidden" name="op" value={c.isClosed ? "reopen" : "close"} /><SubmitButton className="btn-ghost btn-sm">{c.isClosed ? "Re-open conversation" : "Close conversation"}</SubmitButton></ActionForm>
              </Card>
            )}
          </div>
        </div>
      </div>
    )}</Load>
  );
}

export function StaffReviews() {
  const [sp] = useSearchParams();
  const { can } = useStaffMe();
  const kind = sp.get("kind") ?? "";
  const q = useApi<any>(qs("/staff/reviews", { kind }));
  return (
    <div className="space-y-4">
      <PageHeader title="Reviews & feedback" actions={<Tabs current={kind} items={[["", "All"], ["REVIEW", "Reviews"], ["COMPLAINT", "Complaints"], ["SUGGESTION", "Suggestions"]]} base={(k) => qs("/manage/reviews", { kind: k })} />} />
      <Load q={q}>{({ items, average, count, unanswered }) => (
        <>
          <div className="grid grid-cols-3 gap-3"><Stat label="Average rating" value={average ? `${Number(average).toFixed(1)} ★` : "—"} /><Stat label="Verified reviews" value={count} /><Stat label="Unanswered complaints" value={unanswered} tone={unanswered ? "warn" : undefined} /></div>
          {items.length === 0 ? <EmptyState title="No feedback yet" /> : items.map((r: any) => (
            <Card key={r.id}>
              <div className="flex flex-wrap items-center gap-2"><Badge tone={r.kind === "COMPLAINT" ? "red" : r.kind === "REVIEW" ? "gold" : "blue"}>{r.kind.toLowerCase()}</Badge>{r.rating && <span className="text-gold-500">{"★".repeat(r.rating)}</span>}{r.isVerifiedStay && <Badge tone="green">Verified stay</Badge>}{r.isPublished && <Badge tone="dark">Published</Badge>}
                <span className="text-xs text-ink-500"><Link className="link" to={`/manage/guests/${r.guestId}`}>{r.guest.firstName} {r.guest.lastName}</Link> · {fmtDateTime(r.createdAt)}{r.reservation && ` · ${r.reservation.reference}`}</span></div>
              {r.title && <p className="mt-2 font-semibold">{r.title}</p>}
              <p className="mt-1 text-sm">{r.body}</p>
              {r.serviceRatings && <p className="mt-1 text-xs text-ink-500">{Object.entries(r.serviceRatings as Record<string, number>).map(([k, v]) => `${k}: ${v}★`).join(" · ")}</p>}
              {can("reviews.manage") ? (
                <ActionForm action={`/staff/reviews/${r.id}`} className="mt-3 flex flex-wrap gap-2">
                  <input name="response" className="input min-w-0 flex-1" defaultValue={r.staffResponse ?? ""} placeholder="Response to guest" />
                  {r.isVerifiedStay && <select name="publish" className="input w-auto" defaultValue={r.isPublished ? "yes" : "no"}><option value="no">Not published</option><option value="yes">Publish on website</option></select>}
                  <SubmitButton className="btn-secondary btn-sm">Save</SubmitButton>
                </ActionForm>
              ) : r.staffResponse && <p className="mt-2 rounded bg-ink-50 p-2 text-sm">Response: {r.staffResponse}</p>}
            </Card>
          ))}
        </>
      )}</Load>
    </div>
  );
}
