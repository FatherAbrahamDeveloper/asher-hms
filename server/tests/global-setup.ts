import "dotenv/config";
import { execSync } from "node:child_process";
import pg from "pg";

export default async function setup() {
  const u = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  if (!u.pathname.endsWith("_test")) u.pathname = `${u.pathname}_test`;
  const url = u.toString();
  // create the test database if needed, then reset it
  const admin = new URL(url); const dbName = admin.pathname.slice(1); admin.pathname = "/postgres";
  const a = new pg.Client({ connectionString: admin.toString() });
  await a.connect().catch(() => {});
  await a.query(`CREATE DATABASE "${dbName}"`).catch(() => {});
  await a.end().catch(() => {});
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await c.end();
  const env = { ...process.env, DATABASE_URL: url };
  execSync("node scripts/db.mjs deploy", { env, stdio: "inherit" });
  execSync("npx tsx prisma/seed.ts", { env, stdio: "inherit" });
}
