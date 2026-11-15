/**
 * Cálculos del calendario anual (sin pantalla, para poder probarlos).
 * Las fechas son texto AAAA-MM-DD y se manejan en UTC para evitar problemas de zona horaria:
 * un "día" es el número de días desde 1970-01-01.
 */

export const ZONAS = ['Sevilla Este', 'Sevilla Oeste', 'Huelva'] as const;
export type Zona = (typeof ZONAS)[number];
export type Provincia = 'Sevilla' | 'Huelva';
export type EventoTipo = 'vacaciones' | 'guardia' | 'baja';
export type EstadoVac = 'fija' | 'flexible';

/** calendario_eventos/{id} */
export interface CalEvento {
  id: string;
  userId: string;
  tipo: EventoTipo;
  inicio: string;
  fin: string;
  estado?: EstadoVac;
  nota?: string;
}

/** calendario_festivos/{id} */
export interface CalFestivo {
  id: string;
  fecha: string;
  ambito: 'nacional' | 'provincial';
  provincia: Provincia | null;
  nombre: string;
}

export const TIPO_LABEL: Record<EventoTipo, string> = { vacaciones: 'Vacaciones', guardia: 'Guardia', baja: 'Baja' };
export const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
export const MESES_CORTO = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
export const DIAS_SEMANA = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
export const VACACIONES_ANUALES = 31;

export const provinciaDe = (z: string | undefined | null): Provincia | null => (z === 'Huelva' ? 'Huelva' : z === 'Sevilla Este' || z === 'Sevilla Oeste' ? 'Sevilla' : null);
export const isZona = (z: unknown): z is Zona => (ZONAS as readonly unknown[]).includes(z);

/* ---------------- fechas ---------------- */

const RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDate(s: string): boolean {
  const m = RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export function toDay(s: string): number {
  const m = RE.exec(s);
  if (!m) throw new Error(`Fecha no válida: ${s}`);
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
}
export const fromDay = (n: number): string => new Date(n * 86400000).toISOString().slice(0, 10);
export const addDays = (s: string, n: number): string => fromDay(toDay(s) + n);
export const daysInMonth = (year: number, month0: number): number => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
export const daysInYear = (year: number): number => toDay(`${year}-12-31`) - toDay(`${year}-01-01`) + 1;
/** 0 = lunes … 6 = domingo */
export const weekdayIdx = (s: string): number => (((toDay(s) + 3) % 7) + 7) % 7;
export const isWeekend = (s: string): boolean => weekdayIdx(s) >= 5;
export const yearStart = (year: number): string => `${year}-01-01`;
/** Índice (0-based) de una fecha dentro de un año; fuera del año puede salir negativo o >= días. */
export const dayIndex = (s: string, year: number): number => toDay(s) - toDay(yearStart(year));
export const dateAt = (idx: number, year: number): string => fromDay(toDay(yearStart(year)) + idx);
export const monthStartIdx = (year: number, month0: number): number => dayIndex(`${year}-${String(month0 + 1).padStart(2, '0')}-01`, year);

/** Semana ISO (1-53) de una fecha AAAA-MM-DD. */
export function isoWeekOfDate(s: string): number {
  const t = toDay(s);
  const thursday = t - ((((t + 3) % 7) + 7) % 7) + 3; // jueves de esa semana
  const y = new Date(thursday * 86400000).getUTCFullYear();
  return Math.floor((thursday - toDay(`${y}-01-01`)) / 7) + 1;
}

/** Eventos de un tipo que tocan el año, ordenados por fecha. */
export function eventsOfYear(events: CalEvento[], tipo: EventoTipo, year: number): CalEvento[] {
  return events.filter((e) => e.tipo === tipo && clipToYear(e, year) !== null).sort((a, b) => a.inicio.localeCompare(b.inicio) || a.fin.localeCompare(b.fin));
}

/** Hoy en Europe/Madrid como AAAA-MM-DD. */
export function todayMadrid(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** "3 ago" / "3 ago 2027" */
export function fmtShort(s: string, withYear = false): string {
  const [y, m, d] = s.split('-').map(Number);
  return `${d} ${MESES_CORTO[m - 1].toLowerCase()}${withYear ? ` ${y}` : ''}`;
}

/* ---------------- eventos ---------------- */

/** Tramo [inicio, fin] del evento recortado al año, en índices de día; null si cae fuera. */
export function clipToYear(e: Pick<CalEvento, 'inicio' | 'fin'>, year: number): [number, number] | null {
  const n = daysInYear(year);
  const a = Math.max(dayIndex(e.inicio, year), 0);
  const b = Math.min(dayIndex(e.fin, year), n - 1);
  return a > b ? null : [a, b];
}

function mark(events: CalEvento[], year: number, pred: (e: CalEvento) => boolean): boolean[] {
  const out = new Array<boolean>(daysInYear(year)).fill(false);
  for (const e of events) {
    if (!pred(e)) continue;
    const c = clipToYear(e, year);
    if (c) for (let i = c[0]; i <= c[1]; i++) out[i] = true;
  }
  return out;
}

const byUser = (events: CalEvento[]): Map<string, CalEvento[]> => {
  const m = new Map<string, CalEvento[]>();
  for (const e of events) m.set(e.userId, [...(m.get(e.userId) ?? []), e]);
  return m;
};

/** Días naturales de vacaciones de una persona dentro del año (sin contar dos veces los solapados). */
export function vacationDaysUsed(events: CalEvento[], userId: string, year: number): number {
  return mark(events.filter((e) => e.userId === userId), year, (e) => e.tipo === 'vacaciones').filter(Boolean).length;
}

/** Para cada día: cuántas personas (de `userIds`) están fuera por vacaciones o baja. */
export function outPerDay(events: CalEvento[], userIds: ReadonlySet<string>, year: number): number[] {
  const counts = new Array<number>(daysInYear(year)).fill(0);
  for (const [uid, evs] of byUser(events)) {
    if (!userIds.has(uid)) continue;
    mark(evs, year, (e) => e.tipo === 'vacaciones' || e.tipo === 'baja').forEach((v, i) => {
      if (v) counts[i]++;
    });
  }
  return counts;
}

export interface VacWeek {
  /** número de semana ISO (lunes a domingo) */
  week: number;
  /** mes (0-11) al que se asigna la semana: el de su jueves, como hace la norma ISO */
  month: number;
  /** primer y último día de la semana dentro del año (índices) */
  from: number;
  to: number;
  people: { id: string; name: string; days: number }[];
}

/** Personas con vacaciones en cada semana del año (lunes a domingo). `estado` filtra fijas/flexibles. */
export function vacationByWeek(
  events: CalEvento[],
  users: { id: string; name: string }[],
  year: number,
  estado: '' | EstadoVac = '',
): VacWeek[] {
  const n = daysInYear(year);
  const grouped = byUser(events);
  const flags = users.map((u) => ({ u, f: mark(grouped.get(u.id) ?? [], year, (e) => e.tipo === 'vacaciones' && (!estado || e.estado === estado)) }));
  const out: VacWeek[] = [];
  for (let start = -weekdayIdx(yearStart(year)); start < n; start += 7) {
    const from = Math.max(start, 0);
    const to = Math.min(start + 6, n - 1);
    const thu = dateAt(start + 3, year);
    const ty = Number(thu.slice(0, 4));
    const month = ty < year ? 0 : ty > year ? 11 : Number(thu.slice(5, 7)) - 1;
    const people: VacWeek['people'] = [];
    for (const { u, f } of flags) {
      let days = 0;
      for (let i = from; i <= to; i++) if (f[i]) days++;
      if (days > 0) people.push({ id: u.id, name: u.name, days });
    }
    out.push({ week: isoWeekOfDate(dateAt(start, year)), month, from, to, people });
  }
  return out;
}

export interface GuardCount {
  /** guardias ya terminadas (fin anterior a hoy) */
  done: number;
  /** guardias en curso o futuras */
  upcoming: number;
  /** días de guardia dentro del año (hechos + programados, sin duplicar solapes) */
  days: number;
}

/** Guardias por persona dentro del año. Una guardia que cruza de año cuenta en ambos años. */
export function guardCounts(events: CalEvento[], userIds: string[], year: number, today: string): Map<string, GuardCount> {
  const grouped = byUser(events);
  const out = new Map<string, GuardCount>();
  for (const id of userIds) {
    const evs = (grouped.get(id) ?? []).filter((e) => e.tipo === 'guardia' && clipToYear(e, year) !== null);
    out.set(id, {
      done: evs.filter((e) => e.fin < today).length,
      upcoming: evs.filter((e) => e.fin >= today).length,
      days: mark(evs, year, () => true).filter(Boolean).length,
    });
  }
  return out;
}

/** Agrupa valores consecutivos iguales: [{ start, len, value }]. */
export function runs<T>(arr: readonly T[], same: (a: T, b: T) => boolean = (a, b) => a === b): { start: number; len: number; value: T }[] {
  const out: { start: number; len: number; value: T }[] = [];
  arr.forEach((v, i) => {
    const last = out[out.length - 1];
    if (last && same(last.value, v)) last.len++;
    else out.push({ start: i, len: 1, value: v });
  });
  return out;
}

/* ---------------- festivos ---------------- */

export const festivoMap = (festivos: CalFestivo[]): Map<string, CalFestivo[]> => {
  const m = new Map<string, CalFestivo[]>();
  for (const f of festivos) m.set(f.fecha, [...(m.get(f.fecha) ?? []), f]);
  return m;
};

/** Festivos que afectan a alguien de esa provincia (null = sin zona: solo los nacionales). */
export const holidaysFor = (map: Map<string, CalFestivo[]>, date: string, prov: Provincia | null): CalFestivo[] =>
  (map.get(date) ?? []).filter((f) => f.ambito === 'nacional' || (prov !== null && f.provincia === prov));

/** Domingo de Pascua (algoritmo de Meeus/Jones/Butcher). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Propuesta OPCIONAL de festivos nacionales de fecha fija + Viernes Santo. El administrador la revisa antes de guardar nada. */
export function suggestedNational(year: number): { fecha: string; nombre: string }[] {
  const y = String(year);
  return [
    { fecha: `${y}-01-01`, nombre: 'Año Nuevo' },
    { fecha: `${y}-01-06`, nombre: 'Epifanía del Señor' },
    { fecha: addDays(easterSunday(year), -2), nombre: 'Viernes Santo' },
    { fecha: `${y}-05-01`, nombre: 'Fiesta del Trabajo' },
    { fecha: `${y}-08-15`, nombre: 'Asunción de la Virgen' },
    { fecha: `${y}-10-12`, nombre: 'Fiesta Nacional de España' },
    { fecha: `${y}-11-01`, nombre: 'Todos los Santos' },
    { fecha: `${y}-12-06`, nombre: 'Día de la Constitución' },
    { fecha: `${y}-12-08`, nombre: 'Inmaculada Concepción' },
    { fecha: `${y}-12-25`, nombre: 'Natividad del Señor' },
  ];
}
