import { Router } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';
import { toCents, formatCAD, computeSplit } from '../../shared/split.js';
import { getUserByUsername, groupMemberIds, peopleMap, loadExpenses, VISIBLE_SQL, canView } from './ledger.js';
import { createExpense, getExpense, deleteExpenses, HttpError, CATEGORIES, PAYMENT_METHODS } from './expenses.js';
import { myGroups, peopleBalances } from './api.js';
import { tx } from './db.js';

/**
 * Settlr MCP server (Streamable HTTP, stateless: one server per request, JSON
 * responses — fits serverless). Mounted at /api/mcp behind requireAuth, so every
 * tool runs as the owner of the API key and goes through the same validation
 * and permissions as the app.
 */

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
  const server = new McpServer({ name: 'settlr', version: '1.0.0' });

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
      title: 'Add an expense',
      description:
        'Adds a shared expense, as you. Amounts are in CAD dollars. For an equal split give `amount` and optionally `split_between` (defaults to everyone in the group). ' +
        'For a receipt where people had different things, give `items` instead of `amount` (each item lists who shared it). ' +
        'By default the amount already includes tax (tax_mode "included"). Prefer a group; for a non-group expense, list usernames in `split_between` and include yourself.',
      inputSchema: {
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
        discount: money.optional().describe('Coupon/promo on the whole bill, in dollars, taken off the total.'),
        tax_tip_split: z.enum(['proportional', 'equal']).optional().describe('How tax and tip are shared. Default "proportional".'),
        discount_split: z.enum(['proportional', 'equal']).optional().describe('How the discount is shared. Default "proportional".'),
        notes: z.string().max(1000).optional(),
      },
    },
    tool(async (a) => {
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
