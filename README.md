# Asher Hotel and Suites — Hotel Management System (v2)

Two folders, one database:

- **server/** — the API (Express + Prisma + PostgreSQL). All rules, prices, permissions and records live here.
- **client/** — the website (React + Vite): the guest portal at `/` and the management portal at `/manage`. It also installs as an app on phones (PWA).

Money is in Naira (₦) and times are Lagos time. Prices are final and **include VAT**.

## How bookings work

Guests never see which rooms are free. They fill a short booking form (from the website or by scanning the QR code at reception) with their name, phone, email (optional), address, company (optional), next of kin, room type, check-in date and time, and nights or short-stay package. The form shows the price before they send it.

1. The guest pays by bank transfer (adding the transfer reference, now or later) or chooses cash/POS at reception.
2. The receptionist opens **Booking forms**, checks the money has arrived, picks the room and clicks **Confirm payment & allocate room**.
3. The guest's booking page (a private link, also emailed if they gave an email) updates by itself to show the room number and photos. Guests who lost the link use **Track my booking** with their reference and phone number.

No account is needed. Guests can tick "create an account" on the form so their details are filled in next time. Front desk can still book walk-ins directly under Reservations. Print the QR code poster from **Booking QR code** in the management menu once the system is online.

## Prices built in

| Room | Overnight | Short stays |
|---|---|---|
| 301, 302, 303, 304 (Standard) | ₦30,000 | 2 hours ₦10,000 (₦15,000 from 6 pm) · 3 hours ₦15,000 · Half day (6 hours) ₦20,000 |
| 306 (Ensuite) | ₦40,000 | Not offered |

- Change room prices under **Rooms → Manage**, short-stay packages under **Settings → Short stays**.
- If a short-stay guest stays longer, check-out moves them to the next package automatically (15 minutes grace). Past 6 hours, the overnight rate applies. A short stay can also be converted to an overnight stay from the reservation page.
- **Negotiated prices**: only managers (Owner and General Manager roles, permission `pricing.negotiate`) can set a different price when booking. They must give a reason, and the standard price, agreed price and reason are all recorded in the audit log. Discounts on a bill follow the same rule.

## Run it on your computer (Windows)

You need Node.js 20+ and PostgreSQL (you already have both).

**1. Database.** v2 changes the database layout. Nothing is live yet, so start fresh. In a terminal:

```
psql -U postgres -c "DROP DATABASE IF EXISTS asher_hms" -c "CREATE DATABASE asher_hms OWNER asher"
```

**2. Server settings.** In `server`, copy `.env.example` to `.env` and fill it in. Your old `.env` values work: use the same `DATABASE_URL` (without `?host=/tmp`), `DATA_ENCRYPTION_KEY`, `SETUP_TOKEN` and `CRON_SECRET`. Make sure `APP_URL` and `CLIENT_ORIGIN` are `http://localhost:5173`.

**3. Install, create tables, add rooms and roles** (from the project folder):

```
cd server
npm install
npx prisma migrate deploy
npm run db:seed
cd ..\client
npm install
```

**4. Start it — two terminals:**

```
Terminal 1:  cd server   then   npm run dev
Terminal 2:  cd client   then   npm run dev
```

Open http://localhost:5173 for the guest site and http://localhost:5173/manage for staff. The first time, `/manage` sends you to setup: enter your `SETUP_TOKEN` and create the owner account.

If `npx prisma migrate deploy` is blocked on your network, `npm run db:migrate:offline` does the same job without downloading anything.

## Updating an existing installation

Stop both terminals, replace the `server` and `client` folders (keep your `server\.env` and `server\storage`), then:

```
cd server
npm install
npx prisma migrate deploy
npm run db:seed
cd ..\client
npm install
```

`db:seed` never overwrites your data; it adds new permissions and loads room photos from `server/prisma/seed-images/rooms` for rooms that have none.

## Photos

- Room photos: `server/prisma/seed-images/rooms/301-1.jpg`, `301-2.jpg`, … then `npm run db:seed` (or upload under Rooms → Manage).
- Hotel photos for the website: `client/public/images/site/` (outside, hallway and stairway, day and night). See the README in each folder for the names.

## Put it online

For the free Vercel + Render + Neon setup, follow **DEPLOYMENT.md** step by step. The notes below are for hosting everything on one server instead.


The simplest setup is one Node app that serves both the API and the website:

1. `npm run build` in `client`, then `npm run build` in `server`.
2. In the server `.env`: `SERVE_CLIENT=true`, `NODE_ENV=production`, `TRUST_PROXY=1`, and `APP_URL` / `CLIENT_ORIGIN` set to your real address (for example `https://asherhotel.ng`).
3. Start with `npm start` in `server` (on cPanel: "Setup Node.js App", startup file `dist/server.js`, app root `server`).
4. Use HTTPS. Point a cron job at `POST /api/cron` every minute with header `Authorization: Bearer <CRON_SECRET>` so unpaid holds expire and reminders go out.

Upload the `client/dist` folder next to `server` (the server looks for `../client/dist`), or set `CLIENT_DIST` to its path.

## Install as a phone app

Once it is online over HTTPS, open the site in Chrome on Android and choose **Add to Home screen** (or **Install app**). Staff can do the same with `/manage`. A packaged Android APK (Capacitor) can be added once the site is hosted.

## Tests

- `npm test` in `server`: pricing, VAT, short stays, overtime, negotiation, double-booking and permissions (46 tests, uses a separate `<database>_test` database).
- `e2e/workflow.mjs`: a full browser run-through of guest, front desk, housekeeping, finance and admin flows against a fresh database:
  `BASE_URL=http://localhost:4000 SETUP_TOKEN=... node e2e/workflow.mjs` (needs Playwright).

## Security notes

- Secrets live only in `server/.env`, never in the client.
- Card details never touch this system; card payments go through Paystack and are confirmed by the server, not the browser.
- Every write is checked against the user's permissions on the server and recorded in the audit log, which cannot be edited or deleted.
