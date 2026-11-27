import { Link } from "react-router-dom";
import clsx from "clsx";
import type { ReactNode } from "react";
import { naira } from "@/lib/format";
type MoneyInput = unknown;

export function cn(...c: (string | false | null | undefined)[]) {
  return clsx(c);
}

export function Card({ children, className, title, actions, padded = true }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode; padded?: boolean }) {
  return (
    <section className={cn("card", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
          {title && <h2 className="text-sm font-semibold text-ink-800">{title}</h2>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn(padded && "p-4")}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {back && <Link to={back.href} className="mb-1 inline-block text-xs font-medium text-ink-500 hover:text-ink-800">← {back.label}</Link>}
        <h1 className="font-display text-2xl font-semibold text-ink-900 sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

const TONES = {
  gray: "bg-ink-100 text-ink-700 ring-ink-200",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  blue: "bg-sky-50 text-sky-700 ring-sky-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  red: "bg-red-50 text-red-700 ring-red-200",
  purple: "bg-violet-50 text-violet-700 ring-violet-200",
  gold: "bg-gold-50 text-gold-700 ring-gold-200",
  dark: "bg-ink-800 text-white ring-ink-800",
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ children, tone = "gray", className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return <span className={cn("inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", TONES[tone], className)}>{children}</span>;
}

const STATUS_TONES: Record<string, Tone> = {
  PENDING: "amber", CONFIRMED: "blue", CHECKED_IN: "green", CHECKED_OUT: "gray", CANCELLED: "red", NO_SHOW: "red",
  VERIFIED: "green", FAILED: "red", REJECTED: "red", REQUESTED: "amber", APPROVED: "blue", PROCESSED: "green",
  AVAILABLE: "green", RESERVED: "blue", OCCUPIED: "purple", DIRTY: "red", CLEANING: "amber", CLEAN: "gold", INSPECTED: "green",
  MAINTENANCE: "amber", OUT_OF_ORDER: "dark", OK: "green",
  OPEN: "amber", ASSIGNED: "blue", IN_PROGRESS: "purple", AWAITING_PARTS: "amber", RESOLVED: "green", CLOSED: "gray", COMPLETED: "green",
  FAILED_INSPECTION: "red", PAID: "green", PARTIAL: "amber", UNPAID: "red", NONE: "gray",
  LOW: "gray", NORMAL: "blue", HIGH: "amber", URGENT: "red", SUCCESS: "green", FAILURE: "red", DENIED: "red",
  QUEUED: "amber", SENT: "green", SKIPPED: "gray",
};
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Badge tone={STATUS_TONES[status] ?? "gray"}>{label ?? status.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</Badge>;
}

export function Money({ value, className }: { value: MoneyInput; className?: string }) {
  return <span className={cn("tabular-nums", className)}>{naira(value)}</span>;
}

export function Stat({ label, value, hint, href, tone }: { label: string; value: ReactNode; hint?: ReactNode; href?: string; tone?: "warn" | "good" | "bad" }) {
  const body = (
    <div className={cn("card h-full p-4 transition", href && "hover:border-gold-300 hover:shadow")}>
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", tone === "warn" ? "text-amber-600" : tone === "bad" ? "text-red-600" : tone === "good" ? "text-emerald-600" : "text-ink-900")}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
  return href ? <Link to={href}>{body}</Link> : body;
}

export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-ink-200 bg-white px-6 py-10 text-center">
      <p className="font-medium text-ink-700">{title}</p>
      {body && <p className="mt-1 max-w-md text-sm text-ink-500">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Field({ label, children, hint, className }: { label: string; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <label className={cn("block", className)}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-500">{hint}</span>}
    </label>
  );
}

export function DL({ items, cols = 2 }: { items: [ReactNode, ReactNode][]; cols?: 1 | 2 | 3 }) {
  return (
    <dl className={cn("grid gap-x-6 gap-y-3 text-sm", cols === 2 && "sm:grid-cols-2", cols === 3 && "sm:grid-cols-3")}>
      {items.map(([k, v], i) => (
        <div key={i} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{k}</dt>
          <dd className="mt-0.5 break-words text-ink-900">{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="-mx-4 overflow-x-auto sm:mx-0"><div className="inline-block min-w-full align-middle">{children}</div></div>;
}

export function Alert({ tone = "blue", children }: { tone?: "blue" | "amber" | "red" | "green"; children: ReactNode }) {
  const c = { blue: "border-sky-200 bg-sky-50 text-sky-900", amber: "border-amber-200 bg-amber-50 text-amber-900", red: "border-red-200 bg-red-50 text-red-900", green: "border-emerald-200 bg-emerald-50 text-emerald-900" }[tone];
  return <div className={cn("rounded-lg border px-4 py-3 text-sm", c)}>{children}</div>;
}

export function Pagination({ page, pages, makeHref }: { page: number; pages: number; makeHref: (p: number) => string }) {
  if (pages <= 1) return null;
  return (
    <div className="mt-4 flex items-center justify-between text-sm">
      <span className="text-ink-500">Page {page} of {pages}</span>
      <div className="flex gap-2">
        {page > 1 && <Link className="btn-secondary btn-sm" to={makeHref(page - 1)}>Previous</Link>}
        {page < pages && <Link className="btn-secondary btn-sm" to={makeHref(page + 1)}>Next</Link>}
      </div>
    </div>
  );
}

/** Loading / error wrapper for a query result. */
export function Load<T>({ q, children }: { q: { data?: T; isLoading: boolean; error: unknown; refetch?: () => void }; children: (data: T) => ReactNode }) {
  if (q.isLoading) return <div className="flex items-center gap-3 py-16 text-sm text-ink-500"><span className="h-4 w-4 animate-spin rounded-full border-2 border-gold-500 border-t-transparent" />Loading…</div>;
  if (q.error) return <div className="py-10"><Alert tone="red">{(q.error as Error).message || "Something went wrong."} {q.refetch && <button className="link ml-2" onClick={() => q.refetch!()}>Try again</button>}</Alert></div>;
  if (q.data === undefined) return null;
  return <>{children(q.data)}</>;
}
