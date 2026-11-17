# Deploying Settlr to settlr.onixpace.com

Settlr runs on **Vercel** (website + API) with a **Turso** database (hosted SQLite).
Bill scanning uses **OpenRouter** free models. DNS for `onixpace.com` is on **Cloudflare**.

```
phone ──https──▶ settlr.onixpace.com (Cloudflare DNS, grey cloud)
                     │
                     ▼
                 Vercel ─ static React app (client/dist)
                     └─ /api/* → serverless function (api/index.js → Express)
                                   ├─▶ Turso database   (DATABASE_URL)
                                   └─▶ OpenRouter       (bill scanning)
```

Do the steps in order. Total time: about 30 minutes, mostly waiting for DNS and certificates.

---

## 0. Before you start: checklist

- [ ] GitHub repo `Anik-AC/Settlr` has the code on `main` (already pushed)
- [ ] Vercel account (Hobby plan is fine for personal use with friends)
- [ ] Cloudflare account that manages `onixpace.com`
- [ ] OpenRouter API key (you already have one in your local `.env`)
- [ ] A terminal with `openssl` (for generating the secret)

---

## 1. Create the database (Turso)

Vercel's servers have no permanent disk, so the SQLite file you use locally can't live there.
Turso hosts the same SQLite database for you: same schema, same SQL, free tier (several GB),
far more than a group of friends will ever use.

**Option A: dashboard (easiest)**

1. Go to <https://app.turso.tech> and sign up (GitHub login works).
2. If asked to create a **group**, pick the location **AWS US East (N. Virginia)**. Vercel runs
   functions in Washington, D.C. (`iad1`) by default, so this keeps every database call fast.
3. **Create database** → name it `settlr`.
4. Open the database and copy its **URL**. It looks like `libsql://settlr-<your-org>.turso.io`.
5. Click **Create token** (read & write, no expiry) and copy the token.

**Option B: CLI**

```bash
curl -sSfL https://get.tur.so/install.sh | bash   # install
turso auth signup                                  # or: turso auth login
turso db create settlr
turso db show settlr --url                         # -> DATABASE_URL
turso db tokens create settlr                      # -> DATABASE_AUTH_TOKEN
```

You don't need to create any tables. Settlr creates and upgrades its schema automatically on the
first request.

> Your current local database (`server/data/tally.db`) only holds the old demo data, so start
> fresh. If you ever want to upload a local SQLite file instead:
> `turso db create settlr --from-file server/data/settlr.db`

---

## 2. Prepare the environment variables

You'll paste these into Vercel in step 3. Keep them somewhere safe (a password manager), **not** in git.

| Variable | Required | Value |
|---|---|---|
| `DATABASE_URL` | yes | Turso URL from step 1, e.g. `libsql://settlr-yourorg.turso.io` |
| `DATABASE_AUTH_TOKEN` | yes | Turso token from step 1 |
| `SETTLR_SECRET` | yes | Random secret for login sessions. Generate: `openssl rand -hex 48` |
| `OPENROUTER_API_KEY` | yes (for scanning) | Your OpenRouter key (`sk-or-…`) |
| `SETTLR_INVITE_CODE` | recommended | Any word or phrase, e.g. `pizza-night-42`. Required to sign up, so strangers who find the URL can't make accounts. Leave unset for open sign-up. |
| `OPENROUTER_MODEL` | optional | Override the model list (comma-separated, max 3). Default: `nvidia/nemotron-3.5-super-vl:free,google/gemma-4-31b-it:free` |

Notes:
- **`SETTLR_SECRET` must stay the same.** Changing it signs everyone out (that's also how you
  force-logout all sessions if you ever need to).
- Friends never need the invite code typed in: **Account → Invite friends** shares a link with
  the code built in.

---

## 3. Create the Vercel project

1. <https://vercel.com/new> → **Import Git Repository** → pick `Anik-AC/Settlr`
   (if it's not listed: *Adjust GitHub App Permissions* and grant access to that repo).
2. **Framework Preset:** `Other`. **Root Directory:** `./` (leave as is).
   Build/output settings come from `vercel.json` in the repo. Don't override them.
3. Open **Environment Variables** and add every variable from step 2 (environment:
   *Production* and *Preview*).
4. Click **Deploy**. The build runs `npm install` + `npm run build` (about 1 minute).
5. Check it works: open `https://<your-project>.vercel.app/api/health` → `{"ok":true}`.
   Then open the site, create your account (with the invite code), and add an expense.

Recommended project settings:
- **Settings → Functions → Function Region:** `Washington, D.C., USA (iad1)` (same area as the database).
- **Settings → General → Node.js Version:** `22.x` (also pinned in `package.json`).

---

## 4. Point settlr.onixpace.com at Vercel

`onixpace.com` already uses Cloudflare's nameservers (`arvind.ns.cloudflare.com`,
`celeste.ns.cloudflare.com`), so **you don't need to change anything at Porkbun.** Porkbun stays
the registrar; Cloudflare answers DNS.

### 4a. In Vercel
1. Project → **Settings → Domains → Add** → enter `settlr.onixpace.com` → **Add**.
2. Vercel shows the record it wants: **Type `CNAME`, Name `settlr`, Value `<something>.vercel-dns…`**.
   Copy that exact value; it can be specific to your project.

### 4b. In Cloudflare
1. <https://dash.cloudflare.com> → `onixpace.com` → **DNS → Records → Add record**.
2. Fill in:
   - **Type:** `CNAME`
   - **Name:** `settlr`
   - **Target:** the value Vercel showed (without the trailing dot is fine)
   - **Proxy status:** **DNS only (grey cloud)** ← important
   - **TTL:** Auto
3. **Save.**

Why grey cloud: Vercel issues and renews the HTTPS certificate itself and already runs a CDN.
With Cloudflare's proxy (orange cloud) on, certificate issuance can fail and you get redirect loops.

### 4c. Wait for it
Back in Vercel → Domains, the domain turns **Valid Configuration** and gets a certificate,
usually within a few minutes (allow up to an hour). Then open <https://settlr.onixpace.com>.

If it stays pending:
- Check the Cloudflare record is **grey**, and that there's no other `settlr` record (A/AAAA) clashing.
- If you have a **CAA** record on `onixpace.com`, add one allowing `letsencrypt.org`.

### If you ever move DNS away from Cloudflare
Then add the same CNAME at Porkbun (**Domain Management → DNS Records**). Only one provider
answers DNS at a time: whichever the nameservers point to.

---

## 5. Day-to-day: updating the app

- **Code changes:** push to `main` → Vercel builds and deploys automatically. Pushes to other
  branches / PRs get a preview URL (they use the same database, so be careful testing there).
- **Changing an environment variable:** Vercel → Settings → Environment Variables → edit →
  then **Deployments → ⋯ on the latest → Redeploy**. Env changes only apply to new deployments.
- **Rotating the invite code:** change `SETTLR_INVITE_CODE`, redeploy. Existing accounts are unaffected.
- **Rotating the OpenRouter key:** create a new key at <https://openrouter.ai/keys>, update
  `OPENROUTER_API_KEY`, redeploy, delete the old key.
- **Logs / errors:** Vercel → project → **Logs** (filter by `/api`). Bill-scan problems show up as
  `Bill scan failed (...)` lines.
- **Local development** keeps using a local SQLite file (`server/data/settlr.db`). Your `.env`
  doesn't need any database variables. Don't put the production `DATABASE_URL` in your local
  `.env` unless you really mean to work on live data.

### Local `.env` (repo root, never committed)

```bash
OPENROUTER_API_KEY=sk-or-...
# optional while developing:
# SETTLR_INVITE_CODE=test-code
# OPENROUTER_MODEL=nvidia/nemotron-3.5-super-vl:free
```

---

## 5b. Accounts & groups (admin)

You can create accounts for friends instead of having them sign up. Each gets a **temporary
password** and must choose their own the first time they sign in (the app is locked until they do).

```bash
npm run admin -- list                                           # users + groups
npm run admin -- add-user Iron-man "Iron-man" --yes             # prints a temporary password
npm run admin -- reset-password iron-man --yes                  # forgot password → new temporary one
npm run admin -- add-group "Wow-CN-Tower" onix ai-man iron-man --yes
npm run admin -- add-expense "Wow-CN-Tower" --desc "Lyft" --amount 7.53 --paid-by onix \
  --split onix,ai-man,iron-man --date 2026-11-06 --category transport --yes   # tax included, equal split
```

- It uses `DATABASE_URL` / `DATABASE_AUTH_TOKEN` from your environment or `.env`. With a remote
  (Turso) database it only shows what it *would* do unless you add `--yes`.
- Usernames are case-insensitive (`Onix` signs in as `onix`). Re-running is safe: existing users
  and groups are skipped.
- Send each temporary password privately; it stops working once they've set their own.

---

## 5c. AI assistant access (MCP)

Each person can let their own AI assistant add expenses and check balances for them:

1. In Settlr: **Account → AI assistant access → Create key**. The key (`stl_…`) is shown once.
2. In Claude (app, desktop or claude.ai): **Settings → Connectors → Add custom connector**,
   URL `https://settlr.onixpace.com/api/mcp`, and under **Request headers** add
   `Authorization: Bearer stl_…`. Choose "No sign in".
   Claude Code: `claude mcp add --transport http settlr https://settlr.onixpace.com/api/mcp --header "Authorization: Bearer stl_…"`
3. Ask things like "add $24.50 pizza to Wow-CN-Tower, split equally, I paid" or "what do I owe?".
4. **Bill photos:** attach a receipt or DoorDash screenshots in Claude and say "add this bill to Settlr".
   Claude reads it and saves a draft; in Settlr it appears under **Activity → To review** (with a badge
   and a Home banner). Open it, tap who had each item, and save. Drafts don't affect balances until saved.

Tools: `list_groups`, `add_expense` (equal or itemized, tax/tip/discount), `add_bill_for_review`, `list_expenses`,
`get_balances`, `record_payment`, `delete_expense` (only entries you added). A key acts as its
owner with the same permissions as the app; it can't create keys or change passwords. Revoke a
key anytime from the same page. Any MCP-capable assistant works, and the REST API (`/api/*`)
accepts the same `Authorization: Bearer` header for scripts.

---

## 6. The database: backups and care

- **Automatic:** Turso keeps point-in-time history (how far back depends on your plan). Restore
  from the dashboard or with `turso db create settlr-restored --from-db settlr --timestamp <time>`.
- **Your own backup** (do this every so often, and before big changes):
  ```bash
  turso db shell settlr .dump > settlr-backup-$(date +%F).sql
  ```
- **Inspect data:** `turso db shell settlr` then e.g. `SELECT username, display_name FROM users;`
- **Schema changes** happen in code (`server/src/db.js`): new columns are added automatically on
  the next cold start. Make migrations additive (add columns, don't rename or drop).
- **Deleting a friend's account** isn't in the UI yet. If needed, ask first, back up, then use the shell.

---

## 7. Limits worth knowing

| Thing | Limit | What it means |
|---|---|---|
| OpenRouter free models | Rate-limited; a small daily cap on accounts that have never bought credits (larger once you've bought ~$10) | Plenty for friends. If scans start failing with "busy", that's the cap. Buying a few credits raises it; free models still cost $0. |
| Vercel request body | 4.5 MB | The app shrinks bill photos on the phone to fit (up to 6 photos per bill). |
| Vercel function time | 120 s (set in `vercel.json`) | Scans take ~3 s, up to ~60 s when the careful retry runs. |
| Turso free tier | Several GB storage, generous reads/writes | Years of expenses for a friend group. |
| Login throttling | Per server instance | Slows password guessing. Use strong passwords (8+ chars enforced). |

---

## 8. Quick troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Every page says "Can't reach the database right now" | `DATABASE_URL` / `DATABASE_AUTH_TOKEN` missing or wrong → check Vercel env vars, redeploy. Logs show the exact reason. |
| "Something went wrong on the server" on sign in | `SETTLR_SECRET` missing → add it, redeploy. |
| Sign-up says the invite code isn't right | Code mismatch (it's case-insensitive). Share the link from Account → Invite friends. |
| Scan says "not set up yet" | `OPENROUTER_API_KEY` missing on Vercel. |
| Scan says the model is busy | Free-model rate limit. Wait a minute, or add a few OpenRouter credits. |
| Domain stuck on "Invalid Configuration" | Cloudflare record must be CNAME `settlr` → Vercel's value, **grey cloud**. |
| Signed out every time you open the app | Make sure you use `https://settlr.onixpace.com` (cookies are HTTPS-only in production). |
