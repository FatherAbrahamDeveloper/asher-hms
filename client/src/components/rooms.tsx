import { Link } from "react-router-dom";
import { fileUrl } from "@/lib/api";
import { fmtDate, naira, num } from "@/lib/format";
import { Money } from "./ui";

export function RoomImage({ path, alt, className = "h-48" }: { path?: string | null; alt: string; className?: string }) {
  return path ? <img src={fileUrl(path)!} alt={alt} className={`w-full object-cover ${className}`} loading="lazy" /> : (
    <div className={`grid w-full place-items-center bg-gradient-to-br from-ink-800 via-ink-700 to-gold-700 ${className}`}><span className="font-display text-3xl font-semibold text-white/80">{alt}</span></div>
  );
}

export function RoomCard({ room, query, quote }: { room: any; query?: string; quote?: any }) {
  const title = room.name || `${room.roomType.name} ${room.number}`;
  return (
    <article className="card flex flex-col overflow-hidden">
      <RoomImage path={room.images[0]?.path} alt={`Room ${room.number}`} />
      <div className="flex flex-1 flex-col p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-gold-600">{room.roomType.name}{room.allowShortStay && <span className="ml-2 rounded bg-gold-50 px-1.5 py-0.5 normal-case text-gold-700">short stays available</span>}</p>
        <h3 className="mt-1 font-display text-xl font-semibold">{title}</h3>
        <p className="mt-1 text-sm text-ink-500">{room.bedConfiguration ?? "—"} · Up to {room.maxOccupancy} guest{room.maxOccupancy > 1 ? "s" : ""}</p>
        <p className="mt-2 line-clamp-2 text-sm text-ink-600">{room.description || room.roomType.description}</p>
        <div className="mt-3 flex flex-wrap gap-1">{room.amenities.slice(0, 4).map((a: any) => <span key={a.amenity.name} className="rounded bg-ink-50 px-2 py-0.5 text-xs text-ink-600">{a.amenity.name}</span>)}</div>
        <div className="mt-auto flex items-end justify-between gap-2 pt-4">
          <div>
            <p className="text-lg font-semibold"><Money value={room.nightlyRate} /><span className="text-xs font-normal text-ink-500"> / night</span></p>
            {quote && <p className="text-xs text-ink-500">{quote.label}: <span className="font-semibold text-ink-800">{naira(quote.total)}</span></p>}
          </div>
          <Link to={`/rooms/${room.id}${query ? `?${query}` : ""}`} className="btn-primary btn-sm">{quote ? "View & book" : "View room"}</Link>
        </div>
      </div>
    </article>
  );
}

export function QuoteTable({ quote, showNights = true }: { quote: any; showNights?: boolean }) {
  const negotiated = num(quote.rate) !== num(quote.standardRate);
  return (
    <div className="rounded-lg border border-ink-100 text-sm">
      {showNights && quote.stayType === "NIGHT" && (
        <ul className="max-h-48 divide-y divide-ink-50 overflow-auto">
          {quote.nights.map((n: any) => <li key={n.date} className="flex justify-between px-3 py-1.5 text-ink-600"><span>{fmtDate(n.date)}{n.seasonal && <span className="ml-1 text-xs text-gold-600">({n.seasonal})</span>}</span><Money value={n.gross} /></li>)}
        </ul>
      )}
      <dl className="space-y-1 border-t border-ink-100 bg-ink-50/60 px-3 py-2">
        <div className="flex justify-between"><dt>{quote.stayType === "SHORT" ? `Short stay — ${quote.label}` : `Room (${quote.label})`}</dt><dd><Money value={quote.listTotal} /></dd></div>
        {negotiated && <div className="flex justify-between text-xs text-ink-500"><dt>Standard price</dt><dd className="line-through"><Money value={num(quote.standardRate) * (quote.nightCount || 1)} /></dd></div>}
        {quote.discount && <div className="flex justify-between text-emerald-700"><dt>Discount ({quote.discountPercent}%)</dt><dd>−<Money value={quote.discount.gross} /></dd></div>}
        <div className="flex justify-between border-t border-ink-200 pt-1 text-base font-semibold"><dt>Total</dt><dd><Money value={quote.total} /></dd></div>
        <div className="flex justify-between text-xs text-ink-500"><dt>{quote.taxInclusive ? `Includes ${quote.taxLabel} (${quote.taxRate}%)` : `${quote.taxLabel} (${quote.taxRate}%)`}</dt><dd><Money value={quote.tax} /></dd></div>
      </dl>
    </div>
  );
}
