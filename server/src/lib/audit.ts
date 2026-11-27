import { prisma, type Tx } from "./db";

export type Actor = {
  userId: string | null;
  name: string;
  role: string | null;
  ip?: string | null;
  userAgent?: string | null;
  type: "STAFF" | "GUEST" | "SYSTEM";
  guestId?: string | null;
};

export const SYSTEM_ACTOR: Actor = { userId: null, name: "System", role: "system", type: "SYSTEM" };

export type AuditEntry = {
  action: string;
  module: string;
  recordType?: string;
  recordId?: string | null;
  oldValues?: unknown;
  newValues?: unknown;
  reason?: string | null;
  outcome?: "SUCCESS" | "FAILURE" | "DENIED";
};

/** JSON-safe copy (Decimal / Date / BigInt become strings). */
function clean(v: unknown): unknown {
  if (v === undefined) return undefined;
  return JSON.parse(JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val)));
}

/**
 * Write an audit record. Pass the business transaction as `db` so the audit entry commits
 * (or rolls back) atomically with the operation it documents.
 */
export async function audit(db: Tx, actor: Actor, e: AuditEntry) {
  await db.auditLog.create({
    data: {
      userId: actor.userId,
      actorName: actor.name,
      actorRole: actor.role,
      action: e.action,
      module: e.module,
      recordType: e.recordType,
      recordId: e.recordId ?? null,
      oldValues: clean(e.oldValues) as never,
      newValues: clean(e.newValues) as never,
      reason: e.reason ?? null,
      outcome: e.outcome ?? "SUCCESS",
      ipAddress: actor.ip ?? null,
      userAgent: actor.userAgent?.slice(0, 300) ?? null,
    },
  });
}

/** For failures/denials that happen outside a transaction. Never throws. */
export async function auditStandalone(actor: Actor, e: AuditEntry) {
  try {
    await audit(prisma, actor, e);
  } catch (err) {
    console.error("[audit] failed to write audit record", err);
  }
}

/** Only the fields that changed: { old, new }. */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    const a = before[k];
    const b = after[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      oldValues[k] = a;
      newValues[k] = b;
    }
  }
  return { oldValues, newValues, changed: Object.keys(newValues).length > 0 };
}
