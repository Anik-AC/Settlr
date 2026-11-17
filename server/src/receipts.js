import { Router } from 'express';
import { HttpError } from './expenses.js';

/**
 * Bill scanning via OpenRouter (free vision models).
 *
 * The phone shrinks each photo before upload and sends them as data URLs; we
 * get back clean line items in cents. A long bill (or a delivery-app order) may
 * span several photos/screenshots: they all go to the model in ONE request so it
 * can de-duplicate lines that appear in more than one shot. Nothing is stored:
 * images only go to OpenRouter and are dropped after the request.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// Free vision models, tried in order (OpenRouter falls back automatically on errors/rate limits).
// Tested Nov 2026: Nemotron VL reads receipts + overlapping screenshots well (a few seconds with
// reasoning off); Gemma 4 is good too but its free tier is often rate-limited upstream.
// (`openrouter/free` was tried and dropped: it regularly hung for 2+ minutes.)
const DEFAULT_MODELS = ['nvidia/nemotron-3.5-super-vl:free', 'google/gemma-4-31b-it:free'];
const MAX_IMAGES = 6;
// Vercel rejects request bodies over 4.5 MB, so all photos together (as base64)
// must stay under ~4.2 MB. The client shrinks photos to fit before sending.
const MAX_TOTAL_CHARS = 4_200_000;
// Per model call. Up to three calls (fast, one retry on an upstream error, careful pass) must fit in the function's
// maxDuration (120 s in vercel.json).
const TIMEOUT_MS = 35_000;

/** OPENROUTER_MODEL may be one model id or a comma-separated fallback list. */
function models() {
  const list = [...new Set((process.env.OPENROUTER_MODEL || '').split(',').map((s) => s.trim()).filter(Boolean))];
  return (list.length ? list : DEFAULT_MODELS).slice(0, 3);
}

const PROMPT = `You are reading a bill: a photo of a shop or restaurant receipt, or screenshots of a delivery-app order (DoorDash, Uber Eats, Skip, etc.).
Return ONLY a JSON object, no prose, no markdown fences, with this exact shape:
{
  "merchant": string | null,
  "date": "YYYY-MM-DD" | null,
  "currency": string | null,
  "items": [ { "name": string, "quantity": number, "price": number } ],
  "subtotal": number | null,
  "tax": number | null,
  "tip": number | null,
  "fees": number | null,
  "discount": number | null,
  "total": number | null
}
"total" is the FINAL amount charged, including tax and tip (GRAND TOTAL / amount paid).
"currency" is an ISO code ONLY if the bill explicitly shows it (e.g. "USD", "EUR", "€", "£"); a bare "$" means null.
Rules:
- "price" is the LINE TOTAL actually charged for that line (quantity already multiplied in), as a plain number like 12.50.
- If a discount, coupon or promo applies to an item, subtract it from that item's price. Never output negative prices.
- "tax" is the sum of all tax lines (GST, HST, PST, QST, VAT, sales tax). Do not list taxes as items.
- "tip" is the sum of tip and gratuity lines (incl. "Dasher tip", "Courier tip", a restaurant's automatic gratuity/service charge). Do not list them as items.
- "fees" is the sum of order fees: service fee, delivery fee, small-order fee, regulatory/"other" fees, AFTER fee discounts (e.g. a "DashPass delivery discount" cancels the delivery fee). Do not list them as items.
- Bag fees and bottle deposits ARE items.
- "discount" is a coupon, promo code or credit applied to the WHOLE order (e.g. "Promotion", "Coupon", "$10 off your order", "Credits applied"), as a positive number. Do NOT put it on any item. (Discounts tied to one item or one fee still go on that item/fee as above.)
- Leave out items marked out of stock, unavailable, removed, refunded or "not included", and leave out their refund lines too: they weren't charged.
- Skip payment lines: cash, card, change, balance due, loyalty points, rounding.
- Keep item names short and readable (expand obvious abbreviations, max 40 characters).
- Use null when a value is not printed on the bill. Never invent items.
- Before answering, check that items + tax + tip + fees - discount equals the total. If not, look again for missed lines, discounts or credits.`;

const MULTI_PROMPT = (n) => `

You are given ${n} images. They are consecutive parts of ONE bill (e.g. a long receipt photographed in pieces, or several scrolled screenshots of the same order), in order.
The images usually OVERLAP: the same line can appear at the bottom of one image and the top of the next. List every real line exactly once — never count an overlapping line twice.
Tax, tip, subtotal and total appear once on the bill; report them once.
If an image clearly belongs to a different bill, ignore it.`;

/** Money-ish value -> integer cents (null if missing / unparseable). */
function cents(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Pull the first JSON object out of a model reply (handles ``` fences and chatter). */
export function extractJson(text) {
  if (!text) return null;
  const s = String(text).replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(s.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Turn the model's raw JSON into something the expense form can trust.
 * All money is integer cents. Adds warnings when the numbers don't reconcile.
 */
export function normalizeReceipt(raw) {
  const warnings = [];
  const items = [];
  for (const it of Array.isArray(raw?.items) ? raw.items.slice(0, 100) : []) {
    const name = String(it?.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const amount = cents(it?.price ?? it?.amount ?? it?.total);
    const qty = Number(it?.quantity);
    if (amount == null || amount === 0) continue;
    if (amount < 0) {
      // A stray discount line: take it off the previous item if possible.
      const prev = items[items.length - 1];
      if (prev && prev.amount + amount > 0) prev.amount += amount;
      else warnings.push(`Skipped a discount of ${(-amount / 100).toFixed(2)} — check the items.`);
      continue;
    }
    items.push({
      name: (Number.isFinite(qty) && qty > 1 && !/^\d+\s*[x×]/i.test(name) ? `${qty} × ${name}` : name).slice(0, 80) || 'Item',
      amount,
    });
  }

  const tax = Math.max(0, cents(raw?.tax) || 0);
  const tip = Math.max(0, cents(raw?.tip) || 0);
  const discount = Math.abs(cents(raw?.discount) || 0); // models sometimes send it negative
  const fees = Math.max(0, cents(raw?.fees) || 0);
  const total = cents(raw?.total);
  const subtotal = cents(raw?.subtotal);
  const itemsSum = items.reduce((a, i) => a + i.amount, 0);

  // Does what we read add up to what the bill says? Prefer the grand total: an app's
  // "subtotal" often excludes fees we list as items. Accept a pre-tip total too (some
  // receipts print TOTAL before the tip line). Allow a cent per line of rounding.
  const $ = (c) => `$${(c / 100).toFixed(2)}`;
  const close = (a, b) => Math.abs(a - b) <= Math.max(2, items.length);
  const computed = itemsSum + tax + tip + fees - discount;
  let reconciled = true;
  if (!items.length) warnings.push('No items could be read from this bill. Try a sharper, well-lit photo.');
  else if (total != null && total > 0) {
    if (!close(total, computed) && !close(total, computed - tip)) {
      reconciled = false;
      warnings.push(`Items + tax + tip${fees ? " + fees" : ""}${discount ? " − discount" : ""} come to ${$(computed)} but the bill's total is ${$(total)}. Check for a missed or misread line.`);
    }
  } else {
    // No grand total in view: usually only part of the bill was captured. A slower re-read
    // can't fix that (and an app's subtotal excludes fees, so it isn't a reliable check).
    warnings.push(`Couldn't see the bill's total${subtotal ? ` (subtotal ${$(subtotal)})` : ''}. If the bill continues, add the next photo; otherwise check the items.`);
  }

  const date = typeof raw?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) && !Number.isNaN(Date.parse(raw.date)) ? raw.date : null;
  const currency = typeof raw?.currency === 'string' ? raw.currency.trim().toUpperCase().slice(0, 3) || null : null;
  if (currency && /^[A-Z]{3}$/.test(currency) && currency !== 'CAD') {
    warnings.push(`This bill looks like it's in ${currency}. Settlr records amounts in CAD.`);
  }

  return {
    merchant: typeof raw?.merchant === 'string' ? raw.merchant.trim().slice(0, 140) || null : null,
    date,
    currency,
    items,
    tax,
    tip,
    fees,
    discount,
    subtotal: itemsSum,
    total: computed,
    billTotal: total,
    reconciled: reconciled && items.length > 0,
    warnings,
  };
}

async function callOpenRouter(images, { think = false } = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new HttpError(503, 'Bill scanning is not set up yet. Add OPENROUTER_API_KEY to the server’s .env file.');

  const [model, ...fallbacks] = models();
  let res;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'X-Title': 'Settlr',
      },
      body: JSON.stringify({
        model,
        ...(fallbacks.length ? { models: [model, ...fallbacks] } : {}),
        temperature: 0,
        max_tokens: 8000,
        // Thinking models (e.g. Nemotron) otherwise spend 20-30 s and thousands of tokens
        // reasoning; with it off they read receipts just as accurately in a few seconds.
        reasoning: think ? { effort: 'medium' } : { enabled: false },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT + (images.length > 1 ? MULTI_PROMPT(images.length) : '') },
              ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
            ],
          },
        ],
      }),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new HttpError(504, 'Reading the bill took too long. Please try again.');
    throw new HttpError(502, 'Couldn’t reach OpenRouter. Check the server’s internet connection.');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const status = res.ok ? data.error?.code || 502 : res.status;
    const msg = data.error?.message || `OpenRouter error (${status})`;
    console.warn(`  Bill scan failed (${status}): ${msg}`);
    if (status === 401 || status === 403) throw new HttpError(503, 'The OpenRouter API key was rejected. Check OPENROUTER_API_KEY.');
    if (status === 429) throw new HttpError(429, 'The free scanning model is busy (rate limited). Wait a minute and try again.');
    throw new HttpError(502, 'The scanning model couldn’t read this bill. Try again, or enter it by hand.');
  }

  const choice = data.choices?.[0];
  const text = choice?.message?.content;
  const content = Array.isArray(text) ? text.map((p) => p.text || '').join('') : text;
  const parsed = extractJson(content);
  if (!parsed) {
    console.warn(`  Bill scan: unreadable reply from ${data.model} (finish=${choice?.finish_reason}): ${String(content || '').slice(0, 200)}`);
    throw new HttpError(502, 'The scanning model replied with something unreadable. Please try again.');
  }
  return { parsed, model: data.model || model };
}

export const receiptsRouter = Router();

receiptsRouter.post('/scan', async (req, res) => {
  // `images` (array) for multi-photo bills; `image` (single) still accepted.
  const images = Array.isArray(req.body?.images) ? req.body.images : req.body?.image ? [req.body.image] : [];
  if (!images.length) throw new HttpError(400, 'Add a photo of the bill.');
  if (images.length > MAX_IMAGES) throw new HttpError(400, `Use at most ${MAX_IMAGES} photos per bill.`);
  let totalChars = 0;
  for (const image of images) {
    if (typeof image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(image)) {
      throw new HttpError(400, 'Send JPEG, PNG or WebP photos of the bill.');
    }
    totalChars += image.length;
  }
  if (totalChars > MAX_TOTAL_CHARS) throw new HttpError(413, 'Those photos are too large together. Try fewer photos.');
  // Fast pass first (reasoning off: a few seconds). If what we read doesn't add up to the
  // bill's total, retry once with reasoning on (slower, ~20-40 s, but catches missed
  // discounts / overlapping lines) and keep whichever result reconciles.
  // Free models sometimes time out upstream (502/504): try once more before giving up.
  let fast;
  try {
    fast = await callOpenRouter(images);
  } catch (err) {
    if (!(err instanceof HttpError) || ![502, 504].includes(err.status)) throw err;
    console.warn(`  Bill scan: retrying after upstream error (${err.message})`);
    fast = await callOpenRouter(images);
  }
  let receipt = { ...normalizeReceipt(fast.parsed), model: fast.model };
  if (!receipt.reconciled && receipt.items.length) {
    try {
      const careful = await callOpenRouter(images, { think: true });
      const second = { ...normalizeReceipt(careful.parsed), model: careful.model };
      if (second.reconciled || !second.warnings.length) receipt = second;
    } catch (err) {
      console.warn(`  Bill scan: careful retry failed (${err.message}); keeping the first read.`);
    }
  }
  res.json({ receipt: { ...receipt, photos: images.length } });
});
