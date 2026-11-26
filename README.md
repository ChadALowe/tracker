# Presence · Team availability

Tracks your team's Microsoft Teams presence and shows who's available, plus daily totals and timelines.

The tracking runs **inside the Cloudflare Worker**, once a minute during your tracking hours, so no browser tab has to stay open. The portal is just a viewer, so you can open it on your phone or anywhere else and see the same numbers.

```
Cloudflare cron (every minute)
   └─ Worker: within tracking hours?  ── no ──▶ do nothing
              │ yes
              ▼
        Microsoft Graph (app sign-in, one request for everyone)
              ▼
        D1 database: timelines, totals, activity log
              ▲
Portal (any device) ── password ──▶ /api/state
```

**Default tracking hours (UK time, adjusts for the clock changes automatically):**
Mon–Thu 08:30–16:30 · Fri 09:00–16:00 · weekends off. You can change these in **Settings → Tracking hours**.

**Start now / Stop.** *Start now* tracks straight away until today's scheduled end, or until midnight if that time has already passed. *Stop* pauses tracking for the rest of the day. *Back to schedule* cancels either one.

---

## One-time setup

### 1. Microsoft (needs someone with admin rights on your Microsoft 365)

The old page signed in as *you*, in the browser. The Worker has no browser, so it signs in as the *app* itself.

1. Open the **Microsoft Entra admin center** → **App registrations** → your existing app (or create a new one).
2. **Certificates & secrets** → **New client secret**. Copy the **Value** straight away, because it's only shown once. Note when it expires, so you can renew it before then.
3. **API permissions** → **Add a permission** → **Microsoft Graph** → **Application permissions**. Add:
   - `Presence.Read.All`
   - `User.Read.All` (lets the portal search your directory when adding people)
4. Click **Grant admin consent for <your organisation>**.
5. From **Overview**, copy the **Directory (tenant) ID** and **Application (client) ID**.

### 2. Cloudflare database

Dashboard → **Storage & Databases** → **D1** → **Create database**, name it `presence`. Copy its **Database ID** into `wrangler.jsonc` (replace `PASTE-YOUR-D1-DATABASE-ID-HERE`).

The tables are created automatically the first time the Worker runs.

### 3. Worker secrets

Dashboard → **Workers & Pages** → your Worker → **Settings** → **Variables and Secrets**. Add each of these as type **Secret**:

| Name | Value |
|---|---|
| `AZURE_TENANT_ID` | Directory (tenant) ID |
| `AZURE_CLIENT_ID` | Application (client) ID |
| `AZURE_CLIENT_SECRET` | the client secret **Value** |
| `PORTAL_PASSWORD` | a long password, needed to open the portal |

Secrets stay in place across deploys. Changing `PORTAL_PASSWORD` signs everyone out.

### 4. Deploy

- **If your Worker is connected to this GitHub repo** (Workers Builds): first check that `"name"` in `wrangler.jsonc` matches your Worker's name. Then merge this branch, and Cloudflare deploys it.
- **From a computer:** `npm install`, then `npx wrangler deploy`.

The cron trigger (`* * * * *`) comes from `wrangler.jsonc`, so you don't need to set it up in the dashboard.

### 5. First visit

Open the Worker's URL and sign in with `PORTAL_PASSWORD`. If the browser you used before still has old history, **Settings → Data** offers to **copy it to the cloud**. Your tracked people come across too.

---

## Free plan usage

All of this fits Cloudflare's free plan with plenty of room to spare:

- Cron triggers are free. That's 1,440 runs a day; outside tracking hours each run only reads the schedule.
- D1 writes run at about 2–3 rows per person per minute during tracking hours. For 10 people that's around 15,000 a day, against a free allowance of 100,000.
- History is kept for 180 days, then deleted automatically.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in real values, or point at a mock
npm run dev                      # portal on http://localhost:8787
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"   # run one check by hand
npm test                         # schedule + accounting + database tests
```

`LOGIN_BASE_URL` and `GRAPH_BASE_URL` can be set in `.dev.vars` to point the Worker at a fake Microsoft server for testing.

## Files

| Path | What it does |
|---|---|
| `src/worker.js` | cron handler, portal API, password sign-in |
| `src/accounting.js` | the time rules (gaps, Away adjustment), the same rules the page used before |
| `src/schedule.js` | tracking hours in UK time, Start/Stop |
| `src/graph.js` | Microsoft Graph with app-only sign-in |
| `src/db.js` | D1 schema and queries |
| `public/index.html` | the portal |
| `test/` | `node --test` suites, including a 3-day simulation checked against the original logic |

## Troubleshooting

The **Settings → Connection** card shows the last check time and any error.

- **"Microsoft sign-in for the Worker failed"**: the tenant ID, client ID or secret is wrong, or the secret has expired.
- **403 / "check the app has the application permissions"**: the *Application* permissions are missing (adding them as *Delegated* won't work), or admin consent wasn't granted.
- **Portal keeps asking for the password**: `PORTAL_PASSWORD` isn't set on the Worker.
- **Nothing happens outside your hours**: that's expected. Use **Start now** to track outside them.
