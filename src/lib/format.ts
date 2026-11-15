import { DAY, TZ, isoWeek } from './ledger';

const dFmt = new Intl.DateTimeFormat('es-ES', { timeZone: TZ, day: 'numeric', month: 'short' });
const dtFmt = new Intl.DateTimeFormat('es-ES', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export const fmtDate = (ts: number): string => dFmt.format(ts);
export const fmtDateTime = (ts: number): string => dtFmt.format(ts);

/** "3 uds" / "1 ud" */
export const uds = (n: number): string => `${n} ${n === 1 ? 'ud' : 'uds'}`;

/** "Sem 41 · 5 oct–11 oct" a partir del lunes (ms) que abre la semana. */
export const weekLabel = (weekStart: number): string =>
  `Sem ${isoWeek(weekStart)} · ${fmtDate(weekStart + 12 * 3_600_000)}–${fmtDate(weekStart + 6 * DAY + 12 * 3_600_000)}`;

export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Compara textos en español sin distinguir tildes ni mayúsculas. */
export const byText = (a: string, b: string): number => a.localeCompare(b, 'es', { sensitivity: 'base', numeric: true });
