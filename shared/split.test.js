import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate, computeSplit, validatePayers, expenseDebts, simplifyDebts, toCents } from './split.js';

const sum = (a) => a.reduce((x, y) => x + y, 0);

test('allocate always sums to the total', () => {
  assert.deepEqual(allocate(1000, [1, 1, 1]), [334, 333, 333]);
  assert.equal(sum(allocate(9640, [1, 1, 1])), 9640);
  assert.deepEqual(allocate(100, [0, 1, 1]), [0, 50, 50]);
  assert.deepEqual(allocate(0, [1, 2]), [0, 0]);
});

test('toCents parses user input', () => {
  assert.equal(toCents('$1,234.56'), 123456);
  assert.equal(toCents('12.5'), 1250);
  assert.equal(toCents(''), 0);
});

test('equal split with 13% tax added', () => {
  const r = computeSplit({
    amount: 7500,
    tax: { mode: 'percent', value: 13 },
    split: { method: 'equal', participants: [1, 2, 3] },
  });
  assert.equal(r.tax, 975);
  assert.equal(r.total, 8475);
  assert.equal(sum(r.shares.map((s) => s.amount)), 8475);
  assert.deepEqual(r.errors, []);
});

test('percent split must total 100', () => {
  const bad = computeSplit({ amount: 10000, split: { method: 'percent', participants: [1, 2], values: { 1: 50, 2: 40 } } });
  assert.ok(bad.errors.length);
  const ok = computeSplit({ amount: 10000, split: { method: 'percent', participants: [1, 2, 3], values: { 1: 40, 2: 30, 3: 30 } } });
  assert.deepEqual(ok.shares.map((s) => s.amount), [4000, 3000, 3000]);
});

test('exact split must match subtotal', () => {
  const r = computeSplit({ amount: 5000, split: { method: 'exact', participants: [1, 2], values: { 1: 2000, 2: 2500 } } });
  assert.match(r.errors[0], /left to assign/);
});

test('itemized: tax only applies to taxable items', () => {
  const r = computeSplit({
    tax: { mode: 'percent', value: 13 },
    split: {
      method: 'itemized',
      items: [
        { name: 'Milk', amount: 600, taxable: false, userIds: [1, 2, 3] },
        { name: 'Paper towels', amount: 1000, taxable: true, userIds: [1, 2] },
      ],
    },
  });
  assert.equal(r.subtotal, 1600);
  assert.equal(r.tax, 130);
  const by = Object.fromEntries(r.shares.map((s) => [s.userId, s.amount]));
  assert.deepEqual(by, { 1: 200 + 500 + 65, 2: 200 + 500 + 65, 3: 200 });
});

test('payers must cover the total', () => {
  assert.deepEqual(validatePayers([{ userId: 1, amount: 6000 }, { userId: 2, amount: 4000 }], 10000), []);
  assert.ok(validatePayers([{ userId: 1, amount: 6000 }], 10000).length);
});

test('multi-payer debts are proportional', () => {
  // A paid 60, B paid 40, split 3 ways (34/33/33)
  const d = expenseDebts(
    [{ userId: 'A', amount: 6000 }, { userId: 'B', amount: 4000 }],
    [{ userId: 'A', amount: 3334 }, { userId: 'B', amount: 3333 }, { userId: 'C', amount: 3333 }]
  );
  assert.deepEqual(d, [
    { from: 'C', to: 'A', amount: 2666 },
    { from: 'C', to: 'B', amount: 667 },
  ]);
});

test('simplify reduces a chain to one transfer', () => {
  // A owes B 10, B owes C 10  =>  A pays C 10
  const out = simplifyDebts(new Map([['A', -1000], ['B', 0], ['C', 1000]]));
  assert.deepEqual(out, [{ from: 'A', to: 'C', amount: 1000 }]);
});

test('scanned bill: itemized with tax + tip split equally', () => {
  // A+B+C share nachos, A+B share wine, C alone has a burger.
  const r = computeSplit({
    tax: { mode: 'amount', value: 300 },
    tip: 600,
    extrasSplit: 'equal',
    split: {
      method: 'itemized',
      items: [
        { name: 'Nachos', amount: 1500, userIds: [1, 2, 3] },
        { name: 'Wine', amount: 2000, userIds: [1, 2] },
        { name: 'Burger', amount: 1800, userIds: [3] },
      ],
    },
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.total, 1500 + 2000 + 1800 + 300 + 600);
  const by = Object.fromEntries(r.shares.map((s) => [s.userId, s]));
  assert.deepEqual([by[1].tax, by[2].tax, by[3].tax], [100, 100, 100]);
  assert.deepEqual([by[1].tip, by[2].tip, by[3].tip], [200, 200, 200]);
  assert.equal(by[1].amount, 500 + 1000 + 100 + 200);
  assert.equal(by[3].amount, 500 + 1800 + 100 + 200);
  assert.equal(sum(r.shares.map((s) => s.amount)), r.total);
});

test('equal tax skips people with only non-taxable items; tip still reaches them', () => {
  const r = computeSplit({
    tax: { mode: 'amount', value: 100 },
    tip: 300,
    extrasSplit: 'equal',
    split: {
      method: 'itemized',
      items: [
        { name: 'Beer', amount: 1000, taxable: true, userIds: [1, 2] },
        { name: 'Milk', amount: 500, taxable: false, userIds: [3] },
      ],
    },
  });
  const by = Object.fromEntries(r.shares.map((s) => [s.userId, s]));
  assert.deepEqual([by[1].tax, by[2].tax, by[3].tax], [50, 50, 0]);
  assert.deepEqual([by[1].tip, by[2].tip, by[3].tip], [100, 100, 100]);
  assert.equal(sum(r.shares.map((s) => s.amount)), r.total);
});

test('tip defaults to proportional and keeps old expenses unchanged', () => {
  const r = computeSplit({ amount: 3000, tip: 300, split: { method: 'exact', participants: [1, 2], values: { 1: 2000, 2: 1000 } } });
  assert.deepEqual(r.shares.map((s) => s.tip), [200, 100]);
  assert.equal(r.total, 3300);
  const old = computeSplit({ amount: 3000, split: { method: 'equal', participants: [1, 2] } });
  assert.equal(old.tip, 0);
  assert.equal(old.total, 3000);
});
