# Putting Asher HMS online (free tiers)

```
Guest / staff browser ──> Vercel (website, client/)  ──/api──>  Render (API server, server/)  ──>  Neon (PostgreSQL)
```

The website on Vercel forwards every `/api/...` request to Render, so the browser only ever talks to one address. Sign-in cookies then work normally. Uploaded files (room photos, ID scans, receipts) are stored in the Neon database, so nothing is lost when Render restarts.

Allow about an hour the first time. You need free accounts on GitHub, Neon, Render and Vercel. Sign in to Render and Vercel with your GitHub account; that makes connecting the code easier.

---

## 1. Put the code on GitHub

1. On github.com, click **New repository**, name it `asher-hms`, choose **Private**, and don't add a README. Then click **Create**.
2. On your computer, open a terminal in the project folder (the one that contains `client`, `server` and this file). Run:

```
git init
git add .
git commit -m "Asher HMS"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/asher-hms.git
git push -u origin main
```

`.gitignore` keeps out `server\.env` (your secrets), `node_modules` and uploads. On GitHub, check that **no `.env` file** appears in the repository.

## 2. Create the database on Neon

1. On neon.tech, click **New project** and name it `asher-hms`.
2. For the region, pick **AWS Europe Central 1 (Frankfurt)**, which is closest to Lagos among the free regions. Leave Postgres at the default version.
3. Open **Connect** and copy two connection strings:
   - **Pooled** (with "Connection pooling" switched **on**). This becomes `DATABASE_URL`.
   - **Direct** (with pooling switched **off**). This becomes `DIRECT_URL`.

   Both look like `postgresql://user:password@ep-xxxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`. The pooled one has `-pooler` in the host name.

## 3. Create the API server on Render

1. On render.com, go to **New** → **Blueprint** and pick the `asher-hms` repository. Render reads `render.yaml` and shows a service called **asher-hms-api** on the free plan.
2. Fill in the values it asks for:
   - `DATABASE_URL`: the Neon **pooled** string
   - `DIRECT_URL`: the Neon **direct** string
   - `APP_URL`: `https://asher-hms.vercel.app` (you can correct it after step 4)
   - `CLIENT_ORIGIN`: the same as `APP_URL`
   - Leave the email/SMS/Paystack fields empty for now.
3. Click **Apply**. The first build takes about 5 minutes. It creates the tables, adds the rooms, roles and prices, and loads the room photos.
4. When it shows **Live**, open `https://asher-hms-api.onrender.com/api/health`. You should see `{"ok":true,...}`.
5. Open the service's **Environment** tab and note `SETUP_TOKEN` and `CRON_SECRET`, which Render generated. **Never change `DATA_ENCRYPTION_KEY`** after go-live, because guest ID numbers are encrypted with it.

If Render gave your service a different address (for example `asher-hms-api-x1y2.onrender.com`), put that address in `client/vercel.json` (the `destination` line), then commit and push.

## 4. Put the website on Vercel

1. On vercel.com, go to **Add New** → **Project** and import `asher-hms`.
2. Set **Root Directory** to `client`. Vercel detects Vite; leave the build settings as they are and add no environment variables.
3. Click **Deploy**. Note the address you get, for example `https://asher-hms.vercel.app`.
4. If that address differs from what you typed in step 3, update `APP_URL` and `CLIENT_ORIGIN` on Render. Render redeploys by itself.

## 5. First sign-in

Open `https://YOUR-SITE.vercel.app/manage/setup`, enter the `SETUP_TOKEN` from Render, and create the owner (Super Administrator) account. Then:

- **Settings → Finance**: enter the bank name, account name and account number guests should pay into.
- **Staff**: create the receptionist accounts.
- **Booking QR code**: print the poster. It now points to the live site.

## 6. Keep the free server awake and run background jobs

Render's free server sleeps after 15 minutes without visitors, and the first visitor after that waits about a minute. Two free pingers keep it awake and run the background jobs: expiring unpaid holds, reminders and emails.

**Main pinger: cron-job.org (free)**

1. Create a cronjob:
   - URL: `https://asher-hms-api.onrender.com/api/cron`
   - Schedule: every 10 minutes
   - Request method: **POST**
2. Under **Headers**, add `Authorization` with the value `Bearer YOUR-CRON_SECRET`.

**Backup pinger and nightly database backup: GitHub Actions (already in the repository)**

1. On GitHub, open the repository's **Settings** → **Secrets and variables** → **Actions** and add:
   - `API_URL`: `https://asher-hms-api.onrender.com`
   - `CRON_SECRET`: the same value as on Render
   - `DIRECT_URL`: the Neon **direct** string
2. Open the **Actions** tab and enable workflows. `nightly-backup` saves a database copy every night, kept for 30 days. You can also run it by hand: **Actions** → **nightly-backup** → **Run workflow**.

**To restore a backup:** download the artifact from the run, then run:

```
pg_restore --clean --no-owner -d "NEON-DIRECT-STRING" asher-backup.dump
```

## 7. Updating later

Make changes on your computer, then run:

```
git add .
git commit -m "What changed"
git push
```

Render and Vercel redeploy by themselves. Database changes (migrations) are applied during Render's build.

## Free-tier limits to know

- **Render free:** about 750 hours a month, which is enough for one always-on service. The pingers above keep it awake. Builds are slower.
- **Neon free:** 0.5 GB of storage. Photos are about 150 KB each and receipts a few hundred KB, so this lasts a long time. Neon pauses after 5 idle minutes and wakes in about a second.
- **Vercel Hobby:** Vercel's terms say the Hobby plan is for personal, non-commercial use. It's fine to get started. If that becomes a concern, the `client` folder deploys the same way on Cloudflare Pages (free, and commercial use is allowed); copy the `/api` rewrite into a `_redirects` file.
- **Email/SMS:** add `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` (Zoho Mail or Google Workspace on your domain) and `TERMII_API_KEY` on Render when ready. Until then, emails are skipped and logged.
- **Custom domain** (for example asherhotel.ng): add it in Vercel → **Domains**, then add it to `APP_URL` and `CLIENT_ORIGIN` on Render (comma-separated with the vercel.app address).
