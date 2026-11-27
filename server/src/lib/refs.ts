import crypto from "node:crypto";
import type { Tx } from "./db";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid confusion

export function randomCode(len = 6): string {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Random, unguessable reference e.g. PAY-7KQ2M9XA. Uniqueness is enforced by DB unique constraints. */
export function makeRef(prefix: string, len = 8): string {
  return `${prefix}-${randomCode(len)}`;
}

/** Gap-free sequential number (invoices, receipts). Row-locked inside the caller's transaction. */
export async function nextSequence(tx: Tx, name: string, prefix: string, pad = 6): Promise<string> {
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO "Counter" ("name", "value") VALUES (${name}, 1)
    ON CONFLICT ("name") DO UPDATE SET "value" = "Counter"."value" + 1
    RETURNING "value"`;
  const year = new Date().getFullYear();
  return `${prefix}-${year}-${String(rows[0].value).padStart(pad, "0")}`;
}
