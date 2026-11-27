export type PermissionKey = string;

export type NavItem = { href: string; label: string; icon: string; any: PermissionKey[]; badge?: "messages" | "payments" | "notifications" | "requests" | "housekeeping" | "bookingForms" };
export type NavGroup = { title: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  { title: "Overview", items: [{ href: "/manage", label: "Dashboard", icon: "LayoutDashboard", any: ["dashboard.view"] }] },
  {
    title: "Front office", items: [
      { href: "/manage/requests", label: "Booking forms", icon: "Inbox", any: ["requests.allocate"], badge: "bookingForms" },
      { href: "/manage/front-desk/check-in", label: "Check-in", icon: "LogIn", any: ["frontdesk.checkin"] },
      { href: "/manage/front-desk/check-out", label: "Check-out", icon: "LogOut", any: ["frontdesk.checkout"] },
      { href: "/manage/reservations", label: "Reservations", icon: "CalendarCheck", any: ["reservations.view"] },
      { href: "/manage/calendar", label: "Calendar", icon: "CalendarRange", any: ["reservations.view"] },
      { href: "/manage/availability", label: "Availability", icon: "Search", any: ["reservations.view", "rooms.view"] },
      { href: "/manage/guests", label: "Guests", icon: "Users", any: ["guests.view"] },
    ],
  },
  {
    title: "Operations", items: [
      { href: "/manage/rooms", label: "Rooms", icon: "BedDouble", any: ["rooms.view", "rooms.manage"] },
      { href: "/manage/housekeeping", label: "Housekeeping", icon: "Sparkles", any: ["housekeeping.view", "housekeeping.work"], badge: "housekeeping" },
      { href: "/manage/housekeeping/inspections", label: "Inspections", icon: "ClipboardCheck", any: ["housekeeping.inspect"] },
      { href: "/manage/maintenance", label: "Maintenance", icon: "Wrench", any: ["maintenance.view", "maintenance.work", "maintenance.report"] },
      { href: "/manage/service-requests", label: "Service requests", icon: "ConciergeBell", any: ["services.view"], badge: "requests" },
      { href: "/manage/messages", label: "Messages", icon: "MessageSquare", any: ["messages.view"], badge: "messages" },
      { href: "/manage/reviews", label: "Reviews & feedback", icon: "Star", any: ["reviews.view"] },
    ],
  },
  {
    title: "Finance", items: [
      { href: "/manage/payments", label: "Payments", icon: "Wallet", any: ["payments.view"], badge: "payments" },
      { href: "/manage/invoices", label: "Invoices", icon: "FileText", any: ["payments.view"] },
      { href: "/manage/refunds", label: "Refunds", icon: "Undo2", any: ["refunds.request", "refunds.process"] },
      { href: "/manage/expenses", label: "Expenses", icon: "Receipt", any: ["expenses.view"] },
      { href: "/manage/reports", label: "Reports", icon: "BarChart3", any: ["reports.view"] },
    ],
  },
  {
    title: "Administration", items: [
      { href: "/manage/staff", label: "Staff", icon: "UserCog", any: ["staff.view"] },
      { href: "/manage/roles", label: "Roles & permissions", icon: "ShieldCheck", any: ["roles.manage", "staff.view"] },
      { href: "/manage/audit", label: "Audit logs", icon: "History", any: ["audit.view"] },
      { href: "/manage/booking-qr", label: "Booking QR code", icon: "QrCode", any: ["requests.allocate", "settings.view"] },
      { href: "/manage/settings", label: "Settings", icon: "Settings", any: ["settings.view", "settings.manage"] },
    ],
  },
];

export function firstAllowed(can: (p: PermissionKey) => boolean) {
  for (const g of NAV) for (const i of g.items) if (i.any.some(can)) return i.href;
  return "/manage/notifications";
}
