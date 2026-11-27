import fs from "node:fs/promises";
import path from "node:path";
import { randomToken } from "../lib/crypto";
import { prisma } from "../lib/db";
import { AppError } from "../lib/errors";

/** Uploaded files live outside any public folder; override with STORAGE_DIR in production. */
export const STORAGE_ROOT = process.env.STORAGE_DIR ?? path.join(process.cwd(), "storage");
export type FileKind = "rooms" | "ids" | "messages" | "proofs" | "branding";
const KINDS: FileKind[] = ["rooms", "ids", "messages", "proofs", "branding"];
const MAX_BYTES = 5 * 1024 * 1024;

const SIGNATURES: { ext: string; mime: string; test: (b: Buffer) => boolean }[] = [
  { ext: "jpg", mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "png", mime: "image/png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: "webp", mime: "image/webp", test: (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP" },
  { ext: "pdf", mime: "application/pdf", test: (b) => b.subarray(0, 5).toString() === "%PDF-" },
];

/**
 * Validate by content (magic bytes), not by filename or browser-supplied type, and store under a random name
 * outside the public folder. Files are only served through the authorised /api/files route.
 */
export async function saveUpload(file: { buffer: Buffer; size: number } | null | undefined, kind: FileKind, opts: { allowPdf?: boolean } = {}): Promise<string | null> {
  if (!file || file.size === 0) return null;
  if (file.size > MAX_BYTES) throw new AppError("Files must be 5 MB or smaller.");
  const buf = file.buffer;
  const sig = SIGNATURES.find((s) => s.test(buf));
  if (!sig || (sig.ext === "pdf" && !opts.allowPdf)) throw new AppError(opts.allowPdf ? "Upload a JPG, PNG, WEBP or PDF file." : "Upload a JPG, PNG or WEBP image.");
  const rel = `${kind}/${randomToken(18)}.${sig.ext}`;
  await storeFile(rel, buf);
  return rel;
}

/**
 * Files are kept in the database (table StoredFile) so they survive restarts and redeploys on hosts
 * like Render's free tier, and are included in database backups.
 */
export async function storeFile(rel: string, buf: Buffer) {
  const f = resolveStoredPath(rel);
  if (!f) throw new AppError("Invalid file name.");
  await prisma.storedFile.create({ data: { path: rel, kind: f.kind, mime: f.mime, size: buf.length, data: new Uint8Array(buf) } });
}

/** Read a stored file: database first, then the old storage folder (for files saved by earlier versions). */
export async function readStoredFile(rel: string): Promise<{ data: Buffer; mime: string; kind: FileKind } | null> {
  const f = resolveStoredPath(rel);
  if (!f) return null;
  const row = await prisma.storedFile.findUnique({ where: { path: rel } });
  if (row) return { data: Buffer.from(row.data), mime: row.mime, kind: f.kind };
  try { return { data: await fs.readFile(f.abs), mime: f.mime, kind: f.kind }; } catch { return null; }
}

export function resolveStoredPath(rel: string): { abs: string; kind: FileKind; mime: string } | null {
  const m = /^([a-z]+)\/([A-Za-z0-9_-]+)\.(jpg|png|webp|pdf)$/.exec(rel);
  if (!m || !KINDS.includes(m[1] as FileKind)) return null;
  const mime = SIGNATURES.find((s) => s.ext === m[3])!.mime;
  return { abs: path.join(STORAGE_ROOT, m[1], `${m[2]}.${m[3]}`), kind: m[1] as FileKind, mime };
}

export function fileUrl(rel: string | null | undefined) {
  return rel ? `/api/files/${rel}` : null;
}
