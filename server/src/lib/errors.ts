/** An error whose message is safe to show to users. */
export class AppError extends Error {
  constructor(message: string, public code: string = "APP_ERROR") {
    super(message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action.") {
    super(message, "FORBIDDEN");
  }
}

export type ActionResult = { ok: boolean; message?: string; fieldErrors?: Record<string, string>; data?: Record<string, unknown> };

/** Translate known database errors into user-facing messages. */
export function friendlyError(e: unknown): string {
  if (e instanceof AppError) return e.message;
  const anyE = e as { code?: string; message?: string; meta?: { code?: string; message?: string; driverAdapterError?: { cause?: { originalCode?: string; originalMessage?: string; kind?: string } } }; cause?: unknown };
  const text = JSON.stringify({ m: anyE?.message, meta: anyE?.meta }) ?? "";
  if (text.includes("reservation_no_overlap") || text.includes("23P01")) return "That room is already booked for some of those nights. Please choose different dates or another room.";
  if (text.includes("append-only")) return "This record is permanent and cannot be changed. Use a reversal or adjustment instead.";
  if (text.includes("Refund total exceeds")) return "The refund exceeds the refundable amount on the original payment.";
  if (text.includes("Verified payment")) return "Verified payments cannot be changed.";
  if (anyE?.code === "P2002" || text.includes("Unique constraint") || text.includes("23505")) return "A record with these details already exists.";
  if (anyE?.code === "P1001" || text.includes("DatabaseNotReachable") || text.includes("ECONNREFUSED")) {
    console.error("[database] PostgreSQL is not reachable. Check it is running and that DATABASE_URL in server/.env is correct.");
    return "The hotel system can't reach its database right now. Please try again in a moment.";
  }
  if (anyE?.code === "P1000" || text.includes("authentication failed")) {
    console.error("[database] PostgreSQL refused the username/password in DATABASE_URL (server/.env).");
    return "The hotel system can't sign in to its database. Please contact the system administrator.";
  }
  console.error("[unhandled error]", e);
  return "Something went wrong. Please try again; if it continues, contact the system administrator.";
}
