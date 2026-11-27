import { useEffect, useState } from "react";

type Toast = { id: number; ok: boolean; message: string };

/** Shows action results even when the form that triggered them disappears after a refresh. */
export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ ok: boolean; message: string }>).detail;
      const t = { id: Date.now() + Math.random(), ...d };
      setItems((x) => [...x.slice(-2), t]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== t.id)), 6000);
    };
    window.addEventListener("app:toast", on);
    return () => window.removeEventListener("app:toast", on);
  }, []);
  return (
    <div className="no-print pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
      {items.map((t) => (
        <div key={t.id} data-toast={t.ok ? "ok" : "error"} role="alert" className={`pointer-events-auto max-w-md rounded-lg px-4 py-3 text-sm font-medium shadow-lg ${t.ok ? "bg-ink-900 text-white" : "bg-red-600 text-white"}`}>{t.message}</div>
      ))}
    </div>
  );
}

export function toast(ok: boolean, message: string) {
  window.dispatchEvent(new CustomEvent("app:toast", { detail: { ok, message } }));
}
