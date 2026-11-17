# Settlr — split bills with friends

Settlr keeps track of who owes whom for dinners, trips, rent and groceries. Snap a receipt (or a few DoorDash screenshots), tap who had what, and Settlr splits it, tax and tip included.

**Live:** <https://settlr.onixpace.com> · **Deploying / env vars / database:** see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

**Stack:** Node.js + Express · React 19 + Vite · SQLite (Turso in production, a local file in development) · OpenRouter (free vision models) for bill scanning · hosted on Vercel. All amounts are in **CAD** and stored as integer cents.

## Local development

```bash
npm install
cp .env.example .env     # add your OPENROUTER_API_KEY for bill scanning
npm run dev              # API on :4000 + Vite on :5173 (also on your LAN for phone testing)
```

Open <http://localhost:5173> and create an account. Locally, data lives in `server/data/settlr.db` (git-ignored), and no database account is needed.

To test the production build locally: `npm run build && npm start` → <http://localhost:4000>.

```bash
npm test                 # money-engine unit tests
```

> **npm 11 note:** if `esbuild` fails to load after install, run
> `npm install-scripts approve esbuild && npm rebuild esbuild` (the approval is saved in `package.json`).

## Features

- **Accounts:** username + password (bcrypt, 8+ characters), 60-day session cookie. Optional **invite code** (`SETTLR_INVITE_CODE`) so only friends can sign up; *Account → Invite friends* shares a link with the code built in.
- **Groups:** create groups, add or remove members by username, rename, delete once everyone is settled.
- **Non-group expenses:** split with anyone you pick by username.
- **Split methods:** equally (tick who's in), exact amounts, percentages, shares, and **itemized**. Itemized lets each line item go to a different set of people, e.g. most of a receipt split 3 ways but one item split between just 2.
- **Scan a bill:** on *Add expense*, tap **Camera** or **Upload** (one or several photos/screenshots). A long bill or a delivery-app order can span up to 6 photos: they're read together, so lines that appear in two overlapping shots are only counted once. A free OpenRouter vision model reads the items, tax and tip. Tap people on each item (Everyone, any pair, or one person), pick who paid, save. Tax and tip on scanned bills are split **equally** between everyone on the bill. Photos are shrunk on the phone, sent to OpenRouter, and never stored. You'll see a warning if the items don't add up to the bill's printed total.
- **Coupons & quantities:** a bill-level coupon/promo is read as a discount and split *By portion* (or *Equally*); out-of-stock/refunded lines are left out; an item like "4 × Coffee" can be split into 4 separate items so each goes to different people.
- **AI assistant access (MCP):** each person can create an API key (Account page) and connect Claude or another MCP client to `/api/mcp` to add expenses, check balances and record payments. Share a bill photo with Claude and it lands in **Activity → To review**, where you assign items and save. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#5c-ai-assistant-access-mcp).
- **Finance tracker connection:** *Account → Connected apps* creates a read-only token that lets a personal finance tracker sync what you spent (your share of each expense, by category and bill date). See [docs/FINANCE-API.md](docs/FINANCE-API.md).
- **Tip & fees:** add a tip in $ or with the 15/18/20% buttons, and order **Fees** (service, delivery, small-order; scanned DoorDash/Uber Eats fees land here, not as items). Tax, tip and fees can be split *Equally* or *By portion*.
- **Tax:** *Included*, *Add %* (GST 5% / HST 13% / HST 15% presets or a custom rate), or *Add $*. In itemized mode tax only applies to items marked taxable, since basic groceries are zero-rated.
- **Multiple payers:** several people can each pay part of one bill.
- **Payments:** record cash, Interac e-Transfer, or other settle-ups, inside a group or outside one.
- **Balances:** your overall balance, a per-person balance broken down by group, and each member's net within a group.
- **Simplify debts:** a per-group toggle that suggests the fewest payments. The People page also has a *Simplified* view across every group.
- **Activity:** searchable feed with filters for expenses and payments.
- **UI:** mobile-first (installable via "Add to Home Screen"), bottom tab bar on phones and a sidebar on desktop. Dark and light themes, safe-area aware, 16px inputs so iOS doesn't zoom, reduced-motion support.

## How the maths works

`shared/split.js` is the one money engine. The client uses it for the live preview and the server uses it as the authority, so the server rejects any expense that doesn't add up.

- **Rounding** uses largest-remainder allocation, so every person's share always sums exactly to the total. $100 split 3 ways becomes $33.34 / $33.33 / $33.33.
- **Who owes whom per expense:** each person who owes owes each payer in proportion to how much that payer is owed. This is what makes multiple payers work.
- **Simplification** greedily matches the largest debtor with the largest creditor.

## Project layout

```
api/index.js             Vercel serverless entry (wraps the Express app)
vercel.json              build output, /api rewrite, SPA fallback, headers
shared/split.js          money engine (+ split.test.js)
server/src/
  app.js                 Express app (shared by Vercel and the local server)
  index.js               local server: serves client/dist + API
  db.js                  database client (Turso / local file), schema, migrations
  auth.js                register / login / invite code / profile
  api.js                 dashboard, people, groups, expenses
  ledger.js              balance calculations
  expenses.js            validation + persistence
  receipts.js            bill scanning (OpenRouter)
  mcp.js                 MCP server for AI assistants (/api/mcp)
  finance.js             read-only spending feed for finance trackers (/api/finance/v1)
server/scripts/admin.js  accounts, groups, expenses from the command line (npm run admin)
client/src/
  pages/                 Home, Groups, GroupDetail, People, PersonDetail,
                         Activity, ExpenseForm, ExpenseDetail, SettleUp, Account
  components/            AppShell, ExpenseRow, ui primitives
  styles.css             design system
docs/DEPLOYMENT.md       production setup: Vercel, Turso, Cloudflare DNS, env vars
docs/FINANCE-API.md      spending sync API for a finance tracker
```

## Configuration

Set these in `.env` locally (see `.env.example`) and in Vercel → Settings → Environment Variables in production.

| Env var | Needed | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | production | Turso database URL (`libsql://…`). Unset locally → `server/data/settlr.db` |
| `DATABASE_AUTH_TOKEN` | production | Turso auth token |
| `SETTLR_SECRET` | production | Session signing secret (`openssl rand -hex 48`). Auto-generated locally |
| `OPENROUTER_API_KEY` | for scanning | Turns on bill scanning ([get a key](https://openrouter.ai/keys)) |
| `OPENROUTER_MODEL` | optional | One model id or a comma-separated fallback list (max 3). Default `nvidia/nemotron-3.5-super-vl:free,google/gemma-4-31b-it:free` |
| `SETTLR_INVITE_CODE` | recommended | When set, sign-up requires this code |
| `SETTLR_DATA_DIR` | optional | Local data folder (default `server/data`) |
| `PORT` / `HOST` | optional | Local server port / bind address (default `4000` / `0.0.0.0`) |
