import type { FormEvent, ReactNode } from "react";
import { useSearchParams } from "react-router-dom";

/** A filter/search form that writes its fields into the URL query string (like a plain GET form). */
export function GetForm({ children, className, keep = [] }: { children: ReactNode; className?: string; keep?: string[] }) {
  const [sp, setSp] = useSearchParams();
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const next = new URLSearchParams();
    for (const k of keep) { const v = sp.get(k); if (v) next.set(k, v); }
    for (const [k, v] of new FormData(e.currentTarget).entries()) if (typeof v === "string" && v.trim()) next.set(k, v.trim());
    setSp(next);
  }
  return <form onSubmit={onSubmit} className={className}>{children}</form>;
}

/** Build "path?query" from an object, skipping empty values. */
export function qs(path: string, params: Record<string, string | number | null | undefined>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `${path}?${s}` : path;
}
