import { Outlet } from "react-router-dom";
import { Logo } from "@/components/logo";
export function StaffAuthLayout() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-ink-900 bg-[radial-gradient(ellipse_at_top,rgba(185,140,54,0.25),transparent_60%)] px-4">
      <Logo variant="light" className="mb-3 h-24" />
      <p className="mb-2 text-xs uppercase tracking-[0.25em] text-gold-300">Management Portal</p>
      <div className="w-full max-w-md"><Outlet /></div>
    </div>
  );
}
