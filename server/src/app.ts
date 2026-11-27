import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import path from "node:path";
import fs from "node:fs";
import { allowedOrigins } from "./config/env";
import { csrfGuard } from "./core/auth";
import { errorHandler } from "./core/http";
import { publicRoutes } from "./modules/public.routes";
import { authRoutes } from "./modules/auth.routes";
import { guestRoutes } from "./modules/guest.routes";
import { shared } from "./modules/shared.routes";
import { frontOffice } from "./modules/staff/frontoffice.routes";
import { operations } from "./modules/staff/operations.routes";
import { finance } from "./modules/staff/finance.routes";
import { admin } from "./modules/staff/admin.routes";
import { kickJobs } from "./services/jobs";

export function createApp() {
  const app = express();
  const origins = allowedOrigins();
  app.disable("x-powered-by");
  // Behind proxies (Render = 1 hop; Vercel → Render = 2 hops) so client IPs are correct for rate limits and audit logs.
  const tp = process.env.TRUST_PROXY;
  if (tp) app.set("trust proxy", tp === "true" ? 1 : /^\d+$/.test(tp) ? Number(tp) : tp);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", "data:", "blob:"], fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'", ...origins], frameAncestors: ["'none'"], formAction: ["'self'", "https://checkout.paystack.com"], baseUri: ["'self'"],
      },
    },
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }));
  app.use(cors({ origin: origins, credentials: true }));
  // Keep the raw body for webhook signature checks.
  app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use(cookieParser());
  app.use(csrfGuard(origins));
  app.use((_req, _res, next) => { kickJobs(); next(); });

  app.get("/api/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  app.use("/api/public", publicRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api/guest", guestRoutes);
  app.use("/api/staff", frontOffice, operations, finance, admin);
  app.use("/api", shared);
  app.use("/api", (_req, res) => res.status(404).json({ ok: false, message: "Not found." }));

  // Optional: serve the built React client from the same Node app (single deployment, e.g. cPanel).
  if (process.env.SERVE_CLIENT === "true") {
    const dist = process.env.CLIENT_DIST ?? path.resolve(process.cwd(), "../client/dist");
    if (fs.existsSync(dist)) {
      app.use(express.static(dist, { index: false, maxAge: "1h" }));
      app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
    } else console.warn(`SERVE_CLIENT is true but ${dist} does not exist. Build the client first.`);
  }

  app.use(errorHandler);
  return app;
}
