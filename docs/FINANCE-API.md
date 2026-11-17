# Settlr Finance API (v1)

Read-only access to **one person's spending** in Settlr, for a personal finance tracker.
Base URL: `https://settlr.onixpace.com/api/finance/v1`

## What "spending" means

For every expense a person is part of, Settlr reports **their share**, not what they paid:

| Expense | Who paid | Reported for A |
|---|---|---|
| Groceries $25, A's share $10, B's $15 | B | **$10** groceries, on the bill's date |
| Movie $60 split 3 ways | A | **$20** entertainment, on the bill's date |

- The share already includes the person's part of tax, tip and order fees (service/delivery), minus their part of any coupon.
- The date is the **bill date** (what the expense says), not when it was added to Settlr.
  Someone can add last week's groceries today; the tracker gets them dated last week.
- **Settle-up payments** ("B paid A back $10") are transfers, not spending, so they are not reported.
- `you_paid_cents` and `paid_by` tell you who actually paid. Use them if your tracker also imports
  bank transactions: A's bank shows −$60 at the cinema, but A only *spent* $20 (the other $40 is
  money friends owe A).
- All amounts are **CAD**. Money is given as integer cents (`amount_cents`) and as a string with
  two decimals (`amount`). Never use floats for money.

## Connecting ("Connect to Settlr")

1. The person opens Settlr → **Account → Connected apps → Connect a finance tracker** and copies
   the token (it starts with `stl_fin_` and is shown once).
2. They paste it into the tracker. The tracker stores it securely (server-side, encrypted at rest).
3. The tracker checks it with `GET /me` and shows "Connected as @username".
4. The person can disconnect any time in Settlr (the token stops working immediately → `401`).

Send the token on every request:

```
Authorization: Bearer stl_fin_…
```

The token is read-only and can only call this API. It cannot see other people's shares or change anything.

**Call this API from the tracker's server (backend or scheduled job), never from browser JavaScript.**
Settlr doesn't send CORS headers, so browser requests from another site are blocked, and a token in
the browser could be stolen. Keep the token in the server's database (encrypted) or a secret store.

## Endpoints

### `GET /me`

```json
{ "user": { "id": 1, "username": "alex", "displayName": "Alex" }, "currency": "CAD", "connection": "finance" }
```

### `GET /transactions?since=<cursor>&limit=<n>`

The sync feed. `limit` defaults to 500 (max 1000).

- **Without `since`** (first sync): a full snapshot of the person's current spending.
- **With `since`** (every later sync): only what changed since that cursor: new expenses, edits
  (amount, category, date, description…), and expenses that **no longer count** for the person
  (deleted, or they were taken off the split).

```json
{
  "transactions": [
    {
      "id": "settlr:11",
      "expense_id": 11,
      "date": "2026-11-10",
      "description": "Groceries",
      "category": "groceries",
      "group": "Weekend Trip",
      "amount": "10.00",
      "amount_cents": 1000,
      "currency": "CAD",
      "breakdown_cents": { "items": 1000, "tax": 0, "tip": 0, "fees": 0, "discount": 0 },
      "expense_total_cents": 2500,
      "you_paid_cents": 0,
      "paid_by": [{ "username": "sam", "amount_cents": 2500 }],
      "created_at": "2026-11-17T08:14:01Z",
      "updated_at": "2026-11-17T08:14:01Z"
    }
  ],
  "removed": [{ "id": "settlr:9", "expense_id": 9 }],
  "next_cursor": "eyJwIjoibCIsImFmdGVyIjo0Mn0",
  "has_more": false,
  "currency": "CAD"
}
```

`category` is one of: `rent`, `utilities`, `internet`, `groceries`, `household`, `dining`,
`transport`, `entertainment`, `subscriptions`, `furniture`, `general`.

### `GET /summary?from=YYYY-MM-DD&to=YYYY-MM-DD`

Totals by category and by day (bill dates, inclusive), straight from Settlr. Handy for checking
your synced data or for a quick dashboard.

```json
{ "from": "2026-11-01", "to": "2026-11-30", "currency": "CAD", "total_cents": 3000,
  "by_category_cents": { "groceries": 1000, "entertainment": 2000 },
  "by_day_cents": { "2026-11-10": 1000, "2026-11-17": 2000 }, "expenses": 2 }
```

## How to sync (e.g. once a day)

Store, per connected person: the token and the last `next_cursor`. Key your rows by `id`
(`settlr:<expense_id>`).

```
cursor = stored_cursor            # null on the first sync
loop:
    page = GET /transactions?since=cursor          # omit since when cursor is null
    for r in page.removed:       delete row r.id   (ignore if you don't have it)
    for t in page.transactions:  upsert row t.id = t   (replace every field: amount, date, category…)
    cursor = page.next_cursor
    save cursor                  # after applying the page, in the same DB transaction if you can
    if not page.has_more: break
```

Rules that keep the tracker exact:

- **Always upsert** (insert or replace). The same expense can come back several times (each edit,
  or a change made while a snapshot was running); the latest version wins.
- **Save the cursor only after applying the page.** If a sync fails halfway, re-running from the
  saved cursor is safe.
- **Don't filter by date.** Changes can be for any bill date (backdated or edited expenses).
- A `400` on `since` means the cursor is unusable: drop it and do a full sync (then delete any
  local Settlr rows that the snapshot did not return).
- `401`: the person disconnected or the token is wrong. Mark the connection as needing a new token.

Running it more often than daily is fine (it's cheap when nothing changed). Changes are available
immediately.

## Errors

JSON `{ "error": "message" }` with:

| Status | Meaning |
|---|---|
| 400 | Bad parameters (e.g. invalid `since`, bad dates) |
| 401 | Missing, wrong or revoked token |
| 403 | Account still has a temporary password (the person must sign in to Settlr once), or the token isn't allowed here |
| 5xx | Try again later |

## Testing without the tracker

```bash
TOKEN=stl_fin_…
curl -s -H "Authorization: Bearer $TOKEN" https://settlr.onixpace.com/api/finance/v1/me
curl -s -H "Authorization: Bearer $TOKEN" https://settlr.onixpace.com/api/finance/v1/transactions
curl -s -H "Authorization: Bearer $TOKEN" "https://settlr.onixpace.com/api/finance/v1/transactions?since=<next_cursor>"
```
