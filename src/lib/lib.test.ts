import test from 'node:test';
import assert from 'node:assert/strict';
import type { Product, TechRole, Tx } from '../types';
import { groupTx, groupSummary, groupTitle, typeLabel } from './history';
import { surplusFor, surplusReasons, surplusText } from './stock';
import { parseCatalogCsv, parseCsv } from './csv';
import { groupByFolder, folderNames, byPriority } from './catalog';

const T = (s: string): number => Date.parse(s);
let n = 0;
const tx = (o: Partial<Tx>): Tx => ({
  id: `t${++n}`,
  type: 'consumption',
  kind: '',
  userId: 'u1',
  userName: 'Carlos',
  productId: 'p1',
  productName: 'Conector',
  productCode: 'CON-1',
  quantity: 1,
  note: '',
  deliveredQty: 0,
  deliveryStatus: 'pending',
  deliveryDate: null,
  missing: 0,
  counterpartId: null,
  counterpartName: null,
  timestamp: T('2026-10-07T10:00:00+02:00'),
  weekStart: T('2026-10-05T00:00:00+02:00'),
  ...o,
});

test('historial: los consumos de una misma Work Order se agrupan y se ordenan de más reciente a más antiguo', () => {
  const list = [
    tx({ note: 'WO-1', productCode: 'B', quantity: 2, timestamp: T('2026-10-06T09:00:00+02:00') }),
    tx({ note: 'WO-1', productCode: 'A', quantity: 1, timestamp: T('2026-10-06T09:05:00+02:00') }),
    tx({ note: 'WO-2', timestamp: T('2026-10-08T09:00:00+02:00') }),
    tx({ note: 'WO-0', timestamp: T('2026-10-01T09:00:00+02:00') }),
  ];
  const g = groupTx(list);
  assert.deepEqual(g.map((x) => x.note), ['WO-2', 'WO-1', 'WO-0']);
  assert.equal(g[1].items.length, 2);
  assert.deepEqual(g[1].items.map((t) => t.productCode), ['A', 'B']);
  assert.equal(groupSummary(g[1]).text, '-3 uds (2 productos)');
  assert.equal(groupTitle(g[1]), 'WO-1');
});

test('historial: misma Work Order de técnicos distintos no se mezcla', () => {
  const g = groupTx([tx({ note: 'WO-1' }), tx({ note: 'WO-1', userId: 'u2', userName: 'Iván' })]);
  assert.equal(g.length, 2);
});

test('historial: sin Work Order se agrupa por día y tipo; reposiciones suman', () => {
  const g = groupTx([
    tx({ type: 'restock', kind: 'weekly', note: 'Reposición semanal', timestamp: T('2026-10-12T08:00:00+02:00') }),
    tx({ type: 'restock', kind: 'weekly', note: 'Reposición semanal', productCode: 'Z', timestamp: T('2026-10-12T08:00:01+02:00') }),
    tx({ type: 'restock', kind: 'extra', note: '', timestamp: T('2026-10-12T09:00:00+02:00') }),
  ]);
  assert.equal(g.length, 2);
  assert.equal(groupSummary(g.find((x) => x.kind === 'weekly')!).text, '+2 uds (2 productos)');
  assert.equal(typeLabel(g.find((x) => x.kind === 'extra')!), 'Material extra');
  assert.equal(groupTitle(g.find((x) => x.kind === 'extra')!), 'Material extra');
});

test('historial: un traspaso resta a quien lo da y suma a quien lo recibe', () => {
  const [g] = groupTx([tx({ type: 'transfer', userId: 'u1', counterpartId: 'u2', counterpartName: 'Iván' })]);
  assert.equal(groupSummary(g, 'u1').text, '-1 ud (1 producto)');
  assert.equal(groupSummary(g, 'u2').text, '+1 ud (1 producto)');
  assert.equal(groupTitle(g, 'u1'), 'Traspaso a Iván');
  assert.equal(groupTitle(g, 'u2'), 'Traspaso de Carlos');
});

/* ---------- exceso sobre el stock base ---------- */

const products: Product[] = [
  { id: 'p1', code: 'CON-1', name: 'Conector', category: 'Conectores' },
  { id: 'p2', code: 'CAB-1', name: 'Cable', category: 'Cable' },
];
const role: TechRole = { id: 'r1', name: 'Instalador', baseStock: { p1: 10 } };
const NOW = T('2026-10-14T10:00:00+02:00');

test('exceso: detecta que viene de un traspaso y de material extra', () => {
  const txs = [
    tx({ type: 'transfer', userId: 'u1', userName: 'Carlos Ruiz', counterpartId: 'u3', quantity: 3, timestamp: T('2026-10-12T10:00:00+02:00') }),
    tx({ type: 'restock', kind: 'extra', userId: 'u3', quantity: 1, timestamp: T('2026-10-13T10:00:00+02:00') }),
  ];
  const items = { p1: { currentStock: 14 }, p2: { currentStock: 2 } };
  const list = surplusFor(products, items, role, txs, 'u3', NOW);
  const p1 = list.find((x) => x.product.id === 'p1')!;
  assert.equal(p1.extra, 4);
  assert.equal(p1.reasons.length, 2);
  assert.match(surplusText(p1), /Carlos Ruiz te traspasó 3/);
  const p2 = list.find((x) => x.product.id === 'p2')!; // no está en su base: todo lo que tiene es "de más"
  assert.equal(p2.base, 0);
  assert.equal(p2.extra, 2);
});

test('exceso: sin superar la base no hay aviso', () => {
  assert.deepEqual(surplusFor(products, { p1: { currentStock: 10 } }, role, [], 'u3', NOW), []);
});

test('exceso proyectado al reponer: solo los productos que se reponen', () => {
  const items = { p1: { currentStock: 8 }, p2: { currentStock: 5 } };
  const r = surplusFor(products, items, role, [], 'u3', NOW, { p1: 4 });
  assert.equal(r.length, 1);
  assert.equal(r[0].current, 12);
  assert.equal(r[0].extra, 2);
});

test('exceso: los traspasos viejos (más de 45 días) no se citan', () => {
  const old = tx({ type: 'transfer', counterpartId: 'u3', quantity: 3, timestamp: T('2026-08-01T10:00:00+02:00') });
  assert.deepEqual(surplusReasons([old], 'u3', 'p1', 3, NOW), []);
});

/* ---------- CSV del catálogo ---------- */

test('csv: detecta separador ; , y tabulador, comillas y cabecera', () => {
  const a = parseCatalogCsv('Código;Nombre;Carpeta\nCON-1;Conector SC/APC;Conectores\nCAB-1;"Cable; 5 m";Cable\n');
  assert.deepEqual(a.rows, [
    { code: 'CON-1', name: 'Conector SC/APC', folder: 'Conectores' },
    { code: 'CAB-1', name: 'Cable; 5 m', folder: 'Cable' },
  ]);
  assert.deepEqual(a.errors, []);
  const b = parseCatalogCsv('CON-1,Conector,Conectores\r\nCAB-1,Cable,Cable');
  assert.equal(b.rows.length, 2);
  const c = parseCatalogCsv('CON-1\tConector\tConectores');
  assert.equal(c.rows.length, 1);
});

test('csv: informa de líneas incompletas y códigos repetidos', () => {
  const r = parseCatalogCsv('A1;Uno;X\nA2;;X\nA1;Otra vez;X\n');
  assert.equal(r.rows.length, 1);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0], /Línea 2/);
  assert.match(r.errors[1], /Línea 3/);
});

test('csv: comillas escapadas y BOM', () => {
  assert.deepEqual(parseCsv('﻿a;"di ""hola""";c'), [['a', 'di "hola"', 'c']]);
});

test('catálogo: agrupa por carpeta ordenadas y mantiene las carpetas vacías en la lista de nombres', () => {
  const g = groupByFolder([
    { id: '1', code: 'B2', name: 'x', category: 'Zeta' },
    { id: '2', code: 'A1', name: 'y', category: 'álgebra' },
    { id: '3', code: 'A0', name: 'z', category: 'Zeta' },
  ]);
  assert.deepEqual(g.map((x) => x.name), ['álgebra', 'Zeta']);
  assert.deepEqual(g[1].items.map((p) => p.code), ['A0', 'B2']);
  assert.deepEqual(folderNames([{ id: 'f', name: 'Vacía' }], [{ id: '1', code: 'A', name: 'x', category: 'Cable' }]), ['Cable', 'Vacía']);
});

test('prioridad: dentro de cada grupo van primero los que tienen orden, luego el resto por código', () => {
  const p = (id: string, code: string, priority: Product['priority'], order?: number): Product => ({ id, code, name: id, category: 'X', priority, order });
  const groups = byPriority([p('a', 'A-1', 'muy-habitual', 3), p('b', 'B-1', 'muy-habitual', 1), p('c', 'C-1', 'muy-habitual'), p('d', 'D-1', 'habitual'), p('e', 'E-1', 'muy-habitual', 2), p('f', 'A-0', 'muy-habitual')]);
  assert.deepEqual(groups[0].items.map((x) => x.id), ['b', 'e', 'a', 'f', 'c']);
  assert.equal(groups[1].priority, 'habitual');
  assert.deepEqual(groups[1].items.map((x) => x.id), ['d']);
});
