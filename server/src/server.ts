import { loadEnv } from "./config/env";
import { createApp } from "./app";
import { prisma } from "./lib/db";

const env = loadEnv();

const server = createApp().listen(env.PORT, async () => {
  console.log(`Asher HMS API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  // Startup check so problems show up here, in plain words, instead of on the first page load.
  try {
    await prisma.$queryRaw`SELECT 1`;
    const [staff, rooms] = await Promise.all([prisma.user.count({ where: { type: "STAFF" } }), prisma.room.count()]);
    if (!rooms) console.warn("[setup] No rooms found. Run: npm run db:seed");
    if (!staff) console.warn(`[setup] No staff accounts yet. Open ${env.APP_URL}/manage/setup and use SETUP_TOKEN from server/.env to create the owner account.`);
    else console.log(`[ok] Database connected · ${rooms} rooms · ${staff} staff account(s)`);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (/does not exist|relation|table/i.test(msg)) console.error("[database] Connected, but the tables are missing. Run: npx prisma migrate deploy  then  npm run db:seed");
    else if (/authentication|password/i.test(msg)) console.error("[database] PostgreSQL rejected the username/password in DATABASE_URL (server/.env).");
    else console.error("[database] Can't reach PostgreSQL. Make sure the PostgreSQL service is running and DATABASE_URL in server/.env is correct.");
  }
});

server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.error(`[server] Port ${env.PORT} is already in use — the server is probably already running in another terminal. Close it (Ctrl+C there) or set a different PORT in server/.env.`);
    process.exit(1);
  }
  throw e;
});
