import test from 'node:test';
import assert from 'node:assert/strict';
import { OPS, OpError } from './ops';
import { startOfWeek } from './ledger';
import { makeDeps } from '../../test-support/adminFake';
import type { MemStore } from '../../test-support/memstore';

const at = (s: string): number => Date.parse(s);
let clock = at('2026-10-06T10:00:00+02:00'); // martes

function setup() {
  const t = makeDeps({ now: () => clock });
  const { store, fakeAuth } = t;
  store.put('catalog/p1', { code: 'CON-1', name: 'Conector', category: 'Conectores' });
  store.put('catalog/p2', { code: 'CAB-1', name: 'Cable', category: 'Cable' });
  store.put('catalog/p3', { code: 'EQP-1', name: 'Router', category: 'Equipos' });
  store.put('technicianRoles/r1', { name: 'Instalador', baseStock: { p1: 10, p2: 5 } });
  fakeAuth.seed('admin1', 'marta@stock.local', 'secreto1');
  store.put('users/admin1', { employeeCode: 'marta', name: 'Marta', role: 'admin', department: 'Almacén', territory: '', technicianRoleId: '' });
  for (const [uid, name, code] of [['w1', 'Carlos', '1001'], ['w2', 'Iván', '1002']] as const) {
    fakeAuth.seed(uid, `${code}@stock.local`, 'clave123');
    store.put(`users/${uid}`, { employeeCode: code, name, role: 'worker', department: 'Instalaciones', territory: 'Norte', technicianRoleId: 'r1' });
    store.put(`stock/${uid}`, { userId: uid, items: { p1: { currentStock: 10 }, p2: { currentStock: 5 } } });
  }
  return t;
}

const qty = (s: MemStore, uid: string, pid: string): number => s.get(`stock/${uid}`)?.items?.[pid]?.currentStock ?? 0;
const txs = (s: MemStore) => s.query({ coll: 'transactions', filters: [] }).map((r) => ({ id: r.id, ...r.data }));
const code = (c: string) => (e: unknown) => e instanceof OpError && e.code === c;

/* ---------------- consumo ---------------- */

test('consumo: descuenta stock y deja movimientos pendientes con Work Order y semana', async () => {
  clock = at('2026-10-06T10:00:00+02:00');
  const { deps, store } = setup();
  const r = await OPS.registerConsumption(deps, 'w1', { note: ' WO-31890 ', items: [{ productId: 'p1', quantity: 3 }, { productId: 'p2', quantity: 1 }] });
  assert.deepEqual(r, { ok: true, lines: 2 });
  assert.equal(qty(store, 'w1', 'p1'), 7);
  assert.equal(qty(store, 'w1', 'p2'), 4);
  const rows = txs(store);
  assert.equal(rows.length, 2);
  for (const t of rows) {
    assert.equal(t.type, 'consumption');
    assert.equal(t.note, 'WO-31890');
    assert.equal(t.deliveryStatus, 'pending');
    assert.equal(t.deliveredQty, 0);
    assert.equal(t.userId, 'w1');
    assert.equal(t.userName, 'Carlos');
    assert.equal(t.counterpartId, null);
    assert.equal(t.weekStart, startOfWeek(clock));
  }
});

test('consumo: la Work Order es obligatoria y no se escribe nada si falta', async () => {
  const { deps, store } = setup();
  await assert.rejects(OPS.registerConsumption(deps, 'w1', { note: '   ', items: [{ productId: 'p1', quantity: 1 }] }), code('invalid-argument'));
  assert.equal(txs(store).length, 0);
  assert.equal(qty(store, 'w1', 'p1'), 10);
});

test('consumo: no se puede gastar más de lo que se tiene y la operación es atómica', async () => {
  const { deps, store } = setup();
  await assert.rejects(
    OPS.registerConsumption(deps, 'w1', { note: 'WO-1', items: [{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 6 }] }),
    code('failed-precondition'),
  );
  assert.equal(txs(store).length, 0);
  assert.equal(qty(store, 'w1', 'p1'), 10);
  assert.equal(qty(store, 'w1', 'p2'), 5);
});

test('consumo: validaciones de entrada y permisos', async () => {
  const { deps } = setup();
  const ok = [{ productId: 'p1', quantity: 1 }];
  await assert.rejects(OPS.registerConsumption(deps, undefined, { note: 'x', items: ok }), code('unauthenticated'));
  await assert.rejects(OPS.registerConsumption(deps, 'nadie', { note: 'x', items: ok }), code('permission-denied'));
  await assert.rejects(OPS.registerConsumption(deps, 'admin1', { note: 'x', items: ok }), code('permission-denied'));
  await assert.rejects(OPS.registerConsumption(deps, 'w1', { note: 'x', items: [] }), code('invalid-argument'));
  await assert.rejects(OPS.registerConsumption(deps, 'w1', { note: 'x', items: [{ productId: 'p1', quantity: 0 }] }), code('invalid-argument'));
  await assert.rejects(OPS.registerConsumption(deps, 'w1', { note: 'x', items: [{ productId: 'p1', quantity: 1.5 }] }), code('invalid-argument'));
  await assert.rejects(OPS.registerConsumption(deps, 'w1', { note: 'x', items: [{ productId: 'p1', quantity: -2 }] }), code('invalid-argument'));
  await assert.rejects(OPS.registerConsumption(deps, 'w1', { note: 'x', items: [{ productId: 'a/b', quantity: 1 }] }), code('invalid-argument'));
  await assert.rejects(OPS.registerConsumption(deps, 'w1', { note: 'x', items: [{ productId: 'noexiste', quantity: 1 }] }), code('not-found'));
  await assert.rejects(OPS.registerConsumption(deps, 'w1', { note: 'x'.repeat(200), items: ok }), code('invalid-argument'));
  await assert.rejects(OPS.registerConsumption(deps, 'w1', null), code('invalid-argument'));
});

test('consumo: productos repetidos se suman', async () => {
  const { deps, store } = setup();
  await OPS.registerConsumption(deps, 'w1', { note: 'WO-2', items: [{ productId: 'p1', quantity: 2 }, { productId: 'p1', quantity: 3 }] });
  assert.equal(qty(store, 'w1', 'p1'), 5);
  assert.equal(txs(store).length, 1);
  assert.equal(txs(store)[0].quantity, 5);
});

/* ---------------- material extra ---------------- */

test('material extra: suma stock, no depende de lo pendiente y queda marcado como extra', async () => {
  const { deps, store } = setup();
  await OPS.registerExtra(deps, 'w1', { note: 'Para una instalación especial', items: [{ productId: 'p3', quantity: 2 }] });
  assert.equal(qty(store, 'w1', 'p3'), 2);
  const t = txs(store)[0];
  assert.equal(t.type, 'restock');
  assert.equal(t.kind, 'extra');
  assert.equal(t.deliveryStatus, 'delivered');
  assert.equal(store.get('stock/w1')?.items.p3.lastRestockedAt, clock);
});

test('material extra: la nota es opcional', async () => {
  const { deps, store } = setup();
  await OPS.registerExtra(deps, 'w1', { items: [{ productId: 'p1', quantity: 1 }] });
  assert.equal(qty(store, 'w1', 'p1'), 11);
});

/* ---------------- traspasos ---------------- */

test('traspaso: baja al que da, sube al que recibe y NO queda pendiente de reponer', async () => {
  const { deps, store } = setup();
  await OPS.registerTransfer(deps, 'w1', { toUserId: 'w2', note: 'Avería urgente', items: [{ productId: 'p1', quantity: 3 }] });
  assert.equal(qty(store, 'w1', 'p1'), 7);
  assert.equal(qty(store, 'w2', 'p1'), 13);
  const t = txs(store)[0];
  assert.equal(t.type, 'transfer');
  assert.equal(t.userId, 'w1');
  assert.equal(t.counterpartId, 'w2');
  assert.equal(t.counterpartName, 'Iván');
  assert.notEqual(t.deliveryStatus, 'pending');
});

test('traspaso: validaciones', async () => {
  const { deps, store } = setup();
  const items = [{ productId: 'p1', quantity: 1 }];
  await assert.rejects(OPS.registerTransfer(deps, 'w1', { toUserId: 'w1', items }), code('invalid-argument'));
  await assert.rejects(OPS.registerTransfer(deps, 'w1', { toUserId: 'admin1', items }), code('not-found'));
  await assert.rejects(OPS.registerTransfer(deps, 'w1', { toUserId: 'fantasma', items }), code('not-found'));
  await assert.rejects(OPS.registerTransfer(deps, 'w1', { items }), code('invalid-argument'));
  await assert.rejects(OPS.registerTransfer(deps, 'w1', { toUserId: 'w2', items: [{ productId: 'p1', quantity: 99 }] }), code('failed-precondition'));
  assert.equal(txs(store).length, 0);
  assert.equal(qty(store, 'w2', 'p1'), 10);
});

/* ---------------- reposición semanal ---------------- */

async function twoWeeksOfConsumption() {
  const s = setup();
  clock = at('2026-09-29T10:00:00+02:00'); // semana del 28 sep
  await OPS.registerConsumption(s.deps, 'w1', { note: 'WO-A', items: [{ productId: 'p1', quantity: 3 }] });
  clock = at('2026-10-06T10:00:00+02:00'); // semana del 5 oct
  await OPS.registerConsumption(s.deps, 'w1', { note: 'WO-B', items: [{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 4 }] });
  clock = at('2026-10-14T10:00:00+02:00'); // miércoles de la semana del 12 oct
  await OPS.registerConsumption(s.deps, 'w1', { note: 'WO-C', items: [{ productId: 'p2', quantity: 1 }] });
  return s;
}
const W0 = at('2026-09-28T00:00:00+02:00');
const W1 = at('2026-10-05T00:00:00+02:00');
const W2 = at('2026-10-12T00:00:00+02:00');

test('semanal: repone solo semanas cerradas y deja intacto lo gastado esta semana', async () => {
  const { deps, store } = await twoWeeksOfConsumption();
  const before = qty(store, 'w1', 'p1');
  const r = await OPS.registerWeekly(deps, 'w1', { weeks: [W0, W1], got: { p1: 5, p2: 4 } }); // p1: 3 + 2 = 5
  assert.deepEqual(r, { ok: true, units: 9 });
  assert.equal(qty(store, 'w1', 'p1'), before + 5);
  const rows = txs(store);
  assert.equal(rows.filter((t) => t.type === 'restock' && t.kind === 'weekly').length, 2);
  assert.equal(rows.filter((t) => t.type !== 'restock' && t.deliveryStatus === 'pending').length, 1); // WO-C
  const wc = rows.find((t) => t.note === 'WO-C');
  assert.equal(wc?.deliveryStatus, 'pending');
  assert.equal(wc?.deliveredQty, 0);
  const rs = rows.filter((t) => t.type === 'restock');
  assert.ok(rs.every((t) => t.missing === 0));
  assert.match(rs[0].note, /Reposición semanal · sem 40, 41/);
});

test('semanal: recoger menos de lo pedido deja el resto pendiente y se ofrece de nuevo', async () => {
  const { deps, store } = await twoWeeksOfConsumption();
  await OPS.registerWeekly(deps, 'w1', { weeks: [W0, W1], got: { p1: 4 } }); // pedidos 5
  const pend = txs(store).filter((t) => t.type !== 'restock' && t.deliveryStatus === 'pending' && t.weekStart < W2);
  assert.equal(pend.reduce((a, t) => a + (t.quantity - t.deliveredQty), 0), 1 + 4); // 1 de p1 + 4 de p2
  const restock = txs(store).find((t) => t.type === 'restock');
  assert.equal(restock?.missing, 1);
  assert.equal(restock?.quantity, 4);
  // reparto de más antigua a más reciente: la semana del 28 sep (3) completa y 1 de la del 5 oct
  const a = txs(store).find((t) => t.note === 'WO-A');
  assert.equal(a?.deliveryStatus, 'delivered');
  assert.equal(a?.deliveredQty, 3);
  // segunda reposición: lo que faltaba
  const r2 = await OPS.registerWeekly(deps, 'w1', { weeks: [W1], got: { p1: 1, p2: 4 } });
  assert.deepEqual(r2, { ok: true, units: 5 });
  assert.equal(txs(store).filter((t) => t.type !== 'restock' && t.deliveryStatus === 'pending').length, 1); // solo WO-C
});

test('semanal: no se puede reponer la semana en curso ni más de lo pendiente', async () => {
  const { deps, store } = await twoWeeksOfConsumption();
  const stock0 = qty(store, 'w1', 'p2');
  await assert.rejects(OPS.registerWeekly(deps, 'w1', { weeks: [W2], got: { p2: 1 } }), code('failed-precondition'));
  await assert.rejects(OPS.registerWeekly(deps, 'w1', { weeks: [W0], got: { p1: 4 } }), code('failed-precondition')); // pedidos 3
  await assert.rejects(OPS.registerWeekly(deps, 'w1', { weeks: [W0], got: { p2: 1 } }), code('failed-precondition')); // p2 no pendiente en esa semana
  await assert.rejects(OPS.registerWeekly(deps, 'w1', { weeks: [W0 + 3_600_000], got: { p1: 1 } }), code('invalid-argument')); // no es lunes 00:00
  await assert.rejects(OPS.registerWeekly(deps, 'w1', { weeks: [W0], got: {} }), code('failed-precondition'));
  await assert.rejects(OPS.registerWeekly(deps, 'w1', { weeks: [], got: { p1: 1 } }), code('invalid-argument'));
  await assert.rejects(OPS.registerWeekly(deps, 'w1', { weeks: [W0], got: { p1: 1.5 } }), code('invalid-argument'));
  assert.equal(qty(store, 'w1', 'p2'), stock0);
});

test('semanal: un técnico no puede reponer lo pendiente de otro', async () => {
  const { deps } = await twoWeeksOfConsumption();
  await assert.rejects(OPS.registerWeekly(deps, 'w2', { weeks: [W0], got: { p1: 1 } }), code('failed-precondition'));
});

test('semanal: un lunes a las 00:30 locales ya cuenta como semana nueva (no se puede reponer)', async () => {
  const s = setup();
  clock = at('2026-10-11T23:30:00+02:00'); // domingo noche
  await OPS.registerConsumption(s.deps, 'w1', { note: 'WO-D', items: [{ productId: 'p1', quantity: 1 }] });
  clock = at('2026-10-12T00:30:00+02:00'); // lunes de madrugada
  await assert.rejects(OPS.registerWeekly(s.deps, 'w1', { weeks: [W2], got: { p1: 1 } }), code('failed-precondition'));
  const r = await OPS.registerWeekly(s.deps, 'w1', { weeks: [W1], got: { p1: 1 } });
  assert.equal(r.units, 1);
});

/* ---------------- almacén ---------------- */

test('almacén: marcar como entregado repone el stock y no se puede repetir', async () => {
  const { deps, store } = await twoWeeksOfConsumption();
  const ids = txs(store).filter((t) => t.type !== 'restock' && t.weekStart < W2).map((t) => t.id);
  const before = qty(store, 'w1', 'p1');
  const r = await OPS.adminDeliver(deps, 'admin1', { txIds: ids });
  assert.equal(r.delivered, ids.length);
  assert.equal(r.skipped, 0);
  assert.equal(qty(store, 'w1', 'p1'), before + 5);
  assert.equal(txs(store).filter((t) => t.type !== 'restock' && t.weekStart < W2 && t.deliveryStatus === 'pending').length, 0);
  await assert.rejects(OPS.adminDeliver(deps, 'admin1', { txIds: ids }), code('failed-precondition'));
  assert.equal(qty(store, 'w1', 'p1'), before + 5);
});

test('almacén: entrega tras una reposición parcial solo repone lo que faltaba', async () => {
  const { deps, store } = await twoWeeksOfConsumption();
  await OPS.registerWeekly(deps, 'w1', { weeks: [W0, W1], got: { p1: 4 } });
  const before = qty(store, 'w1', 'p1');
  const ids = txs(store).filter((t) => t.type !== 'restock' && t.deliveryStatus === 'pending' && t.weekStart < W2).map((t) => t.id);
  await OPS.adminDeliver(deps, 'admin1', { txIds: ids });
  assert.equal(qty(store, 'w1', 'p1'), before + 1);
});

test('almacén: solo el administrador entrega; los técnicos no', async () => {
  const { deps, store } = await twoWeeksOfConsumption();
  const ids = txs(store).filter((t) => t.type !== 'restock').map((t) => t.id);
  await assert.rejects(OPS.adminDeliver(deps, 'w1', { txIds: ids }), code('permission-denied'));
  await assert.rejects(OPS.adminDeliver(deps, 'admin1', { txIds: [] }), code('invalid-argument'));
  await assert.rejects(OPS.adminDeliver(deps, 'admin1', { txIds: Array.from({ length: 151 }, (_, i) => `x${i}`) }), code('invalid-argument'));
});

test('almacén: las líneas de un usuario eliminado no se entregan ni crean stock huérfano', async () => {
  const { deps, store } = await twoWeeksOfConsumption();
  const ids = txs(store).filter((t) => t.type !== 'restock').map((t) => t.id);
  store.remove('users/w1');
  store.remove('stock/w1');
  const r = await OPS.adminDeliver(deps, 'admin1', { txIds: ids }); // todo es de w1: nada se entrega
  assert.equal(r.delivered, 0);
  assert.ok(r.skipped > 0);
  assert.equal(store.get('stock/w1'), undefined);
  assert.equal(txs(store).filter((t) => t.type === 'restock').length, 0);
  assert.ok(txs(store).filter((t) => t.type !== 'restock').every((t) => t.deliveryStatus === 'pending'));
});

/* ---------------- usuarios ---------------- */

test('crear usuario: cuenta con email interno, ficha y stock inicial del rol', async () => {
  const { deps, store, fakeAuth } = setup();
  const r = await OPS.createUser(deps, 'admin1', { employeeCode: '551488', name: 'Ana Pérez', password: 'secreta1', role: 'worker', department: 'Instalaciones', territory: 'Sur', technicianRoleId: 'r1' });
  const u = fakeAuth.users.get(r.uid);
  assert.equal(u?.email, '551488@stock.local');
  assert.equal(u?.password, 'secreta1');
  assert.deepEqual(store.get(`users/${r.uid}`), { employeeCode: '551488', name: 'Ana Pérez', role: 'worker', department: 'Instalaciones', territory: 'Sur', technicianRoleId: 'r1', zona: '', createdAt: clock });
  assert.equal(qty(store, r.uid, 'p1'), 10);
  assert.equal(qty(store, r.uid, 'p2'), 5);
  assert.equal(store.get(`stock/${r.uid}`)?.userId, r.uid);
  // y ese técnico ya puede operar
  await OPS.registerConsumption(deps, r.uid, { note: 'WO-9', items: [{ productId: 'p1', quantity: 1 }] });
  assert.equal(qty(store, r.uid, 'p1'), 9);
});

test('crear usuario: el código es único sin distinguir mayúsculas, y se validan los datos', async () => {
  const { deps, fakeAuth } = setup();
  const base = { name: 'Ana', password: 'secreta1', role: 'worker', department: '', territory: '', technicianRoleId: 'r1' };
  await OPS.createUser(deps, 'admin1', { ...base, employeeCode: 'AB123' });
  await assert.rejects(OPS.createUser(deps, 'admin1', { ...base, employeeCode: 'ab123' }), code('already-exists'));
  await assert.rejects(OPS.createUser(deps, 'admin1', { ...base, employeeCode: 'a b' }), code('invalid-argument'));
  await assert.rejects(OPS.createUser(deps, 'admin1', { ...base, employeeCode: '12' }), code('invalid-argument'));
  await assert.rejects(OPS.createUser(deps, 'admin1', { ...base, employeeCode: '777777', password: '123' }), code('invalid-argument'));
  await assert.rejects(OPS.createUser(deps, 'admin1', { ...base, employeeCode: '777777', name: ' ' }), code('invalid-argument'));
  await assert.rejects(OPS.createUser(deps, 'admin1', { ...base, employeeCode: '777777', role: 'jefe' }), code('invalid-argument'));
  await assert.rejects(OPS.createUser(deps, 'admin1', { ...base, employeeCode: '777777', technicianRoleId: 'rX' }), code('not-found'));
  await assert.rejects(OPS.createUser(deps, 'w1', { ...base, employeeCode: '777777' }), code('permission-denied'));
  assert.ok(![...fakeAuth.users.values()].some((u) => u.email.startsWith('777777')));
});

test('crear usuario: si falla Firestore se elimina la cuenta recién creada', async () => {
  const { deps, fakeDb, fakeAuth } = setup();
  const count = fakeAuth.users.size;
  fakeDb.runTransaction = async () => {
    throw new Error('Firestore caído');
  };
  await assert.rejects(OPS.createUser(deps, 'admin1', { employeeCode: '888888', name: 'X', password: 'secreta1', role: 'worker', department: '', territory: '', technicianRoleId: 'r1' }), /Firestore caído/);
  assert.equal(fakeAuth.users.size, count);
});

test('crear administrador: sin stock', async () => {
  const { deps, store } = setup();
  const r = await OPS.createUser(deps, 'admin1', { employeeCode: 'adm2', name: 'Otra', password: 'secreta1', role: 'admin', department: 'Almacén' });
  assert.equal(store.get(`stock/${r.uid}`), undefined);
  assert.equal(store.get(`users/${r.uid}`)?.technicianRoleId, '');
});

test('editar usuario: cambiar el código actualiza el email de acceso', async () => {
  const { deps, store, fakeAuth } = setup();
  await OPS.updateUser(deps, 'admin1', { uid: 'w1', employeeCode: '2001', name: 'Carlos R.' });
  assert.equal(fakeAuth.users.get('w1')?.email, '2001@stock.local');
  assert.equal(fakeAuth.users.get('w1')?.displayName, 'Carlos R.');
  assert.equal(store.get('users/w1')?.employeeCode, '2001');
  await assert.rejects(OPS.updateUser(deps, 'admin1', { uid: 'w2', employeeCode: '2001' }), code('already-exists'));
  await assert.rejects(OPS.updateUser(deps, 'w1', { uid: 'w2', name: 'x' }), code('permission-denied'));
});

test('editar usuario: no se puede quitar el último administrador', async () => {
  const { deps } = setup();
  await assert.rejects(OPS.updateUser(deps, 'admin1', { uid: 'admin1', role: 'worker', technicianRoleId: 'r1' }), code('failed-precondition'));
});

test('contraseña: se restablece y se cierran las sesiones abiertas', async () => {
  const { deps, fakeAuth } = setup();
  await OPS.setPassword(deps, 'admin1', { uid: 'w1', password: 'nueva-clave' });
  assert.equal(fakeAuth.users.get('w1')?.password, 'nueva-clave');
  assert.equal(fakeAuth.users.get('w1')?.tokensRevoked, 1);
  await assert.rejects(OPS.setPassword(deps, 'admin1', { uid: 'w1', password: '123' }), code('invalid-argument'));
  await assert.rejects(OPS.setPassword(deps, 'w2', { uid: 'w1', password: 'nueva-clave' }), code('permission-denied'));
  await assert.rejects(OPS.setPassword(deps, 'admin1', { uid: 'fantasma', password: 'nueva-clave' }), code('not-found'));
});

test('eliminar usuario: borra cuenta, ficha y stock; conserva el historial; protege al propio admin', async () => {
  const { deps, store, fakeAuth } = setup();
  await OPS.registerConsumption(deps, 'w1', { note: 'WO-1', items: [{ productId: 'p1', quantity: 1 }] });
  await OPS.deleteUser(deps, 'admin1', { uid: 'w1' });
  assert.equal(fakeAuth.users.has('w1'), false);
  assert.equal(store.get('users/w1'), undefined);
  assert.equal(store.get('stock/w1'), undefined);
  assert.equal(txs(store).length, 1);
  await assert.rejects(OPS.deleteUser(deps, 'admin1', { uid: 'admin1' }), code('failed-precondition'));
  await assert.rejects(OPS.deleteUser(deps, 'admin1', { uid: 'w1' }), code('not-found'));
  await assert.rejects(OPS.deleteUser(deps, 'w2', { uid: 'admin1' }), code('permission-denied'));
  // con un segundo admin, el primero sí puede ser eliminado por el segundo
  const r = await OPS.createUser(deps, 'admin1', { employeeCode: 'adm2', name: 'Otra', password: 'secreta1', role: 'admin', department: '' });
  await OPS.deleteUser(deps, r.uid, { uid: 'admin1' });
  assert.equal(store.get('users/admin1'), undefined);
});

/* ---------------- ajuste manual ---------------- */

test('ajuste: el almacén fija la cantidad real y deja un movimiento con la diferencia, sin pendientes', async () => {
  clock = at('2026-10-06T10:00:00+02:00');
  const { deps, store } = setup();
  const r = await OPS.adjustStock(deps, 'admin1', { userId: 'w1', productId: 'p1', quantity: 4, note: ' inventario ' });
  assert.deepEqual(r, { ok: true, delta: -6 });
  assert.equal(qty(store, 'w1', 'p1'), 4);
  const t = txs(store).filter((x: any) => x.kind === 'adjust');
  assert.equal(t.length, 1);
  assert.equal((t[0] as any).quantity, -6);
  assert.equal((t[0] as any).note, 'inventario');
  assert.equal((t[0] as any).deliveryStatus, 'delivered');
  const up = await OPS.adjustStock(deps, 'admin1', { userId: 'w1', productId: 'p3', quantity: 2, note: 'alta inicial' });
  assert.equal(up.delta, 2);
  assert.equal(qty(store, 'w1', 'p3'), 2);
});

test('ajuste: valida permisos, motivo, cantidad y que haya cambio', async () => {
  const { deps } = setup();
  await assert.rejects(OPS.adjustStock(deps, 'w1', { userId: 'w1', productId: 'p1', quantity: 1, note: 'x' }), code('permission-denied'));
  await assert.rejects(OPS.adjustStock(deps, 'admin1', { userId: 'w1', productId: 'p1', quantity: 1, note: '  ' }), code('invalid-argument'));
  await assert.rejects(OPS.adjustStock(deps, 'admin1', { userId: 'w1', productId: 'p1', quantity: -1, note: 'x' }), code('invalid-argument'));
  await assert.rejects(OPS.adjustStock(deps, 'admin1', { userId: 'w1', productId: 'p1', quantity: 1.5, note: 'x' }), code('invalid-argument'));
  await assert.rejects(OPS.adjustStock(deps, 'admin1', { userId: 'w1', productId: 'p1', quantity: 10, note: 'x' }), code('failed-precondition'));
  await assert.rejects(OPS.adjustStock(deps, 'admin1', { userId: 'admin1', productId: 'p1', quantity: 3, note: 'x' }), code('invalid-argument'));
  await assert.rejects(OPS.adjustStock(deps, 'admin1', { userId: 'w1', productId: 'nope', quantity: 3, note: 'x' }), code('not-found'));
});

/* ---------------- reset a stock base ---------------- */

test('reset: deja al técnico exactamente en su stock base y anota cada diferencia', async () => {
  clock = at('2026-10-06T10:00:00+02:00');
  const { deps, store } = setup();
  store.put('stock/w1', { userId: 'w1', items: { p1: { currentStock: 3 }, p2: { currentStock: 9 }, p3: { currentStock: 2 } } });
  const r = await OPS.resetToBase(deps, 'admin1', { userId: 'w1' });
  assert.equal(r.changed, 3);
  assert.equal(qty(store, 'w1', 'p1'), 10); // base 10
  assert.equal(qty(store, 'w1', 'p2'), 5); // base 5, tenía 9
  assert.equal(qty(store, 'w1', 'p3'), 0); // no está en su base
  const t = txs(store).filter((x: any) => x.kind === 'reset') as any[];
  assert.equal(t.length, 3);
  assert.ok(t.every((x) => x.note === 'Reset stock base' && x.deliveryStatus === 'delivered'));
  assert.deepEqual(t.map((x) => x.quantity).sort((a, b) => a - b), [-4, -2, 7]);
  await assert.rejects(OPS.resetToBase(deps, 'admin1', { userId: 'w1' }), code('failed-precondition'));
});

test('reset: solo el almacén, solo técnicos', async () => {
  const { deps } = setup();
  await assert.rejects(OPS.resetToBase(deps, 'w1', { userId: 'w1' }), code('permission-denied'));
  await assert.rejects(OPS.resetToBase(deps, 'admin1', { userId: 'admin1' }), code('invalid-argument'));
  await assert.rejects(OPS.resetToBase(deps, 'admin1', {}), code('invalid-argument'));
});

test('consumo: guarda el tipo reparación/conexión a red y rechaza tipos no válidos', async () => {
  const { deps, store } = setup();
  await OPS.registerConsumption(deps, 'w1', { note: 'WO-1', kind: 'repair', items: [{ productId: 'p1', quantity: 1 }] });
  await OPS.registerConsumption(deps, 'w1', { note: 'WO-2', kind: 'network', items: [{ productId: 'p1', quantity: 1 }] });
  await OPS.registerConsumption(deps, 'w1', { note: 'WO-3', items: [{ productId: 'p1', quantity: 1 }] });
  const k = Object.fromEntries(txs(store).map((t) => [t.note, t.kind]));
  assert.deepEqual(k, { 'WO-1': 'repair', 'WO-2': 'network', 'WO-3': '' });
  await assert.rejects(OPS.registerConsumption(deps, 'w1', { note: 'WO-4', kind: 'otro', items: [{ productId: 'p1', quantity: 1 }] }), code('invalid-argument'));
  assert.equal(qty(store, 'w1', 'p1'), 7);
});

test('consumo: acepta el tipo instalación', async () => {
  const { deps, store } = setup();
  await OPS.registerConsumption(deps, 'w1', { note: 'WO-9', kind: 'install', items: [{ productId: 'p1', quantity: 1 }] });
  assert.equal(txs(store)[0].kind, 'install');
});

test('devolver a almacén: resta stock, no es consumo ni pendiente y no deja devolver de más', async () => {
  const { deps, store } = setup();
  const r = await OPS.returnToWarehouse(deps, 'w1', { note: 'sobra', items: [{ productId: 'p1', quantity: 3 }] });
  assert.deepEqual(r, { ok: true, lines: 1 });
  assert.equal(qty(store, 'w1', 'p1'), 7);
  const t = txs(store)[0];
  assert.equal(t.type, 'restock');
  assert.equal(t.kind, 'return');
  assert.equal(t.quantity, 3);
  assert.notEqual(t.deliveryStatus, 'pending');
  await assert.rejects(OPS.returnToWarehouse(deps, 'w1', { items: [{ productId: 'p1', quantity: 99 }] }), code('failed-precondition'));
  await assert.rejects(OPS.returnToWarehouse(deps, 'admin1', { items: [{ productId: 'p1', quantity: 1 }] }), code('permission-denied'));
  assert.equal(qty(store, 'w1', 'p1'), 7);
});

/* ---------------- roles: admin / almacen / worker ---------------- */

function withAlmacen() {
  const s = setup();
  s.store.put('users/alm1', { employeeCode: 'luis', name: 'Luis', role: 'almacen', department: 'Almacén', territory: '', technicianRoleId: '' });
  return s;
}

test('roles: almacen hace lo mismo que admin en el panel (entregas, ajustes, reset, equipo)', async () => {
  const { deps, store } = withAlmacen();
  await OPS.registerConsumption(deps, 'w1', { note: 'WO-1', items: [{ productId: 'p1', quantity: 2 }] });
  const ids = txs(store).map((t) => t.id);
  assert.equal((await OPS.adminDeliver(deps, 'alm1', { txIds: ids })).delivered, ids.length);
  await OPS.adjustStock(deps, 'alm1', { userId: 'w1', productId: 'p1', quantity: 4, note: 'inventario' });
  assert.equal(qty(store, 'w1', 'p1'), 4);
  await OPS.resetToBase(deps, 'alm1', { userId: 'w1' });
  const r = await OPS.createUser(deps, 'alm1', { employeeCode: 'nuevo1', name: 'Nuevo', password: 'secreta1', role: 'almacen', department: '' });
  assert.equal(r.ok, true);
});

test('roles: almacen no puede crear administradores ni ascenderse, ni tocar a un administrador', async () => {
  const { deps, store } = withAlmacen();
  await assert.rejects(OPS.createUser(deps, 'alm1', { employeeCode: 'adm9', name: 'X', password: 'secreta1', role: 'admin', department: '' }), code('permission-denied'));
  await assert.rejects(OPS.updateUser(deps, 'alm1', { uid: 'alm1', role: 'admin' }), code('permission-denied'));
  await assert.rejects(OPS.updateUser(deps, 'alm1', { uid: 'admin1', name: 'Hackeado' }), code('permission-denied'));
  await assert.rejects(OPS.setPassword(deps, 'alm1', { uid: 'admin1', password: 'otra1234' }), code('permission-denied'));
  await assert.rejects(OPS.deleteUser(deps, 'alm1', { uid: 'admin1' }), code('permission-denied'));
  assert.equal(store.get('users/admin1')?.name, 'Marta');
  // sí puede gestionar técnicos
  await OPS.setPassword(deps, 'alm1', { uid: 'w1', password: 'nueva1234' });
});

test('roles: admin puede crear administradores y un técnico no puede nada de almacén', async () => {
  const { deps } = withAlmacen();
  assert.equal((await OPS.createUser(deps, 'admin1', { employeeCode: 'adm9', name: 'X', password: 'secreta1', role: 'admin', department: '' })).ok, true);
  await assert.rejects(OPS.adjustStock(deps, 'w1', { userId: 'w1', productId: 'p1', quantity: 1, note: 'x' }), code('permission-denied'));
  await assert.rejects(OPS.createUser(deps, 'w1', { employeeCode: 'zz1', name: 'X', password: 'secreta1', role: 'worker', department: '' }), code('permission-denied'));
});

test('roles: un almacen no cuenta como "otro administrador" al borrar al último admin', async () => {
  const { deps } = withAlmacen();
  await assert.rejects(OPS.deleteUser(deps, 'admin1', { uid: 'admin1' }), code('failed-precondition')); // a sí mismo
  await assert.rejects(OPS.updateUser(deps, 'admin1', { uid: 'admin1', role: 'almacen' }), code('failed-precondition'));
});

test('zona (calendario): solo un administrador la asigna o la cambia; valores no válidos se rechazan', async () => {
  const { deps, store } = withAlmacen();
  const base = { employeeCode: 'zona01', name: 'Zona Uno', password: 'secreta1', role: 'worker', department: '', territory: '', technicianRoleId: 'r1' };
  await assert.rejects(OPS.createUser(deps, 'alm1', { ...base, zona: 'Huelva' }), code('permission-denied'));
  await assert.rejects(OPS.createUser(deps, 'admin1', { ...base, zona: 'Marte' }), code('invalid-argument'));
  const r = await OPS.createUser(deps, 'admin1', { ...base, zona: 'Huelva' });
  assert.equal(store.get(`users/${r.uid}`)?.zona, 'Huelva');
  // almacen puede editar otros datos sin tocar la zona, pero no cambiarla
  await OPS.updateUser(deps, 'alm1', { uid: r.uid, name: 'Zona Dos' });
  assert.equal(store.get(`users/${r.uid}`)?.zona, 'Huelva');
  await assert.rejects(OPS.updateUser(deps, 'alm1', { uid: r.uid, zona: 'Sevilla Este' }), code('permission-denied'));
  await OPS.updateUser(deps, 'admin1', { uid: r.uid, zona: 'Sevilla Este' });
  assert.equal(store.get(`users/${r.uid}`)?.zona, 'Sevilla Este');
});
