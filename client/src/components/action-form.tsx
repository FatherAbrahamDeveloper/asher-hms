import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { send, type ActionResult } from "@/lib/api";
import { toast } from "./toaster";

/**
 * Standard form for every write action: posts the form to the API, shows the result (inline + toast), refreshes
 * all on-screen data, follows server redirects, and can ask for confirmation and a written reason first.
 */
export function ActionForm({
  action, children, className, confirm, requireReason, reasonLabel = "Reason", resetOnSuccess = false, onSuccess, successRedirect, id,
}: {
  action: string; children: ReactNode; className?: string; confirm?: string; requireReason?: boolean; reasonLabel?: string;
  resetOnSuccess?: boolean; onSuccess?: (r: ActionResult) => void; successRedirect?: string; id?: string; encType?: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const submitter = useRef<HTMLElement | null>(null);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<ActionResult | null>(null);
  const [pending, setPending] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const needsDialog = !!(confirm || requireReason);

  async function run() {
    const form = formRef.current!;
    const fd = new FormData(form);
    const sub = submitter.current as HTMLButtonElement | null;
    if (sub?.name) fd.set(sub.name, sub.value);
    if (requireReason) fd.set("reason", reason);
    setPending(true);
    const r = await send(action, fd);
    setPending(false);
    setState(r);
    if (r.message) toast(r.ok, r.message);
    if (r.ok) {
      if (resetOnSuccess) form.reset();
      setReason("");
      await qc.invalidateQueries();
      onSuccess?.(r);
      const to = successRedirect ?? r.data?.redirect;
      if (to) { if (/^https?:\/\//.test(to)) window.location.href = to; else navigate(to); }
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    submitter.current = (e.nativeEvent as SubmitEvent).submitter ?? null;
    if (needsDialog) dialogRef.current?.showModal();
    else run();
  }

  return (
    <>
      <form ref={formRef} id={id} onSubmit={onSubmit} className={className} aria-busy={pending} data-pending={pending || undefined}>
        <fieldset disabled={pending} className="contents">{children}</fieldset>
        {state?.message && <p role="status" className={`mt-3 rounded-md px-3 py-2 text-sm ${state.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>{state.message}</p>}
        {state && !state.ok && state.fieldErrors && Object.keys(state.fieldErrors).length > 1 && (
          <ul className="mt-2 list-disc pl-5 text-xs text-red-700">{Object.entries(state.fieldErrors).map(([k, v]) => <li key={k}>{v}</li>)}</ul>
        )}
      </form>
      {needsDialog && (
        <dialog ref={dialogRef} className="m-auto w-[min(92vw,28rem)] rounded-xl p-0 shadow-2xl backdrop:bg-ink-950/50">
          <div className="p-5">
            <h3 className="font-semibold text-ink-900">Please confirm</h3>
            {confirm && <p className="mt-2 text-sm text-ink-600">{confirm}</p>}
            {requireReason && (
              <label className="mt-4 block"><span className="label">{reasonLabel} (required)</span>
                <textarea className="input min-h-20" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
              </label>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-ink-100 bg-ink-50 px-5 py-3">
            <button type="button" className="btn-secondary" onClick={() => dialogRef.current?.close()}>Cancel</button>
            <button type="button" className="btn-primary" disabled={requireReason && reason.trim().length < 3} onClick={() => { dialogRef.current?.close(); run(); }}>Confirm</button>
          </div>
        </dialog>
      )}
    </>
  );
}

/** Submit button that shows a spinner while its form is submitting. */
export function SubmitButton({ children, className = "btn-primary", pendingText = "Saving…", name, value, disabled }: { children: ReactNode; className?: string; pendingText?: string; name?: string; value?: string; disabled?: boolean }) {
  return (
    <button type="submit" className={`${className} group`} name={name} value={value} disabled={disabled}>
      <span className="hidden h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent group-disabled:inline-block" />
      <span className="group-disabled:hidden">{children}</span>
      <span className="hidden group-disabled:inline">{pendingText}</span>
    </button>
  );
}
