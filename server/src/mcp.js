import { Router } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';
import { toCents, formatCAD, computeSplit } from '../../shared/split.js';
import { getUserByUsername, groupMemberIds, peopleMap, loadExpenses, VISIBLE_SQL, canView } from './ledger.js';
import { createExpense, getExpense, deleteExpenses, createDraft, HttpError, CATEGORIES, PAYMENT_METHODS } from './expenses.js';
import { normalizeReceipt } from './receipts.js';
import { myGroups, peopleBalances } from './api.js';
import { tx } from './db.js';

/**
 * Settlr MCP server (Streamable HTTP, stateless: one server per request, JSON
 * responses — fits serverless). Mounted at /api/mcp behind requireAuth, so every
 * tool runs as the owner of the API key and goes through the same validation
 * and permissions as the app.
 */

const APP_URL = (process.env.SETTLR_APP_URL || 'https://settlr.onixpace.com').replace(/\/$/, '');
const todayToronto = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());
const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });

/** Wrap a tool so app errors (validation, permissions) come back as readable tool errors. */
const tool = (fn) => async (args) => {
  try {
    return ok(await fn(args));
  } catch (err) {
    if (err instanceof HttpError) return fail(err.message);
    console.error('MCP tool error:', err);
    return fail('Something went wrong on the Settlr server.');
  }
};

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Date as YYYY-MM-DD. Defaults to today (Toronto time).');
const money = z.number().nonnegative().max(1_000_000);

function buildServer(me) {
  const server = new McpServer(
    { name: 'settlr', version: '1.0.0' },
    {
      // Read by the assistant when it connects.
      instructions:
        'Settlr splits shared expenses between friends (amounts in CAD). ' +
        'RULE: when the user shares a photo or screenshot of a bill, receipt or delivery order (DoorDash, Uber Eats, store or restaurant receipt) ' +
        'and asks to add it — in any wording, e.g. "add this bill", "add this expense", "add this to the group" — call add_bill_for_review with every line item. ' +
        'Do NOT use add_expense for receipts: the user assigns who had which item in the Settlr app (Activity → To review). ' +
        'Only use add_expense for receipts if the user explicitly says to split the whole bill equally without reviewing items. ' +
        'Use add_expense for simple typed expenses ("Lyft $12, split with Sam"). Call list_groups first if you need group names or usernames.',
    }
  );

  async function findGroup(ref) {
    const groups = (await myGroups(me.id)).map(({ g }) => g);
    const s = String(ref).trim().toLowerCase();
    const g = groups.find((x) => String(x.id) === s) || groups.find((x) => x.name.toLowerCase() === s);
    if (!g) throw new HttpError(404, `You're not in a group called "${ref}". Your groups: ${groups.map((x) => x.name).join(', ') || 'none'}.`);
    return g;
  }

  /** Username or display name -> user id. Within a group, only its members count. */
  async function findPerson(ref, memberIds) {
    const s = String(ref).trim().replace(/^@/, '').toLowerCase();
    if (['me', 'i', 'myself', me.username].includes(s)) return me.id;
    if (memberIds) {
      const people = await peopleMap(memberIds);
      const hit = Object.values(people).filter((p) => p.username.toLowerCase() === s || p.displayName.toLowerCase() === s);
      if (hit.length === 1) return hit[0].id;
      const names = Object.values(people).map((p) => `@${p.username}`).join(', ');
      throw new HttpError(400, `"${ref}" isn't a member of this group. Members: ${names}.`);
    }
    const u = await getUserByUsername(s);
    if (!u) throw new HttpError(404, `No Settlr user with the username "${ref}".`);
    return u.id;
  }

  const summarize = async (e, viewer = me.id) => {
    const people = await peopleMap([...e.payers.map((p) => p.userId), ...e.splits.map((x) => x.userId)]);
    const nm = (id) => (id === viewer ? 'you' : `@${people[id]?.username}`);
    return {
      id: e.id,
      date: e.date,
      description: e.description,
      group: e.group_name || null,
      type: e.type,
      total: formatCAD(e.total),
      paidBy: e.payers.map((p) => `${nm(p.userId)} ${formatCAD(p.amount)}`),
      shares: e.splits.map((x) => `${nm(x.userId)} ${formatCAD(x.amount)}`),
      link: `/expenses/${e.id}`,
    };
  };

  server.registerTool(
    'list_groups',
    {
      title: 'List my groups',
      description: 'Lists the Settlr groups you belong to, with their members (usernames) and your balance in each. Call this first to find group names and usernames.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    tool(async () => {
      const mine = await myGroups(me.id);
      const people = await peopleMap(mine.flatMap(({ s }) => s.memberIds));
      return {
        you: `@${me.username} (${me.display_name})`,
        groups: mine.map(({ g, s }) => ({
          id: g.id,
          name: g.name,
          members: s.memberIds.map((id) => `@${people[id]?.username} (${people[id]?.displayName})`),
          yourBalance: s.myNet === 0 ? 'settled' : s.myNet > 0 ? `you are owed ${formatCAD(s.myNet)}` : `you owe ${formatCAD(-s.myNet)}`,
          expenses: s.expenseCount,
        })),
      };
    })
  );

  server.registerTool(
    'add_expense',
    {
      title: 'Add a simple expense (no receipt)',
      description:
        'Adds a shared expense, as you. Amounts are in CAD dollars. ' +
        'If the user shares a photo or screenshot of a bill/receipt, use add_bill_for_review instead (so they can assign items in the app), unless they explicitly ask to split it equally right away. ' +
        'For an equal split give `amount` and optionally `split_between` (defaults to everyone in the group). ' +
        'For a receipt where people had different things, give `items` instead of `amount` (each item lists who shared it). ' +
        'By default the amount already includes tax (tax_mode "included"). Prefer a group; for a non-group expense, list usernames in `split_between` and include yourself.',
      inputSchema: {
        from_receipt: z
          .boolean()
          .describe('true if this expense comes from a photo or screenshot of a bill/receipt/delivery order in the conversation. Receipts must go through add_bill_for_review instead.'),
        user_asked_equal_split: z
          .boolean()
          .optional()
          .describe('Only for receipts: true if the user explicitly asked to split the whole bill equally and skip reviewing items.'),
        description: z.string().min(1).max(140).describe('What it was for, e.g. "Lyft" or "Costco run".'),
        group: z.string().optional().describe('Group name or id (see list_groups).'),
        amount: money.optional().describe('Total in dollars for an equal split, e.g. 47.38. Leave out when using items.'),
        split_between: z.array(z.string()).optional().describe('Usernames sharing an equal split. Defaults to every group member. Use "me" for yourself.'),
        items: z
          .array(z.object({
            name: z.string().min(1).max(80),
            amount: money.describe('Line total in dollars.'),
            people: z.array(z.string()).optional().describe('Usernames who shared this item. Defaults to everyone.'),
          }))
          .max(100)
          .optional()
          .describe('Itemized split: each item is split equally among its people.'),
        paid_by: z.string().optional().describe('Username of who paid. Defaults to you.'),
        date: dateSchema.optional(),
        category: z.enum(CATEGORIES).optional().describe('Defaults to "general".'),
        tax_mode: z.enum(['included', 'percent', 'amount']).optional().describe('"included" (default): amounts already include tax. "percent": add tax_value %. "amount": add tax_value dollars.'),
        tax_value: z.number().nonnegative().optional(),
        tip: money.optional().describe('Tip in dollars, added on top.'),
        fees: money.optional().describe('Order fees in dollars (service, delivery, small-order), added on top and shared like the tip.'),
        discount: money.optional().describe('Coupon/promo on the whole bill, in dollars, taken off the total.'),
        tax_tip_split: z.enum(['proportional', 'equal']).optional().describe('How tax, tip and fees are shared. Default "proportional".'),
        discount_split: z.enum(['proportional', 'equal']).optional().describe('How the discount is shared. Default "proportional".'),
        notes: z.string().max(1000).optional(),
      },
    },
    tool(async (a) => {
      if (a.from_receipt && !a.user_asked_equal_split) {
        throw new HttpError(
          400,
          'Receipts go to review: call add_bill_for_review with every line item, tax, tip, fees, discount and bill_total from the image. ' +
            'The user then assigns who had which item in Settlr (Activity → To review). Nothing was added.'
        );
      }
      const group = a.group ? await findGroup(a.group) : null;
      const memberIds = group ? await groupMemberIds(group.id) : null;
      if (!group && !a.split_between?.length && !a.items?.length) {
        throw new HttpError(400, 'Name a group, or list who to split with in split_between.');
      }
      const everyone = memberIds || [me.id, ...(await Promise.all((a.split_between || []).map((p) => findPerson(p))))];
      const resolve = async (list) => (list?.length ? [...new Set(await Promise.all(list.map((p) => findPerson(p, memberIds))))] : [...new Set(everyone)]);

      let split;
      let amount = 0;
      if (a.items?.length) {
        split = {
          method: 'itemized',
          items: await Promise.all(a.items.map(async (it) => ({ name: it.name, amount: toCents(it.amount), taxable: true, userIds: await resolve(it.people) }))),
        };
      } else {
        if (a.amount == null) throw new HttpError(400, 'Give an amount (or a list of items).');
        amount = toCents(a.amount);
        split = { method: 'equal', participants: await resolve(a.split_between) };
      }
      const payer = a.paid_by ? await findPerson(a.paid_by, memberIds) : me.id;
      const taxMode = a.tax_mode || 'included';
      const body = {
        type: 'expense',
        groupId: group?.id || null,
        description: a.description,
        category: a.category || 'general',
        date: a.date || todayToronto(),
        notes: a.notes || '',
        amount,
        tax: { mode: taxMode, value: taxMode === 'amount' ? toCents(a.tax_value || 0) : a.tax_value || 0 },
        tip: toCents(a.tip || 0),
        fees: toCents(a.fees || 0),
        extrasSplit: a.tax_tip_split || 'proportional',
        discount: toCents(a.discount || 0),
        discountSplit: a.discount_split || 'proportional',
        split,
      };
      // Single payer covers the whole computed total (tax/tip/discount included).
      const total = computeSplit({ ...body, amount }).total;
      body.payers = [{ userId: payer, amount: total }];
      const id = await createExpense(body, me.id);
      return { added: await summarize(await getExpense(id)) };
    })
  );

  server.registerTool(
    'add_bill_for_review',
    {
      title: 'Add a bill from a receipt photo (for review)',
      description:
        'Use this whenever the user shares a photo or screenshot of a bill/receipt (restaurant, groceries, DoorDash/Uber Eats order) and wants it in Settlr — prefer it over add_expense for bills. ' +
        'Read the image yourself and send every line item. Settlr saves it as a draft in the user\'s "To review" list; they then assign who had which items in the app and save it. Nothing is added to balances until they do. ' +
        'Rules: `amount` is the LINE TOTAL charged (quantity already multiplied in) and `quantity` is the count on that line. ' +
        'Subtract item-specific discounts from that item; put a coupon/promo on the whole order in `discount`. ' +
        'Tax lines (GST/HST/PST…) go in `tax`, tips/gratuity/Dasher tip in `tip`, and service/delivery/small-order fees in `fees` (after any fee discount such as DashPass) — none of these are items. Bag fees and bottle deposits ARE items. ' +
        'Leave out out-of-stock/refunded items and payment lines. Send `bill_total` (the final amount charged) so Settlr can check the numbers. ' +
        'If several images are parts of one bill, combine them and list overlapping lines only once. After calling, give the user the review link.',
      inputSchema: {
        merchant: z.string().min(1).max(140).describe('Store or restaurant name; becomes the expense description.'),
        items: z
          .array(z.object({
            name: z.string().min(1).max(80),
            amount: money.positive().describe('Line total in dollars.'),
            quantity: z.number().int().min(1).max(99).optional(),
          }))
          .min(1)
          .max(100),
        tax: money.optional(),
        tip: money.optional(),
        fees: money.optional().describe('Service + delivery + small-order fees, after fee discounts.'),
        discount: money.optional().describe('Order-level coupon/promo, positive dollars.'),
        bill_total: money.optional().describe('Final amount charged on the bill, for checking.'),
        date: dateSchema.optional().describe('Bill date (YYYY-MM-DD). Defaults to today.'),
        group: z.string().optional().describe('Group name or id, if the user said which group (see list_groups).'),
        paid_by: z.string().optional().describe('Username of who paid, if known. Defaults to the user.'),
        category: z.enum(CATEGORIES).optional(),
        notes: z.string().max(1000).optional(),
      },
    },
    tool(async (a) => {
      let g = a.group ? await findGroup(a.group) : null;
      if (!g) {
        // Only one group? Use it, so the review screen is ready to go.
        const mine = await myGroups(me.id);
        if (mine.length === 1) g = mine[0].g;
      }
      const memberIds = g ? await groupMemberIds(g.id) : null;
      const paidBy = a.paid_by ? await findPerson(a.paid_by, memberIds) : me.id;
      const r = normalizeReceipt({
        merchant: a.merchant,
        date: a.date,
        items: a.items.map((it) => ({ name: it.name, quantity: it.quantity, price: it.amount })),
        tax: a.tax, tip: a.tip, fees: a.fees, discount: a.discount, total: a.bill_total,
      });
      if (!r.items.length) throw new HttpError(400, 'No usable items. Each item needs a name and a positive amount.');
      const date = a.date || todayToronto();
      const id = await createDraft(me.id, {
        groupId: g?.id || null,
        description: a.merchant,
        date,
        data: {
          items: r.items, tax: r.tax, tip: r.tip, fees: r.fees, discount: r.discount, billTotal: r.billTotal,
          paidBy, category: a.category || null, notes: a.notes || '', warnings: r.warnings,
        },
      });
      return {
        saved_for_review: true,
        draft_id: id,
        review_url: `${APP_URL}/expenses/new?draft=${id}`,
        group: g?.name || 'not set (the user picks it when reviewing)',
        items: r.items.length,
        total: formatCAD(r.total),
        warnings: r.warnings,
        next_step: 'Tell the user to open the review link (or Settlr → Activity → To review) to choose who had each item, then save.',
      };
    })
  );

  server.registerTool(
    'list_expenses',
    {
      title: 'List recent expenses',
      description: 'Lists recent expenses and payments you can see, newest first. Optionally filter by group or a search word.',
      inputSchema: {
        group: z.string().optional().describe('Group name or id.'),
        search: z.string().optional().describe('Matches description or notes.'),
        limit: z.number().int().min(1).max(50).optional().describe('Default 15.'),
      },
      annotations: { readOnlyHint: true },
    },
    tool(async (a) => {
      const where = [VISIBLE_SQL];
      const params = [me.id, me.id, me.id];
      if (a.group) {
        where.push('e.group_id = ?');
        params.push((await findGroup(a.group)).id);
      }
      if (a.search) {
        where.push('(e.description LIKE ? OR e.notes LIKE ?)');
        params.push(`%${a.search}%`, `%${a.search}%`);
      }
      const list = await loadExpenses(where.join(' AND '), params, { limit: a.limit || 15 });
      return { expenses: await Promise.all(list.map((e) => summarize(e))) };
    })
  );

  server.registerTool(
    'get_balances',
    {
      title: 'Get balances',
      description: 'Who owes you and whom you owe, overall and per person (positive = they owe you).',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    tool(async () => {
      const people = await peopleBalances(me.id);
      const owed = people.filter((p) => p.balance > 0).reduce((s, p) => s + p.balance, 0);
      const owe = people.filter((p) => p.balance < 0).reduce((s, p) => s - p.balance, 0);
      return {
        youAreOwed: formatCAD(owed),
        youOwe: formatCAD(owe),
        people: people
          .filter((p) => p.balance !== 0)
          .map((p) => ({
            person: `@${p.user.username}`,
            balance: p.balance > 0 ? `owes you ${formatCAD(p.balance)}` : `you owe ${formatCAD(-p.balance)}`,
            byGroup: p.groups.map((g) => `${g.groupName || 'non-group'}: ${formatCAD(g.amount, { signed: true })}`),
          })),
      };
    })
  );

  server.registerTool(
    'record_payment',
    {
      title: 'Record a settle-up payment',
      description: 'Records that one person paid another back (cash, e-Transfer, …). You must be one of the two people unless it is inside a shared group.',
      inputSchema: {
        from: z.string().describe('Username of who paid. "me" for yourself.'),
        to: z.string().describe('Username of who received the money.'),
        amount: money.positive(),
        group: z.string().optional().describe('Group name or id, if the payment settles a group balance.'),
        method: z.enum(PAYMENT_METHODS).optional().describe('Default "etransfer".'),
        date: dateSchema.optional(),
        note: z.string().max(1000).optional(),
      },
    },
    tool(async (a) => {
      const group = a.group ? await findGroup(a.group) : null;
      const memberIds = group ? await groupMemberIds(group.id) : null;
      const id = await createExpense(
        {
          type: 'payment',
          groupId: group?.id || null,
          fromId: await findPerson(a.from, memberIds),
          toId: await findPerson(a.to, memberIds),
          amount: toCents(a.amount),
          method: a.method || 'etransfer',
          date: a.date || todayToronto(),
          notes: a.note || '',
        },
        me.id
      );
      return { recorded: await summarize(await getExpense(id)) };
    })
  );

  server.registerTool(
    'delete_expense',
    {
      title: 'Delete an expense you added',
      description: 'Deletes an expense or payment by id. Only works for entries you created yourself (use list_expenses to find the id).',
      inputSchema: { id: z.number().int().positive() },
      annotations: { destructiveHint: true },
    },
    tool(async ({ id }) => {
      const e = await getExpense(id);
      if (!e || !(await canView(e, me.id))) throw new HttpError(404, 'Expense not found.');
      if (e.created_by !== me.id) throw new HttpError(403, 'You can only delete entries you added. Ask the person who added it, or use the app.');
      const gone = await summarize(e);
      await tx((q) => deleteExpenses(q, 'id = ?', e.id));
      return { deleted: gone };
    })
  );

  return server;
}

export const mcpRouter = Router();

mcpRouter.post('/', async (req, res) => {
  const server = buildServer(req.user);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Stateless server: no SSE stream or sessions to resume/close.
const notAllowed = (_req, res) =>
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
mcpRouter.get('/', notAllowed);
mcpRouter.delete('/', notAllowed);
