import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useApi } from "@/lib/query";
import { useStaffMe } from "@/lib/auth";
import { AuthCard } from "@/components/auth-card";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert } from "@/components/ui";

export function StaffLogin() {
  const { user } = useStaffMe();
  const setup = useApi<{ needsSetup: boolean }>("/public/setup-status");
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const next = sp.get("next")?.startsWith("/manage") ? sp.get("next")! : "/manage";
  if (setup.data?.needsSetup) return <Navigate to="/manage/setup" replace />;
  if (user) return <Navigate to={user.mustChangePassword ? "/manage/profile?first=1" : next} replace />;
  return (
    <AuthCard title="Staff sign in" subtitle="Management portal" footer={<Link className="link" to="/manage/forgot-password">Forgot your password?</Link>}>
      {sp.get("reset") && <div className="mb-4"><Alert tone="green">Password updated. Sign in with your new password.</Alert></div>}
      <ActionForm action="/auth/staff/login" className="space-y-4" onSuccess={(r) => navigate(r.data?.mustChangePassword ? "/manage/profile?first=1" : next)}>
        <label className="block"><span className="label">Work email</span><input className="input" type="email" name="email" autoComplete="username" required /></label>
        <label className="block"><span className="label">Password</span><input className="input" type="password" name="password" autoComplete="current-password" required /></label>
        <SubmitButton className="btn-primary w-full" pendingText="Signing in…">Sign in</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}

export function Setup() {
  const setup = useApi<{ needsSetup: boolean }>("/public/setup-status");
  const navigate = useNavigate();
  if (setup.data && !setup.data.needsSetup) return <Navigate to="/manage/login" replace />;
  return (
    <AuthCard title="First-time setup" subtitle="Create the owner (Super Administrator) account. You need the SETUP_TOKEN from the server's environment file.">
      <ActionForm action="/auth/staff/setup" className="space-y-4" onSuccess={() => navigate("/manage")}>
        <label className="block"><span className="label">Setup token</span><input className="input font-mono" name="token" autoComplete="off" required /></label>
        <div className="grid grid-cols-2 gap-3">
          <label><span className="label">First name</span><input className="input" name="firstName" required /></label>
          <label><span className="label">Last name</span><input className="input" name="lastName" required /></label>
        </div>
        <label className="block"><span className="label">Email</span><input className="input" type="email" name="email" required /></label>
        <label className="block"><span className="label">Password</span><input className="input" type="password" name="password" minLength={10} required /><span className="mt-1 block text-xs text-ink-500">At least 10 characters with letters and numbers.</span></label>
        <label className="block"><span className="label">Confirm password</span><input className="input" type="password" name="confirm" required /></label>
        <SubmitButton className="btn-gold w-full">Create owner account</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}

export function StaffForgot() {
  return (
    <AuthCard title="Reset staff password" footer={<Link className="link" to="/manage/login">Back to sign in</Link>}>
      <ActionForm action="/auth/staff/forgot-password" className="space-y-4" resetOnSuccess>
        <label className="block"><span className="label">Work email</span><input className="input" type="email" name="email" required /></label>
        <SubmitButton className="btn-primary w-full">Send reset link</SubmitButton>
      </ActionForm>
      <p className="mt-4 text-xs text-ink-500">If email is not set up, ask an administrator to reset your password from the Staff page.</p>
    </AuthCard>
  );
}

export function StaffReset() {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  return (
    <AuthCard title="Choose a new password">
      <ActionForm action="/auth/reset-password" className="space-y-4" onSuccess={() => navigate("/manage/login?reset=1")}>
        <input type="hidden" name="token" value={sp.get("token") ?? ""} />
        <label className="block"><span className="label">New password</span><input className="input" type="password" name="password" minLength={10} required /></label>
        <label className="block"><span className="label">Confirm password</span><input className="input" type="password" name="confirm" required /></label>
        <SubmitButton className="btn-primary w-full">Update password</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}
