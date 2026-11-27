import { addDays, isDateStr, lagosDayStart } from "../lib/dates";
import type { Prisma } from "@/generated/prisma/client";

export function auditWhere(sp: Record<string, string | undefined>): Prisma.AuditLogWhereInput {
  return {
    ...(sp.user ? { userId: sp.user } : {}),
    ...(sp.module ? { module: sp.module } : {}),
    ...(sp.action ? { action: { contains: sp.action, mode: "insensitive" } } : {}),
    ...(sp.outcome ? { outcome: sp.outcome } : {}),
    ...(sp.record ? { recordId: sp.record } : {}),
    ...(isDateStr(sp.from) || isDateStr(sp.to) ? { createdAt: { ...(isDateStr(sp.from) ? { gte: lagosDayStart(sp.from!) } : {}), ...(isDateStr(sp.to) ? { lt: lagosDayStart(addDays(sp.to!, 1)) } : {}) } } : {}),
  };
}

