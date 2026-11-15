import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, clipToYear, eventsOfYear, isoWeekOfDate, dateAt, dayIndex, daysInYear, easterSunday, festivoMap, holidaysFor, isDate, isWeekend, outPerDay, vacationByWeek, guardCounts,
  provinciaDe, runs, suggestedNational, todayMadrid, vacationDaysUsed, weekdayIdx, type CalEvento, type CalFestivo,
} from './calendar';

const ev = (p: Partial<CalEvento> & Pick<CalEvento, 'userId' | 'tipo' | 'inicio' | 'fin'>): CalEvento => ({ id: Math.random().toString(36).slice(2), ...p });

test('fechas: validación, suma de días, año bisiesto y día de la semana', () => {
  assert.ok(isDate('2026-02-28'));
  assert.ok(!isDate('2026-02-30'));
  assert.ok(!isDate('26-1-1'));
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(daysInYear(2026), 365);
  assert.equal(daysInYear(2028), 366);
  assert.equal(weekdayIdx('2026-10-31'), 5); // sábado
  assert.ok(isWeekend('2026-11-01'));
  assert.ok(!isWeekend('2026-11-02'));
  assert.equal(dayIndex('2026-01-01', 2026), 0);
  assert.equal(dateAt(364, 2026), '2026-12-31');
});

test('hoy se calcula en Europe/Madrid (a las 23:30 UTC del 31 dic ya es 1 ene)', () => {
  assert.equal(todayMadrid(new Date('2026-12-31T23:30:00Z')), '2027-01-01');
  assert.equal(todayMadrid(new Date('2026-07-01T21:30:00Z')), '2026-07-01');
});

test('contador: días naturales de vacaciones del año, sin duplicar solapes ni contar otros años ni otros tipos', () => {
  const evs = [
    ev({ userId: 'a', tipo: 'vacaciones', estado: 'fija', inicio: '2026-08-01', fin: '2026-08-10' }), // 10
    ev({ userId: 'a', tipo: 'vacaciones', estado: 'flexible', inicio: '2026-08-08', fin: '2026-08-12' }), // solapa 3 → +2
    ev({ userId: 'a', tipo: 'vacaciones', estado: 'fija', inicio: '2025-12-30', fin: '2026-01-02' }), // 2 días de 2026
    ev({ userId: 'a', tipo: 'baja', inicio: '2026-03-01', fin: '2026-03-20' }),
    ev({ userId: 'b', tipo: 'vacaciones', estado: 'fija', inicio: '2026-05-01', fin: '2026-05-03' }),
  ];
  assert.equal(vacationDaysUsed(evs, 'a', 2026), 14);
  assert.equal(vacationDaysUsed(evs, 'a', 2025), 2);
  assert.equal(vacationDaysUsed(evs, 'b', 2026), 3);
});

test('personas fuera: vacaciones y bajas, cada persona una vez por día, solo las visibles', () => {
  const evs = [
    ev({ userId: 'a', tipo: 'vacaciones', estado: 'fija', inicio: '2026-01-05', fin: '2026-01-07' }),
    ev({ userId: 'a', tipo: 'baja', inicio: '2026-01-06', fin: '2026-01-06' }),
    ev({ userId: 'b', tipo: 'baja', inicio: '2026-01-06', fin: '2026-01-08' }),
    ev({ userId: 'a', tipo: 'guardia', inicio: '2026-01-09', fin: '2026-01-09' }),
    ev({ userId: 'c', tipo: 'vacaciones', estado: 'fija', inicio: '2026-01-06', fin: '2026-01-06' }),
  ];
  const out = outPerDay(evs, new Set(['a', 'b']), 2026);
  assert.deepEqual(out.slice(3, 9), [0, 1, 2, 2, 1, 0]); // 4 al 9 ene (el 6 'c' no cuenta: no está en userIds)
});

test('vacaciones por semana: personas y días, mes de cada semana y filtro de estado', () => {
  const users = [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Beto' }];
  const evs = [
    ev({ userId: 'a', tipo: 'vacaciones', estado: 'fija', inicio: '2026-01-30', fin: '2026-02-02' }), // vie 30 ene a lun 2 feb
    ev({ userId: 'b', tipo: 'vacaciones', estado: 'flexible', inicio: '2026-02-10', fin: '2026-02-11' }),
    ev({ userId: 'b', tipo: 'baja', inicio: '2026-03-01', fin: '2026-03-05' }), // las bajas no cuentan
    ev({ userId: 'a', tipo: 'guardia', inicio: '2026-04-01', fin: '2026-04-07' }), // ni las guardias
  ];
  const w = vacationByWeek(evs, users, 2026);
  assert.equal(w.length, 53); // 2026 empieza en jueves: 53 semanas ISO
  assert.equal(w[0].week, 1);
  assert.equal(w[0].month, 0);
  assert.equal(w[52].month, 11);
  const wk = (date: string) => w.find((x) => x.from <= dayIndex(date, 2026) && dayIndex(date, 2026) <= x.to)!;
  assert.deepEqual(wk('2026-01-30').people, [{ id: 'a', name: 'Ana', days: 3 }]); // 30 y 31 ene y 1 feb (domingo)
  assert.deepEqual(wk('2026-02-02').people, [{ id: 'a', name: 'Ana', days: 1 }]); // lunes 2 feb
  assert.deepEqual(wk('2026-02-10').people, [{ id: 'b', name: 'Beto', days: 2 }]);
  assert.equal(wk('2026-03-02').people.length, 0);
  assert.equal(wk('2026-04-01').people.length, 0);
  const fijas = vacationByWeek(evs, users, 2026, 'fija');
  assert.equal(fijas.reduce((t, x) => t + x.people.length, 0), 2); // Ana en 2 semanas
  const flex = vacationByWeek(evs, users, 2026, 'flexible');
  assert.equal(flex.reduce((t, x) => t + x.people.length, 0), 1);
  // las semanas cubren el año entero sin huecos ni solapes
  assert.equal(w.reduce((t, x) => t + (x.to - x.from + 1), 0), daysInYear(2026));
});

test('guardias por persona: hechas, programadas y días del año', () => {
  const evs = [
    ev({ userId: 'a', tipo: 'guardia', inicio: '2026-02-02', fin: '2026-02-08' }),
    ev({ userId: 'a', tipo: 'guardia', inicio: '2026-06-01', fin: '2026-06-07' }),
    ev({ userId: 'a', tipo: 'guardia', inicio: '2026-06-08', fin: '2026-06-14' }),
    ev({ userId: 'a', tipo: 'vacaciones', estado: 'fija', inicio: '2026-03-01', fin: '2026-03-10' }),
    ev({ userId: 'a', tipo: 'guardia', inicio: '2025-12-29', fin: '2026-01-04' }), // cruza de año
    ev({ userId: 'b', tipo: 'guardia', inicio: '2027-01-04', fin: '2027-01-10' }), // otro año
  ];
  const g = guardCounts(evs, ['a', 'b', 'c'], 2026, '2026-06-10');
  assert.deepEqual(g.get('a'), { done: 3, upcoming: 1, days: 4 + 7 + 7 + 7 });
  assert.deepEqual(g.get('b'), { done: 0, upcoming: 0, days: 0 });
  assert.deepEqual(g.get('c'), { done: 0, upcoming: 0, days: 0 });
});

test('festivos: el provincial solo afecta a su provincia; el nacional a todos (también sin zona)', () => {
  const fs: CalFestivo[] = [
    { id: '1', fecha: '2026-10-12', ambito: 'nacional', provincia: null, nombre: 'Fiesta Nacional' },
    { id: '2', fecha: '2026-06-03', ambito: 'provincial', provincia: 'Huelva', nombre: 'Local Huelva' },
  ];
  const m = festivoMap(fs);
  assert.equal(holidaysFor(m, '2026-10-12', null).length, 1);
  assert.equal(holidaysFor(m, '2026-06-03', provinciaDe('Huelva')).length, 1);
  assert.equal(holidaysFor(m, '2026-06-03', provinciaDe('Sevilla Este')).length, 0);
  assert.equal(holidaysFor(m, '2026-06-03', null).length, 0);
});

test('Pascua y propuesta de festivos nacionales', () => {
  assert.equal(easterSunday(2026), '2026-04-05');
  assert.equal(easterSunday(2027), '2027-03-28');
  const s = suggestedNational(2026);
  assert.ok(s.some((f) => f.fecha === '2026-04-03' && f.nombre === 'Viernes Santo'));
  assert.equal(s.length, 10);
});

test('recortes y agrupación de días iguales', () => {
  assert.deepEqual(clipToYear({ inicio: '2025-12-30', fin: '2026-01-02' }, 2026), [0, 1]);
  assert.equal(clipToYear({ inicio: '2027-01-01', fin: '2027-01-03' }, 2026), null);
  assert.deepEqual(runs([1, 1, 2, 2, 2, 1]), [{ start: 0, len: 2, value: 1 }, { start: 2, len: 3, value: 2 }, { start: 5, len: 1, value: 1 }]);
});

test('semana ISO de una fecha y eventos de un año', () => {
  assert.equal(isoWeekOfDate('2026-01-01'), 1);
  assert.equal(isoWeekOfDate('2026-07-20'), 30);
  assert.equal(isoWeekOfDate('2026-12-31'), 53);
  assert.equal(isoWeekOfDate('2027-01-01'), 53); // pertenece a la semana 53 de 2026
  assert.equal(isoWeekOfDate('2027-01-04'), 1);
  const list = [
    ev({ userId: 'u', tipo: 'guardia', inicio: '2026-08-10', fin: '2026-08-16' }),
    ev({ userId: 'u', tipo: 'guardia', inicio: '2025-12-29', fin: '2026-01-04' }),
    ev({ userId: 'u', tipo: 'guardia', inicio: '2027-02-01', fin: '2027-02-07' }),
    ev({ userId: 'u', tipo: 'vacaciones', inicio: '2026-08-01', fin: '2026-08-02', estado: 'fija' }),
  ];
  assert.deepEqual(eventsOfYear(list, 'guardia', 2026).map((e) => e.inicio), ['2025-12-29', '2026-08-10']);
});
