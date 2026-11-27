import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useGuestMe } from "@/lib/auth";
import { send } from "@/lib/api";
import { AuthCard } from "@/components/auth-card";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert } from "@/components/ui";

function safeNext(n: string | null) {
  return n && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/manage") ? n : "/account";
}

export function Login() {
  const [sp] = useSearchParams();
  const { user } = useGuestMe();
  const navigate = useNavigate();
  const next = safeNext(sp.get("next"));
  if (user) return <Navigate to={next} replace />;
  return (
    <AuthCard title="Welcome back" subtitle="Sign in to manage your bookings and stay." footer={<>New here? <Link className="link" to={`/register${sp.get("next") ? `?next=${encodeURIComponent(sp.get("next")!)}` : ""}`}>Create an account</Link></>}>
      {sp.get("reset") && <div className="mb-4"><Alert tone="green">Your password was reset. Sign in with your new password.</Alert></div>}
      <ActionForm action="/auth/guest/login" className="space-y-4" onSuccess={() => navigate(next)}>
        <label className="block"><span className="label">Email</span><input className="input" type="email" name="email" autoComplete="email" required /></label>
        <label className="block"><span className="label">Password</span><input className="input" type="password" name="password" autoComplete="current-password" required /></label>
        <SubmitButton className="btn-primary w-full" pendingText="Signing in…">Sign in</SubmitButton>
        <p className="text-center text-sm"><Link className="link" to="/forgot-password">Forgot your password?</Link></p>
      </ActionForm>
    </AuthCard>
  );
}

export function Register() {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  return (
    <AuthCard title="Create your account" subtitle="Book rooms, pay securely and manage your stay." footer={<>Already registered? <Link className="link" to={`/login${sp.get("next") ? `?next=${encodeURIComponent(sp.get("next")!)}` : ""}`}>Sign in</Link></>}>
      <ActionForm action="/auth/guest/register" className="space-y-4" onSuccess={() => navigate(safeNext(sp.get("next")))}>
        <div className="grid grid-cols-2 gap-3">
          <label><span className="label">First name</span><input className="input" name="firstName" autoComplete="given-name" required /></label>
          <label><span className="label">Last name</span><input className="input" name="lastName" autoComplete="family-name" required /></label>
        </div>
        <label className="block"><span className="label">Email</span><input className="input" type="email" name="email" autoComplete="email" required /></label>
        <label className="block"><span className="label">Phone</span><input className="input" type="tel" name="phone" autoComplete="tel" placeholder="+234…" required /></label>
        <label className="block"><span className="label">Password</span><input className="input" type="password" name="password" autoComplete="new-password" minLength={8} required /><span className="mt-1 block text-xs text-ink-500">At least 8 characters with letters and numbers.</span></label>
        <label className="block"><span className="label">Confirm password</span><input className="input" type="password" name="confirm" autoComplete="new-password" required /></label>
        <SubmitButton className="btn-gold w-full" pendingText="Creating account…">Create account</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}

export function Forgot() {
  return (
    <AuthCard title="Reset your password" subtitle="We'll email you a secure link." footer={<Link className="link" to="/login">Back to sign in</Link>}>
      <ActionForm action="/auth/guest/forgot-password" className="space-y-4" resetOnSuccess>
        <label className="block"><span className="label">Email</span><input className="input" type="email" name="email" required /></label>
        <SubmitButton className="btn-primary w-full">Send reset link</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}

export function Reset() {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  return (
    <AuthCard title="Choose a new password">
      <ActionForm action="/auth/reset-password" className="space-y-4" onSuccess={(r) => navigate(r.data?.portal === "STAFF" ? "/manage/login" : "/login?reset=1")}>
        <input type="hidden" name="token" value={sp.get("token") ?? ""} />
        <label className="block"><span className="label">New password</span><input className="input" type="password" name="password" minLength={8} required /></label>
        <label className="block"><span className="label">Confirm password</span><input className="input" type="password" name="confirm" required /></label>
        <SubmitButton className="btn-primary w-full">Update password</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}

export function Verify() {
  const [sp] = useSearchParams();
  const [r, setR] = useState<{ ok: boolean; message?: string } | null>(null);
  useEffect(() => { send("/auth/guest/verify-email", { token: sp.get("token") ?? "" }).then(setR); }, [sp]);
  return (
    <AuthCard title="Email verification">
      {!r ? <p className="text-sm text-ink-500">Verifying…</p> : r.ok ? <Alert tone="green">{r.message}</Alert> : <Alert tone="red">{r.message}</Alert>}
      <Link to="/account" className="btn-primary mt-4 w-full">Go to my account</Link>
    </AuthCard>
  );
}
