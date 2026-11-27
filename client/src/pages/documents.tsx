import type { ReactNode } from "react";
import { useParams } from "react-router-dom";
import { useApi } from "@/lib/query";
import { fileUrl } from "@/lib/api";
import { METHOD_LABEL, fmtDate, fmtDateTime, num } from "@/lib/format";
import { Load, Money } from "@/components/ui";
import { PrintButton } from "@/components/print-button";
import { Logo } from "@/components/logo";

function Shell({ hotel, title, number, children }: { hotel: any; title: string; number: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-ink-100 py-6 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-3xl justify-end gap-2 px-4"><PrintButton /></div>
      <article className="print-area mx-auto max-w-3xl bg-white p-8 shadow-lg sm:p-10">
        <header className="flex items-start justify-between gap-4 border-b-2 border-gold-500 pb-5">
          <div className="flex items-center gap-3">
            <Logo className="h-16" alt={hotel.name} />
            <div><p className="font-display text-2xl font-semibold">{hotel.name}</p><p className="text-xs text-ink-500">{[hotel.address, hotel.city, hotel.state, hotel.country].filter(Boolean).join(", ")}</p><p className="text-xs text-ink-500">{[hotel.phone, hotel.email].filter(Boolean).join(" · ")}</p></div>
          </div>
          <div className="text-right"><p className="text-xl font-semibold uppercase tracking-wider text-ink-800">{title}</p><p className="font-mono text-sm">{number}</p></div>
        </header>
        {children}
        <footer className="mt-10 border-t border-ink-100 pt-3 text-center text-xs text-ink-400">Thank you for choosing {hotel.name}. Amounts in Nigerian Naira (₦).</footer>
      </article>
    </div>
  );
}

export function InvoiceDoc() {
  const { id } = useParams();
  const q = useApi<any>(`/documents/invoice/${id}`);
  return (
    <Load q={q}>{({ invoice: inv, hotel, finance }) => {
      const r = inv.reservation;
      return (
        <Shell hotel={hotel} title={inv.isFinal ? "Final invoice" : "Invoice"} number={inv.number}>
          <section className="mt-6 grid grid-cols-2 gap-6 text-sm">
            <div><p className="text-xs uppercase text-ink-500">Billed to</p><p className="font-semibold">{r.guest.firstName} {r.guest.lastName}</p><p>{r.guest.email}</p><p>{r.guest.phone}</p><p>{r.guest.address}</p></div>
            <div className="text-right"><p><span className="text-ink-500">Issued:</span> {fmtDateTime(inv.issuedAt)}</p><p><span className="text-ink-500">Booking:</span> {r.reference}</p><p><span className="text-ink-500">Room:</span> {r.room.number}</p><p><span className="text-ink-500">Stay:</span> {r.stayType === "SHORT" ? `${fmtDateTime(r.startAt)} (${r.shortStayHours}h)` : `${fmtDate(r.arrivalDate)} – ${fmtDate(r.departureDate)}`}</p></div>
          </section>
          <table className="mt-6 w-full text-sm">
            <thead><tr className="border-b border-ink-200 text-left text-xs uppercase text-ink-500"><th className="py-2">Date</th><th>Description</th><th className="text-right">Amount</th></tr></thead>
            <tbody>{inv.items.map((i: any) => <tr key={i.id} className="border-b border-ink-50"><td className="whitespace-nowrap py-1.5">{fmtDate(i.serviceDate)}</td><td>{i.description}</td><td className="text-right"><Money value={i.amount} /></td></tr>)}</tbody>
          </table>
          <dl className="ml-auto mt-4 max-w-xs space-y-1 text-sm">
            <div className="flex justify-between"><dt>Subtotal (before {finance.taxLabel})</dt><dd><Money value={inv.subtotal} /></dd></div>
            <div className="flex justify-between"><dt>{finance.taxLabel} ({finance.taxRate}%)</dt><dd><Money value={inv.tax} /></dd></div>
            {num(inv.serviceCharge) !== 0 && <div className="flex justify-between"><dt>Service charge</dt><dd><Money value={inv.serviceCharge} /></dd></div>}
            <div className="flex justify-between border-t border-ink-200 pt-1 font-semibold"><dt>Total</dt><dd><Money value={inv.total} /></dd></div>
            <div className="flex justify-between"><dt>Paid</dt><dd><Money value={inv.paid} /></dd></div>
            <div className="flex justify-between text-base font-bold"><dt>Balance</dt><dd><Money value={inv.balance} /></dd></div>
          </dl>
          {finance.taxInclusive && <p className="mt-2 text-right text-xs text-ink-500">Prices include {finance.taxLabel}.</p>}
          {num(inv.balance) > 0 && finance.bankName && <p className="mt-6 rounded bg-ink-50 p-3 text-xs">Pay to {finance.bankName} · {finance.accountName} · {finance.accountNumber}. Use {r.reference} as narration.</p>}
          <p className="mt-6 text-xs text-ink-400">Issued by {inv.issuedByName ?? "system"}.</p>
        </Shell>
      );
    }}</Load>
  );
}

export function ReceiptDoc() {
  const { id } = useParams();
  const q = useApi<any>(`/documents/receipt/${id}`);
  return (
    <Load q={q}>{({ payment: p, hotel }) => (
      <Shell hotel={hotel} title="Payment receipt" number={p.receipt.number}>
        <div className="mt-8 grid gap-3 text-sm sm:grid-cols-2">
          <p><span className="text-ink-500">Received from:</span> <strong>{p.payerName ?? `${p.guest.firstName} ${p.guest.lastName}`}</strong></p>
          <p><span className="text-ink-500">Date:</span> {fmtDateTime(p.verifiedAt ?? p.receivedAt)}</p>
          <p><span className="text-ink-500">Booking:</span> {p.reservation?.reference ?? "—"}{p.reservation && ` (Room ${p.reservation.room.number})`}</p>
          <p><span className="text-ink-500">Method:</span> {METHOD_LABEL[p.method]}{p.externalRef && ` · Ref ${p.externalRef}`}</p>
          <p><span className="text-ink-500">Payment ref:</span> <span className="font-mono">{p.reference}</span></p>
          <p><span className="text-ink-500">Type:</span> {p.isDeposit ? "Deposit" : "Payment"}</p>
        </div>
        <div className="mt-8 rounded-lg bg-ink-50 p-6 text-center"><p className="text-xs uppercase tracking-wide text-ink-500">Amount received</p><p className="mt-1 text-3xl font-bold"><Money value={p.amount} /></p></div>
        <p className="mt-6 text-xs text-ink-400">Recorded by {p.recordedByName ?? "—"} · Verified by {p.verifiedByName ?? "—"}</p>
      </Shell>
    )}</Load>
  );
}
