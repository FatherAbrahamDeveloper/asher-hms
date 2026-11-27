import { Link, Outlet, useNavigate } from "react-router-dom";
import { Suspense } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useApi } from "@/lib/query";
import { useGuestMe } from "@/lib/auth";
import { fileUrl, send } from "@/lib/api";
import { Logo } from "@/components/logo";

export function useHotel() {
  return useApi<any>("/public/settings", { staleTime: 5 * 60_000 });
}

export function GuestLayout() {
  const { data: s } = useHotel();
  const { user, unread } = useGuestMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const hotel = s?.hotel;
  async function logout() { await send("/auth/guest/logout"); await qc.invalidateQueries(); nav("/"); }
  return (
    <div className="flex min-h-screen flex-col bg-[#f7f6f3]">
      <header className="sticky top-0 z-30 border-b border-ink-800 bg-ink-900 text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <Link to="/" className="flex min-w-0 items-center gap-2">
            <Logo variant="light" className="h-10 sm:h-11" alt={hotel?.name ?? "Asher Hotel and Suites"} />
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Link to="/rooms" className="hidden rounded-md px-3 py-1.5 text-ink-200 hover:bg-ink-800 hover:text-white md:block">Rooms</Link>
            <Link to="/track" className="hidden rounded-md px-3 py-1.5 text-ink-200 hover:bg-ink-800 hover:text-white md:block">Track booking</Link>
            <Link to="/book" className="rounded-md border border-gold-400 px-3 py-1.5 font-semibold text-gold-200 hover:bg-ink-800">Book</Link>
            {user ? (
              <>
                <Link to="/account/notifications" className="rounded-md px-2 py-1.5 text-ink-200 hover:bg-ink-800 hover:text-white" aria-label="Notifications">Alerts{unread > 0 && <span className="ml-1 rounded-full bg-gold-500 px-1.5 text-xs font-semibold text-white">{unread}</span>}</Link>
                <Link to="/account" className="rounded-md bg-gold-500 px-3 py-1.5 font-semibold text-white hover:bg-gold-600">My account</Link>
                <button onClick={logout} className="hidden rounded-md px-3 py-1.5 text-ink-300 hover:text-white sm:block">Sign out</button>
              </>
            ) : (
              <>
                <Link to="/login" className="rounded-md px-3 py-1.5 text-ink-200 hover:bg-ink-800 hover:text-white">Sign in</Link>
                <Link to="/register" className="hidden rounded-md bg-gold-500 px-3 py-1.5 font-semibold text-white hover:bg-gold-600 sm:block">Register</Link>
              </>
            )}
          </nav>
        </div>
      </header>
      <main className="flex-1"><Suspense fallback={<div className="p-10 text-sm text-ink-500">Loading…</div>}><Outlet /></Suspense></main>
      <footer className="border-t border-ink-200 bg-white">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 text-sm text-ink-600 sm:grid-cols-3">
          <div>
            <Logo className="h-14" alt={hotel?.name ?? "Asher Hotel and Suites"} />
            <p className="mt-1">{[hotel?.address, hotel?.city, hotel?.state, hotel?.country].filter(Boolean).join(", ")}</p>
          </div>
          <div>
            {hotel?.phone && <p>Phone: <a className="link" href={`tel:${hotel.phone}`}>{hotel.phone}</a></p>}
            {hotel?.email && <p>Email: <a className="link" href={`mailto:${hotel.email}`}>{hotel.email}</a></p>}
            {s && <p>Check-in from {s.policies.checkInTime} · Check-out by {s.policies.checkOutTime}</p>}
          </div>
          <div className="sm:text-right">
            <Link to="/policies" className="link">Hotel policies</Link>
            <p className="mt-2 text-xs text-ink-400">Prices in Nigerian Naira (₦){s?.finance.taxInclusive ? `, ${s.finance.taxLabel} included` : ""}. Times in West Africa Time (Lagos).</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
