import { Suspense, useEffect, useState } from "react";
import { Link, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  BarChart3, BedDouble, Bell, CalendarCheck, Inbox, QrCode, CalendarRange, ClipboardCheck, ConciergeBell, FileText, History, LayoutDashboard, LogIn, LogOut, Menu,
  MessageSquare, Receipt, Search, Settings, ShieldCheck, Sparkles, Star, Undo2, UserCog, Users, Wallet, Wrench, X, type LucideIcon,
} from "lucide-react";
import { useStaffMe } from "@/lib/auth";
import { useApi } from "@/lib/query";
import { send } from "@/lib/api";
import { NAV } from "@/lib/nav";
import { Logo } from "@/components/logo";

const ICONS: Record<string, LucideIcon> = { Inbox, QrCode, BarChart3, BedDouble, CalendarCheck, CalendarRange, ClipboardCheck, ConciergeBell, FileText, History, LayoutDashboard, LogIn, LogOut, MessageSquare, Receipt, Search, Settings, ShieldCheck, Sparkles, Star, Undo2, UserCog, Users, Wallet, Wrench };

export function StaffLayout() {
  const { user, can, isLoading } = useStaffMe();
  const badges = useApi<any>(user && !user.mustChangePassword ? "/staff/me/badges" : null, { refetchInterval: 30_000 });
  const loc = useLocation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [loc.pathname]);
  if (isLoading) return null;
  if (!user) return <Navigate to="/manage/login" replace />;
  if (user.mustChangePassword && loc.pathname !== "/manage/profile") return <Navigate to="/manage/profile?first=1" replace />;

  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((i) => i.any.some(can)) })).filter((g) => g.items.length);
  const b = badges.data ?? {};
  const isActive = (href: string) => (href === "/manage" ? loc.pathname === href : loc.pathname === href || (loc.pathname.startsWith(href + "/") && !(href === "/manage/housekeeping" && loc.pathname.startsWith("/manage/housekeeping/inspections"))));
  async function logout() { await send("/auth/staff/logout"); qc.clear(); nav("/manage/login"); }
  const hotelName = b.hotelName ?? "Asher Hotel and Suites";

  const menu = (
    <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
      {groups.map((g) => (
        <div key={g.title}>
          <p className="px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-400">{g.title}</p>
          <ul className="mt-1 space-y-0.5">
            {g.items.map((i) => {
              const Icon = ICONS[i.icon] ?? LayoutDashboard;
              const n = i.badge ? b[i.badge] ?? 0 : 0;
              return (
                <li key={i.href}>
                  <Link to={i.href} className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${isActive(i.href) ? "bg-gold-500/15 text-gold-300" : "text-ink-300 hover:bg-ink-800 hover:text-white"}`}>
                    <Icon size={17} strokeWidth={1.8} /><span className="flex-1">{i.label}</span>
                    {n > 0 && <span className="rounded-full bg-gold-500 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white">{n}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
  const footer = (
    <div className="border-t border-ink-800 p-3">
      <Link to="/manage/profile" className="block rounded-lg px-3 py-2 hover:bg-ink-800">
        <p className="truncate text-sm font-medium text-white">{user.name}</p>
        <p className="truncate text-xs text-ink-400">{user.roleNames.join(", ")}</p>
      </Link>
      <button onClick={logout} className="mt-1 w-full rounded-lg px-3 py-2 text-left text-sm text-ink-300 hover:bg-ink-800 hover:text-white">Sign out</button>
    </div>
  );
  const bell = (
    <Link to="/manage/notifications" className="relative rounded p-1.5 text-ink-300 hover:bg-ink-800 hover:text-white" aria-label="Notifications">
      <Bell size={19} />{b.unread > 0 && <span className="absolute -right-1 -top-1 rounded-full bg-gold-500 px-1 text-[10px] font-bold text-white">{b.unread}</span>}
    </Link>
  );
  return (
    <div className="min-h-screen bg-[#f6f5f2]">
      <div className="no-print sticky top-0 z-30 flex items-center justify-between border-b border-ink-800 bg-ink-900 px-4 py-3 text-white lg:hidden">
        <button onClick={() => setOpen(true)} aria-label="Open menu" className="rounded p-1 hover:bg-ink-800"><Menu size={22} /></button>
        <Logo variant="light" className="h-8" alt={hotelName} />
        {bell}
      </div>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink-950/60" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col bg-ink-900">
            <div className="flex items-center justify-between px-4 py-4"><Logo variant="light" className="h-10" alt={hotelName} /><button onClick={() => setOpen(false)} className="text-ink-300" aria-label="Close menu"><X size={20} /></button></div>
            {menu}{footer}
          </aside>
        </div>
      )}
      <aside className="no-print fixed inset-y-0 left-0 hidden w-64 flex-col bg-ink-900 lg:flex">
        <div className="flex items-center justify-between px-5 py-5">
          <div className="min-w-0"><Logo variant="light" className="h-12" alt={hotelName} /><p className="mt-1 text-[11px] uppercase tracking-widest text-gold-400">Management</p></div>
          {bell}
        </div>
        {menu}{footer}
      </aside>
      <main className="lg:pl-64">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8"><Suspense fallback={<div className="p-10 text-sm text-ink-500">Loading…</div>}><Outlet /></Suspense></div>
      </main>
    </div>
  );
}
