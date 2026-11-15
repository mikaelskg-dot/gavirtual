import test from 'node:test';
import assert from 'node:assert/strict';
import { assignmentDays, closingFor, currentAssignment, fmtPlate, historyOf, isPlate, itvState, nextAssignment, normPlate, type Asignacion } from './fleet';

const as = (p: Partial<Asignacion> & Pick<Asignacion, 'id' | 'desde'>): Asignacion => ({ vehiculoId: 'v1', tipo: 'nombre', nombre: 'X', ...p });

test('matrícula: se normaliza y se valida', () => {
  assert.equal(normPlate(' 1234 abc '), '1234ABC');
  assert.equal(normPlate('se-1234-xy'), 'SE1234XY');
  assert.ok(isPlate('1234ABC'));
  assert.ok(!isPlate('12'));
  assert.ok(!isPlate('12 34'));
  assert.equal(fmtPlate('1234ABC'), '1234 ABC');
  assert.equal(fmtPlate('SE1234XY'), 'SE1234XY');
});

test('ITV: vencida, urgente (≤30), próxima (≤60), al día y sin fecha', () => {
  const t = '2026-10-31';
  assert.deepEqual(itvState('2026-10-30', t), { level: 'expired', days: -1 });
  assert.deepEqual(itvState('2026-10-31', t), { level: 'urgent', days: 0 });
  assert.deepEqual(itvState('2026-11-30', t), { level: 'urgent', days: 30 });
  assert.deepEqual(itvState('2026-12-01', t), { level: 'soon', days: 31 });
  assert.deepEqual(itvState('2026-12-30', t), { level: 'soon', days: 60 });
  assert.deepEqual(itvState('2026-12-31', t), { level: 'ok', days: 61 });
  assert.deepEqual(itvState(undefined, t), { level: 'none', days: null });
  assert.deepEqual(itvState('basura', t), { level: 'none', days: null });
});

test('asignación vigente: abierta, cerrada, futura y vehículo vacío', () => {
  const t = '2026-10-31';
  const list = [
    as({ id: 'a', desde: '2026-01-01', hasta: '2026-03-31', nombre: 'Ana' }),
    as({ id: 'b', desde: '2026-04-01', hasta: '2026-10-30', nombre: 'Beto' }),
    as({ id: 'c', desde: '2026-11-15', nombre: 'Carla' }),
  ];
  assert.equal(currentAssignment(list, 'v1', t), null); // vacío hoy
  assert.equal(currentAssignment(list, 'v1', '2026-02-01')?.nombre, 'Ana');
  assert.equal(currentAssignment(list, 'v1', '2026-10-30')?.nombre, 'Beto');
  assert.equal(currentAssignment(list, 'v1', '2026-12-01')?.nombre, 'Carla'); // abierta
  assert.equal(nextAssignment(list, 'v1', t)?.nombre, 'Carla');
  assert.equal(currentAssignment(list, 'otro', t), null);
  assert.deepEqual(historyOf(list, 'v1').map((x) => x.id), ['c', 'b', 'a']);
});

test('alta de una asignación: cierra el día anterior las que siguen abiertas o la solapan', () => {
  const list = [
    as({ id: 'a', desde: '2026-01-01', hasta: '2026-03-31' }),
    as({ id: 'b', desde: '2026-04-01' }), // abierta
    as({ id: 'c', desde: '2026-02-01', hasta: '2026-06-30' }), // solapa
    as({ id: 'd', desde: '2026-09-01' }), // empieza después: no se toca
    as({ id: 'x', vehiculoId: 'v2', desde: '2026-01-01' }), // otro vehículo
  ];
  assert.deepEqual(closingFor(list, 'v1', '2026-05-01'), [
    { id: 'b', hasta: '2026-04-30' },
    { id: 'c', hasta: '2026-04-30' },
  ]);
  assert.deepEqual(closingFor(list, 'v1', '2026-12-01').map((c) => c.id), ['b', 'd']);
});

test('días de una asignación', () => {
  assert.equal(assignmentDays({ desde: '2026-10-01', hasta: '2026-10-10' }, '2026-10-31'), 10);
  assert.equal(assignmentDays({ desde: '2026-10-01' }, '2026-10-31'), 31);
  assert.equal(assignmentDays({ desde: '2026-11-05' }, '2026-10-31'), 0);
});
