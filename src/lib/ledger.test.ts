import test from 'node:test';
import assert from 'node:assert/strict';
import { startOfWeek, isoWeek, dayKey, dayStart, dayEnd, pendingByWeek, planWeekly, planDelivery, pendQty, type TxLine } from './ledger';

const utc = (s: string): number => Date.parse(s);

test('startOfWeek: lunes 00:00 hora de Madrid (verano, UTC+2)', () => {
  // Miércoles 14 oct 2026, 12:00 hora local -> lunes 12 oct 00:00 local = 11 oct 22:00 UTC
  assert.equal(startOfWeek(utc('2026-10-14T10:00:00Z')), utc('2026-10-11T22:00:00Z'));
});

test('startOfWeek: el lunes a las 00:30 locales ya es la semana nueva (domingo 22:30 UTC)', () => {
  assert.equal(startOfWeek(utc('2026-10-11T22:30:00Z')), utc('2026-10-11T22:00:00Z'));
  // un minuto antes sigue siendo la semana anterior
  assert.equal(startOfWeek(utc('2026-10-11T21:59:00Z')), utc('2026-10-04T22:00:00Z'));
});

test('startOfWeek: domingo 23:30 locales pertenece a la semana que acaba', () => {
  assert.equal(startOfWeek(utc('2026-10-11T21:30:00Z')), utc('2026-10-04T22:00:00Z'));
});

test('startOfWeek: cambio de hora de otoño (25 oct 2026) mantiene lunes 00:00 local', () => {
  // Domingo 25 oct 23:30 local (UTC+1 ya) -> lunes 19 oct 00:00 local (UTC+2) = 18 oct 22:00 UTC
  assert.equal(startOfWeek(utc('2026-10-25T22:30:00Z')), utc('2026-10-18T22:00:00Z'));
  // Miércoles 28 oct -> lunes 26 oct 00:00 local (UTC+1) = 25 oct 23:00 UTC
  assert.equal(startOfWeek(utc('2026-10-28T11:00:00Z')), utc('2026-10-25T23:00:00Z'));
});

test('startOfWeek: cambio de hora de primavera (29 mar 2026)', () => {
  // Miércoles 1 abr 2026 -> lunes 30 mar 00:00 local (UTC+2) = 29 mar 22:00 UTC
  assert.equal(startOfWeek(utc('2026-04-01T09:00:00Z')), utc('2026-03-29T22:00:00Z'));
  // Martes 24 mar -> lunes 23 mar 00:00 local (UTC+1) = 22 mar 23:00 UTC
  assert.equal(startOfWeek(utc('2026-03-24T09:00:00Z')), utc('2026-03-22T23:00:00Z'));
});

test('startOfWeek es idempotente y siempre cae en lunes', () => {
  for (let d = 0; d < 400; d++) {
    const ts = utc('2026-01-01T03:17:00Z') + d * 86_400_000 + (d % 24) * 3_600_000;
    const w = startOfWeek(ts);
    assert.equal(startOfWeek(w), w);
    assert.ok(w <= ts && ts - w < 7 * 86_400_000 + 3_600_000);
  }
});

test('isoWeek', () => {
  assert.equal(isoWeek(utc('2026-10-11T22:00:00Z')), 42); // lunes 12 oct 2026
  assert.equal(isoWeek(utc('2025-12-28T23:00:00Z')), 1); // lunes 29 dic 2025 -> semana 1 de 2026
  assert.equal(isoWeek(utc('2026-01-04T23:00:00Z')), 2); // lunes 5 ene 2026
});

test('dayKey usa el día local, no el UTC', () => {
  assert.equal(dayKey(utc('2026-10-11T22:30:00Z')), '2026-10-12');
});

/* ---------- pendientes y reposición ---------- */

const W1 = utc('2026-09-27T22:00:00Z'); // lunes 28 sep
const W2 = utc('2026-10-04T22:00:00Z'); // lunes 5 oct
const W3 = utc('2026-10-11T22:00:00Z'); // lunes 12 oct (semana en curso)

let n = 0;
const line = (o: Partial<TxLine> & { productId: string; quantity: number; weekStart: number }): TxLine => ({
  id: `t${++n}`,
  type: 'consumption',
  userId: 'u1',
  userName: 'Carlos',
  productName: `Producto ${o.productId}`,
  productCode: `C-${o.productId}`,
  deliveredQty: 0,
  deliveryStatus: 'pending',
  timestamp: o.weekStart + 3_600_000 * (n + 8),
  ...o,
});

test('pendingByWeek: solo semanas cerradas; lo de esta semana queda fuera', () => {
  const lines = [
    line({ productId: 'a', quantity: 3, weekStart: W1 }),
    line({ productId: 'a', quantity: 2, weekStart: W2 }),
    line({ productId: 'b', quantity: 4, weekStart: W2 }),
    line({ productId: 'a', quantity: 9, weekStart: W3 }), // esta semana
    line({ productId: 'a', quantity: 5, weekStart: W1, deliveryStatus: 'delivered', deliveredQty: 5 }),
    line({ productId: 'a', quantity: 6, weekStart: W1, type: 'restock' }),
  ];
  const m = pendingByWeek(lines, W3);
  assert.deepEqual([...m.keys()].sort(), [W1, W2]);
  assert.equal(m.get(W1)?.get('a'), 3);
  assert.equal(m.get(W2)?.get('a'), 2);
  assert.equal(m.get(W2)?.get('b'), 4);
});

test('pendingByWeek: un traspaso enviado NO cuenta como pendiente (los técnicos se apañan entre ellos)', () => {
  const lines = [line({ productId: 'a', quantity: 3, weekStart: W2, type: 'transfer', counterpartName: 'Iván' })];
  assert.equal(pendingByWeek(lines, W3).get(W2)?.get('a'), undefined);
});

test('pendingByWeek: entrega parcial deja solo lo que falta', () => {
  const lines = [line({ productId: 'a', quantity: 5, weekStart: W2, deliveredQty: 2 })];
  assert.equal(pendingByWeek(lines, W3).get(W2)?.get('a'), 3);
  assert.equal(pendQty(lines[0]), 3);
});

test('planWeekly: dos semanas pendientes, se reparte de la más antigua a la más reciente', () => {
  const l1 = line({ productId: 'a', quantity: 3, weekStart: W1 });
  const l2 = line({ productId: 'a', quantity: 2, weekStart: W2 });
  const r = planWeekly([l2, l1], [W1, W2], W3, { a: 4 });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.items[0].requested, 5);
  assert.equal(r.items[0].got, 4);
  assert.deepEqual(r.items[0].takes, [
    { id: l1.id, take: 3, completes: true },
    { id: l2.id, take: 1, completes: false },
  ]);
});

test('planWeekly: recoger menos de lo pedido deja el resto pendiente', () => {
  const l = line({ productId: 'a', quantity: 6, weekStart: W2 });
  const r = planWeekly([l], [W2], W3, { a: 4 });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.items[0].requested - r.items[0].got, 2);
    assert.equal(r.items[0].takes[0].completes, false);
  }
});

test('planWeekly: errores de validación', () => {
  const l = line({ productId: 'a', quantity: 3, weekStart: W2 });
  assert.equal(planWeekly([l], [], W3, { a: 1 }).ok, false);
  assert.equal(planWeekly([l], [W3], W3, { a: 1 }).ok, false); // semana en curso
  assert.equal(planWeekly([l], [W2], W3, { a: 4 }).ok, false); // más de lo pedido
  assert.equal(planWeekly([l], [W2], W3, { zzz: 1 }).ok, false); // producto sin pendiente
  assert.equal(planWeekly([l], [W2], W3, { a: 1.5 }).ok, false);
  assert.equal(planWeekly([l], [W2], W3, { a: -1 }).ok, false);
  assert.equal(planWeekly([l], [W2], W3, {}).ok, false);
  assert.equal(planWeekly([l], [W2], W3, { a: 0 }).ok, false);
});

test('planWeekly: ignora semanas no elegidas', () => {
  const l1 = line({ productId: 'a', quantity: 3, weekStart: W1 });
  const l2 = line({ productId: 'a', quantity: 2, weekStart: W2 });
  const r = planWeekly([l1, l2], [W2], W3, { a: 2 });
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.items[0].takes, [{ id: l2.id, take: 2, completes: true }]);
  assert.equal(planWeekly([l1, l2], [W2], W3, { a: 3 }).ok, false);
});

test('planDelivery: agrupa por técnico y producto y entrega lo que quede', () => {
  const lines = [
    line({ productId: 'a', quantity: 3, weekStart: W1 }),
    line({ productId: 'a', quantity: 5, weekStart: W2, deliveredQty: 2 }),
    line({ productId: 'a', quantity: 1, weekStart: W2, userId: 'u2', userName: 'Lucía' }),
    line({ productId: 'a', quantity: 4, weekStart: W2, deliveryStatus: 'delivered', deliveredQty: 4 }),
  ];
  const g = planDelivery(lines);
  assert.equal(g.length, 2);
  const carlos = g.find((x) => x.userId === 'u1');
  assert.equal(carlos?.quantity, 6);
  assert.equal(carlos?.takes.length, 2);
  assert.equal(g.find((x) => x.userId === 'u2')?.quantity, 1);
});

test('dayStart / dayEnd cubren el día local completo, también el día del cambio de hora', () => {
  assert.equal(dayStart('2026-10-12'), utc('2026-10-11T22:00:00Z'));
  assert.equal(dayEnd('2026-10-12'), utc('2026-10-12T22:00:00Z') - 1);
  // 25 oct 2026 tiene 25 horas
  assert.equal(dayEnd('2026-10-25') - dayStart('2026-10-25') + 1, 25 * 3_600_000);
  // 29 mar 2026 tiene 23 horas
  assert.equal(dayEnd('2026-03-29') - dayStart('2026-03-29') + 1, 23 * 3_600_000);
});
