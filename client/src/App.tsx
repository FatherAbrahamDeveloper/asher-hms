import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { GuestLayout } from "./layouts/GuestLayout";
import { AccountLayout } from "./layouts/AccountLayout";
import { StaffLayout } from "./layouts/StaffLayout";
import { StaffAuthLayout } from "./layouts/StaffAuthLayout";
import { useStaffMe } from "./lib/auth";
import { EmptyState } from "./components/ui";
import { Link } from "react-router-dom";

const p = (f: () => Promise<Record<string, unknown>>, name: string) => lazy(async () => ({ default: (await f())[name] as React.ComponentType }));
// Guest portal
const G = (name: string) => p(() => import("./pages/guest"), name);
const Home = G("Home"), Rooms = G("Rooms"), OldRoomLink = G("OldRoomLink"), BookingStatus = G("BookingStatus"), Track = G("Track"), Book = G("Book"), Confirmation = G("Confirmation"), Policies = G("Policies");
const Login = G("Login"), Register = G("Register"), Forgot = G("Forgot"), Reset = G("Reset"), Verify = G("Verify");
const AccountHome = G("AccountHome"), MyReservations = G("MyReservations"), MyReservation = G("MyReservation"), PreCheckIn = G("PreCheckIn"), Pay = G("Pay");
const Services = G("Services"), Messages = G("Messages"), Thread = G("Thread"), Billing = G("Billing"), Payments = G("Payments"), Profile = G("Profile"), Reviews = G("Reviews"), GuestNotifications = G("GuestNotifications");
const InvoiceDoc = p(() => import("./pages/documents"), "InvoiceDoc"), ReceiptDoc = p(() => import("./pages/documents"), "ReceiptDoc");
// Management portal
const S = (mod: () => Promise<Record<string, unknown>>, name: string) => p(mod, name);
const front = () => import("./pages/staff/frontoffice"), ops = () => import("./pages/staff/operations"), fin = () => import("./pages/staff/finance"), adm = () => import("./pages/staff/admin"), auth = () => import("./pages/staff/auth");
const StaffLogin = S(auth, "StaffLogin"), Setup = S(auth, "Setup"), StaffForgot = S(auth, "StaffForgot"), StaffReset = S(auth, "StaffReset");
const Dashboard = S(front, "Dashboard"), Reservations = S(front, "Reservations"), NewReservation = S(front, "NewReservation"), ReservationDetail = S(front, "ReservationDetail");
const Calendar = S(front, "Calendar"), Availability = S(front, "Availability"), CheckIn = S(front, "CheckIn"), CheckOut = S(front, "CheckOut");
const Guests = S(front, "Guests"), NewGuest = S(front, "NewGuest"), GuestProfile = S(front, "GuestProfile");
const RoomsAdmin = S(ops, "RoomsAdmin"), NewRoom = S(ops, "NewRoom"), RoomDetail = S(ops, "RoomDetail"), RoomTypes = S(ops, "RoomTypes");
const Housekeeping = S(ops, "Housekeeping"), Inspections = S(ops, "Inspections"), Maintenance = S(ops, "Maintenance"), Ticket = S(ops, "Ticket");
const ServiceRequests = S(ops, "ServiceRequests"), StaffMessages = S(ops, "StaffMessages"), StaffThread = S(ops, "StaffThread"), StaffReviews = S(ops, "StaffReviews");
const PaymentsAdmin = S(fin, "PaymentsAdmin"), Invoices = S(fin, "Invoices"), Refunds = S(fin, "Refunds"), Expenses = S(fin, "Expenses"), Reports = S(fin, "Reports");
const Staff = S(adm, "Staff"), NewStaff = S(adm, "NewStaff"), StaffMember = S(adm, "StaffMember"), Roles = S(adm, "Roles"), Audit = S(adm, "Audit");
const Requests = S(front, "Requests"), RequestDetail = S(front, "RequestDetail"), BookingQR = S(front, "BookingQR");
const Settings = S(adm, "Settings"), StaffNotifications = S(adm, "StaffNotifications"), StaffProfile = S(adm, "StaffProfile");

/** Client-side gate for nicer UX; the server enforces the same permission on every request. */
function Need({ any, children }: { any: string[]; children: ReactNode }) {
  const { canAny, isLoading } = useStaffMe();
  if (isLoading) return null;
  if (!canAny(any)) return <div className="py-16"><EmptyState title="You don't have access to this page" body="Your role does not include the permission required. If you need access, ask the hotel administrator." action={<Link className="btn-primary" to="/manage">Go to my workspace</Link>} /></div>;
  return <>{children}</>;
}

function Fallback() {
  return <div className="flex items-center gap-3 p-10 text-sm text-ink-500"><span className="h-4 w-4 animate-spin rounded-full border-2 border-gold-500 border-t-transparent" />Loading…</div>;
}

function NotFound() {
  const loc = useLocation();
  return <div className="py-20"><EmptyState title="Page not found" body={loc.pathname} action={<Link className="btn-primary" to={loc.pathname.startsWith("/manage") ? "/manage" : "/"}>Go home</Link>} /></div>;
}

export function App() {
  return (
    <Suspense fallback={<Fallback />}>
      <Routes>
        <Route element={<GuestLayout />}>
          <Route index element={<Home />} />
          <Route path="rooms" element={<Rooms />} />
          <Route path="rooms/:id" element={<OldRoomLink />} />
          <Route path="book" element={<Book />} />
          <Route path="book/confirmation/:ref" element={<Confirmation />} />
          <Route path="booking/:ref" element={<BookingStatus />} />
          <Route path="track" element={<Track />} />
          <Route path="policies" element={<Policies />} />
          <Route path="login" element={<Login />} />
          <Route path="register" element={<Register />} />
          <Route path="forgot-password" element={<Forgot />} />
          <Route path="reset-password" element={<Reset />} />
          <Route path="verify-email" element={<Verify />} />
          <Route path="account" element={<AccountLayout />}>
            <Route index element={<AccountHome />} />
            <Route path="reservations" element={<MyReservations />} />
            <Route path="reservations/:ref" element={<MyReservation />} />
            <Route path="reservations/:ref/check-in" element={<PreCheckIn />} />
            <Route path="reservations/:ref/pay" element={<Pay />} />
            <Route path="services" element={<Services />} />
            <Route path="messages" element={<Messages />} />
            <Route path="messages/:id" element={<Thread />} />
            <Route path="billing" element={<Billing />} />
            <Route path="payments" element={<Payments />} />
            <Route path="profile" element={<Profile />} />
            <Route path="reviews" element={<Reviews />} />
            <Route path="notifications" element={<GuestNotifications />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Route>

        <Route path="documents/invoice/:id" element={<InvoiceDoc />} />
        <Route path="documents/receipt/:id" element={<ReceiptDoc />} />

        <Route path="manage" element={<StaffAuthLayout />}>
          <Route path="login" element={<StaffLogin />} />
          <Route path="setup" element={<Setup />} />
          <Route path="forgot-password" element={<StaffForgot />} />
          <Route path="reset-password" element={<StaffReset />} />
        </Route>
        <Route path="manage" element={<StaffLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="requests" element={<Need any={["requests.allocate"]}><Requests /></Need>} />
          <Route path="requests/:id" element={<Need any={["requests.allocate"]}><RequestDetail /></Need>} />
          <Route path="booking-qr" element={<Need any={["requests.allocate", "settings.view"]}><BookingQR /></Need>} />
          <Route path="front-desk/check-in" element={<Need any={["frontdesk.checkin"]}><CheckIn /></Need>} />
          <Route path="front-desk/check-out" element={<Need any={["frontdesk.checkout", "payments.record"]}><CheckOut /></Need>} />
          <Route path="reservations" element={<Need any={["reservations.view"]}><Reservations /></Need>} />
          <Route path="reservations/new" element={<Need any={["reservations.create"]}><NewReservation /></Need>} />
          <Route path="reservations/:id" element={<Need any={["reservations.view"]}><ReservationDetail /></Need>} />
          <Route path="calendar" element={<Need any={["reservations.view"]}><Calendar /></Need>} />
          <Route path="availability" element={<Need any={["reservations.view", "rooms.view"]}><Availability /></Need>} />
          <Route path="guests" element={<Need any={["guests.view"]}><Guests /></Need>} />
          <Route path="guests/new" element={<Need any={["guests.manage"]}><NewGuest /></Need>} />
          <Route path="guests/:id" element={<Need any={["guests.view"]}><GuestProfile /></Need>} />
          <Route path="rooms" element={<Need any={["rooms.view", "rooms.manage"]}><RoomsAdmin /></Need>} />
          <Route path="rooms/new" element={<Need any={["rooms.manage"]}><NewRoom /></Need>} />
          <Route path="rooms/types" element={<Need any={["rooms.rates", "rooms.manage"]}><RoomTypes /></Need>} />
          <Route path="rooms/:id" element={<Need any={["rooms.view", "rooms.manage"]}><RoomDetail /></Need>} />
          <Route path="housekeeping" element={<Need any={["housekeeping.view", "housekeeping.work"]}><Housekeeping /></Need>} />
          <Route path="housekeeping/inspections" element={<Need any={["housekeeping.inspect"]}><Inspections /></Need>} />
          <Route path="maintenance" element={<Need any={["maintenance.view", "maintenance.work", "maintenance.report"]}><Maintenance /></Need>} />
          <Route path="maintenance/:id" element={<Need any={["maintenance.view", "maintenance.work", "maintenance.report"]}><Ticket /></Need>} />
          <Route path="service-requests" element={<Need any={["services.view"]}><ServiceRequests /></Need>} />
          <Route path="messages" element={<Need any={["messages.view"]}><StaffMessages /></Need>} />
          <Route path="messages/:id" element={<Need any={["messages.view"]}><StaffThread /></Need>} />
          <Route path="reviews" element={<Need any={["reviews.view"]}><StaffReviews /></Need>} />
          <Route path="payments" element={<Need any={["payments.view"]}><PaymentsAdmin /></Need>} />
          <Route path="invoices" element={<Need any={["payments.view"]}><Invoices /></Need>} />
          <Route path="refunds" element={<Need any={["refunds.request", "refunds.process"]}><Refunds /></Need>} />
          <Route path="expenses" element={<Need any={["expenses.view"]}><Expenses /></Need>} />
          <Route path="reports" element={<Need any={["reports.view"]}><Reports /></Need>} />
          <Route path="staff" element={<Need any={["staff.view"]}><Staff /></Need>} />
          <Route path="staff/new" element={<Need any={["staff.manage"]}><NewStaff /></Need>} />
          <Route path="staff/:id" element={<Need any={["staff.view"]}><StaffMember /></Need>} />
          <Route path="roles" element={<Need any={["roles.manage", "staff.view"]}><Roles /></Need>} />
          <Route path="audit" element={<Need any={["audit.view"]}><Audit /></Need>} />
          <Route path="settings" element={<Need any={["settings.view", "settings.manage", "rooms.rates"]}><Settings /></Need>} />
          <Route path="notifications" element={<StaffNotifications />} />
          <Route path="profile" element={<StaffProfile />} />
          <Route path="forbidden" element={<Need any={["__never__"]}><span /></Need>} />
          <Route path="*" element={<NotFound />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
