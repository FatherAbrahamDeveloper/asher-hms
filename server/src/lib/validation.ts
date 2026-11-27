import { z } from "zod";
import { isDateStr } from "./dates";

export const zDate = z.string().refine(isDateStr, "Enter a valid date");
export const zOptDate = z.string().optional().transform((v) => (v ? v : null)).refine((v) => v === null || isDateStr(v), "Enter a valid date");
export const zText = (max = 500) => z.string().trim().max(max, `Must be at most ${max} characters`);
export const zReq = (label: string, max = 200) => z.string().trim().min(1, `${label} is required`).max(max);
export const zOpt = (max = 500) => z.string().trim().max(max).optional().transform((v) => (v ? v : null));
export const zEmail = z.string().trim().toLowerCase().email("Enter a valid email address");
export const zPhone = z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, "Enter a valid phone number");
export const zInt = (min: number, max: number, label = "Value") => z.coerce.number().int(`${label} must be a whole number`).min(min, `${label} must be at least ${min}`).max(max, `${label} must be at most ${max}`);
export const zMoney = z.string().trim().transform((v) => v.replace(/[₦,\s]/g, "")).refine((v) => /^\d+(\.\d{1,2})?$/.test(v), "Enter a valid amount");
export const zBool = z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean());
export const zId = z.string().min(1).max(50);
