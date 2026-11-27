import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_URL: z.string().default("http://localhost:5173"),
  CLIENT_ORIGIN: z.string().default("http://localhost:5173"),
  SERVE_CLIENT: z.string().optional().transform((v) => v === "true"),
  CLIENT_DIST: z.string().optional(),
  DATA_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, "base64").length === 32, "DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded"),
  SETUP_TOKEN: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  TRUST_PROXY: z.string().optional(),
  COOKIE_DOMAIN: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

/** Validated at startup so a misconfigured server fails fast with a clear message. */
export function loadEnv(): Env {
  const r = schema.safeParse(process.env);
  if (!r.success) {
    console.error("Invalid server configuration:\n" + r.error.issues.map((i) => ` - ${i.path.join(".")}: ${i.message}`).join("\n"));
    process.exit(1);
  }
  return r.data;
}

export const isProd = () => process.env.NODE_ENV === "production";
export const allowedOrigins = () => (process.env.CLIENT_ORIGIN ?? "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean);
