import type { NextFunction, Request, RequestHandler, Response } from "express";
import multer from "multer";
import { z } from "zod";
import { AppError, ForbiddenError, friendlyError } from "../lib/errors";

/** Multipart / urlencoded form parser used by every write endpoint (files kept in memory, max 5 MB each). */
export const form = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 10, fields: 200 } }).any();

export type Files = Record<string, Express.Multer.File[]>;

/** Normalised body: repeated fields become arrays; uploaded files grouped by field name. */
export function body(req: Request, arrays: string[] = []) {
  const src = (req.body ?? {}) as Record<string, unknown>;
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) o[k] = arrays.includes(k) ? (Array.isArray(v) ? v : [v]) : Array.isArray(v) ? v[v.length - 1] : v;
  for (const k of arrays) o[k] ??= [];
  return o;
}

export function files(req: Request): Files {
  const out: Files = {};
  for (const f of (req.files as Express.Multer.File[] | undefined) ?? []) (out[f.fieldname] ??= []).push(f);
  return out;
}

export type Result = { ok: true; message?: string; data?: Record<string, unknown> };

/** Wrap an async handler; returns { ok, message, data } or a JSON error with a user-safe message. */
export function h(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return async (req, res, next) => {
    try {
      const out = await fn(req, res);
      if (res.headersSent) return;
      if (typeof out === "string") res.json({ ok: true, message: out });
      else res.json(out ?? { ok: true });
    } catch (e) {
      next(e);
    }
  };
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof z.ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const i of err.issues) fieldErrors[i.path.join(".") || "form"] = i.message;
    return res.status(400).json({ ok: false, message: Object.values(fieldErrors)[0] ?? "Please check the details.", fieldErrors });
  }
  if (err instanceof multer.MulterError) return res.status(400).json({ ok: false, message: err.code === "LIMIT_FILE_SIZE" ? "Files must be 5 MB or smaller." : err.message });
  if (err instanceof ForbiddenError) return res.status(err.message.includes("session") ? 401 : 403).json({ ok: false, message: err.message });
  if (err instanceof NotFound) return res.status(404).json({ ok: false, message: err.message });
  const status = err instanceof AppError ? 400 : 500;
  res.status(status).json({ ok: false, message: friendlyError(err) });
}

export class NotFound extends AppError {
  constructor(what = "Record") { super(`${what} not found.`, "NOT_FOUND"); }
}

export function found<T>(v: T | null | undefined, what?: string): T {
  if (v === null || v === undefined) throw new NotFound(what);
  return v;
}

export function q(req: Request, key: string): string | undefined {
  const v = req.query[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export function page(req: Request, per = 25) {
  const p = Math.max(1, Number(q(req, "page")) || 1);
  return { page: p, take: per, skip: (p - 1) * per };
}
