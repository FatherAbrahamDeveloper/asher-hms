import { Link, Navigate, Outlet, useLocation } from "react-router-dom";
import { useGuestMe } from "@/lib/auth";

const LINKS = [
  ["/account", "Overview"], ["/account/reservations", "Reservations"], ["/account/services", "Services"], ["/account/messages", "Messages"],
  ["/account/billing", "Billing"], ["/account/payments", "Payments"], ["/account/reviews", "Feedback"], ["/account/notifications", "Notifications"], ["/account/profile", "Profile"],
] as const;

export function AccountLayout() {
  const { user, isLoading } = useGuestMe();
  const loc = useLocation();
  if (isLoading) return null;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <p className="text-sm text-ink-500">Signed in as <span className="font-medium text-ink-800">{user.name}</span></p>
      <nav className="-mx-4 mt-3 overflow-x-auto px-4">
        <ul className="flex min-w-max gap-1 border-b border-ink-200">
          {LINKS.map(([href, label]) => {
            const active = href === "/account" ? loc.pathname === href : loc.pathname.startsWith(href);
            return <li key={href}><Link to={href} className={`block border-b-2 px-3 py-2 text-sm font-medium ${active ? "border-gold-500 text-ink-900" : "border-transparent text-ink-500 hover:text-ink-800"}`}>{label}</Link></li>;
          })}
        </ul>
      </nav>
      <div className="mt-6"><Outlet /></div>
    </div>
  );
}
