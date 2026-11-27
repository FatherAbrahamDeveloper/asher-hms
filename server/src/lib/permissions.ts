/**
 * Granular permission catalog. Roles are just bundles of these keys; every protected
 * server operation checks a specific key, never a role name.
 */
export const PERMISSIONS = {
  // Dashboard
  "dashboard.view": ["Dashboard", "View the management dashboard"],
  // Reservations
  "reservations.view": ["Reservations", "View reservations and calendar"],
  "reservations.create": ["Reservations", "Create reservations, walk-ins and phone bookings"],
  "reservations.edit": ["Reservations", "Modify dates, rooms, guests and requests"],
  "reservations.cancel": ["Reservations", "Cancel reservations and mark no-shows"],
  "requests.allocate": ["Reservations", "Review booking forms, confirm payment and allocate rooms"],
  "pricing.negotiate": ["Reservations", "Negotiate prices: set a custom rate or give a discount (managers)"],
  "frontdesk.checkin": ["Front Desk", "Check guests in"],
  "frontdesk.checkout": ["Front Desk", "Check guests out"],
  // Rooms
  "rooms.view": ["Rooms", "View rooms and room status"],
  "rooms.manage": ["Rooms", "Add, edit and deactivate rooms, images, amenities"],
  "rooms.rates": ["Rooms", "Change room rates, room types and seasonal pricing"],
  "rooms.block": ["Rooms", "Block rooms for maintenance / out of order"],
  "rooms.return_to_service": ["Rooms", "Return blocked rooms to service"],
  // Guests
  "guests.view": ["Guests", "View guest profiles"],
  "guests.manage": ["Guests", "Register and edit guests"],
  "guests.view_sensitive": ["Guests", "View identification documents and ID numbers"],
  "guests.notes": ["Guests", "Read and write internal guest notes"],
  "guests.vip": ["Guests", "Flag VIP / blacklisted guests"],
  // Finance
  "payments.view": ["Finance", "View payments, folios and invoices"],
  "payments.record": ["Finance", "Record payments received"],
  "payments.verify": ["Finance", "Verify or reject pending payments"],
  "folio.charge": ["Finance", "Post charges to guest folios"],
  "folio.adjust": ["Finance", "Post discounts, reversals and adjustments"],
  "refunds.request": ["Finance", "Request refunds"],
  "refunds.process": ["Finance", "Approve and process refunds"],
  "invoices.issue": ["Finance", "Generate invoices and receipts"],
  "expenses.view": ["Finance", "View expenses"],
  "expenses.manage": ["Finance", "Record and void expenses"],
  "reports.view": ["Reports", "View operational and financial reports"],
  "reports.export": ["Reports", "Export reports (CSV / print)"],
  // Housekeeping
  "housekeeping.view": ["Housekeeping", "View housekeeping board"],
  "housekeeping.manage": ["Housekeeping", "Create and assign housekeeping tasks"],
  "housekeeping.work": ["Housekeeping", "Update own assigned cleaning tasks"],
  "housekeeping.inspect": ["Housekeeping", "Inspect rooms and approve as ready"],
  // Maintenance
  "maintenance.view": ["Maintenance", "View maintenance tickets"],
  "maintenance.report": ["Maintenance", "Report maintenance issues"],
  "maintenance.manage": ["Maintenance", "Assign and manage all tickets"],
  "maintenance.work": ["Maintenance", "Update own assigned tickets"],
  // Guest services
  "services.view": ["Guest Services", "View guest service requests"],
  "services.manage": ["Guest Services", "Assign and update service requests"],
  "messages.view": ["Guest Services", "Read guest conversations"],
  "messages.reply": ["Guest Services", "Reply to guests and assign conversations"],
  "reviews.view": ["Guest Services", "View reviews, complaints and suggestions"],
  "reviews.manage": ["Guest Services", "Respond to and publish reviews"],
  // Administration
  "staff.view": ["Administration", "View staff accounts and login history"],
  "staff.manage": ["Administration", "Create, edit, deactivate staff; reset passwords"],
  "roles.manage": ["Administration", "Create roles and change permissions"],
  "settings.view": ["Administration", "View system settings"],
  "settings.manage": ["Administration", "Change system settings"],
  "audit.view": ["Administration", "View audit logs"],
  "audit.export": ["Administration", "Export audit logs"],
} as const satisfies Record<string, readonly [string, string]>;

export type PermissionKey = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionKey[];

const FRONT_DESK: PermissionKey[] = [
  "dashboard.view", "reservations.view", "reservations.create", "reservations.edit", "reservations.cancel", "requests.allocate",
  "frontdesk.checkin", "frontdesk.checkout", "rooms.view", "guests.view", "guests.manage", "guests.view_sensitive",
  "guests.notes", "payments.view", "payments.record", "folio.charge", "invoices.issue", "refunds.request",
  "housekeeping.view", "maintenance.view", "maintenance.report", "services.view", "services.manage",
  "messages.view", "messages.reply", "reviews.view",
];

export const DEFAULT_ROLES: { key: string; name: string; description: string; permissions: PermissionKey[] }[] = [
  { key: "super_admin", name: "Super Administrator / Hotel Owner", description: "Full system access", permissions: ALL_PERMISSIONS },
  {
    key: "general_manager", name: "General Manager", description: "Hotel operations, staff supervision, reports and approved financial operations",
    permissions: ALL_PERMISSIONS.filter((p) => !["roles.manage", "settings.manage"].includes(p)),
  },
  { key: "front_desk", name: "Front Desk / Receptionist", description: "Reservations, check-in/out, guests, messaging, payments", permissions: FRONT_DESK },
  {
    key: "accountant", name: "Accountant / Finance Officer", description: "Payments, invoices, refunds, expenses, financial reports",
    permissions: ["dashboard.view", "reservations.view", "guests.view", "rooms.view", "payments.view", "payments.record", "payments.verify",
      "folio.charge", "folio.adjust", "refunds.request", "refunds.process", "invoices.issue", "expenses.view", "expenses.manage",
      "reports.view", "reports.export"],
  },
  {
    key: "housekeeping_supervisor", name: "Housekeeping Supervisor", description: "Housekeeping assignments, inspections and reports",
    permissions: ["dashboard.view", "rooms.view", "housekeeping.view", "housekeeping.manage", "housekeeping.work", "housekeeping.inspect",
      "maintenance.view", "maintenance.report", "services.view", "services.manage"],
  },
  { key: "housekeeping_staff", name: "Housekeeping Staff", description: "Own assigned cleaning tasks only", permissions: ["housekeeping.work", "maintenance.report"] },
  {
    key: "maintenance_supervisor", name: "Maintenance Supervisor", description: "Maintenance tickets, technicians and room blocks",
    permissions: ["dashboard.view", "rooms.view", "rooms.block", "rooms.return_to_service", "maintenance.view", "maintenance.report",
      "maintenance.manage", "maintenance.work", "housekeeping.view"],
  },
  { key: "maintenance_staff", name: "Maintenance Staff", description: "Own assigned maintenance tickets only", permissions: ["maintenance.work", "maintenance.report"] },
  {
    key: "concierge", name: "Concierge / Guest Services", description: "Guest requests and messaging",
    permissions: ["dashboard.view", "reservations.view", "rooms.view", "guests.view", "services.view", "services.manage", "messages.view",
      "messages.reply", "reviews.view", "reviews.manage", "maintenance.report"],
  },
  {
    key: "auditor", name: "Read-Only Auditor", description: "Reports, financial records and audit logs; no changes",
    permissions: ["dashboard.view", "reservations.view", "rooms.view", "guests.view", "payments.view", "expenses.view", "reports.view",
      "reports.export", "audit.view", "audit.export", "staff.view", "settings.view", "housekeeping.view", "maintenance.view", "reviews.view"],
  },
];
