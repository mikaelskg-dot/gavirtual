/**
 * Cálculos de la flota (sin pantalla, para poder probarlos).
 * Las fechas son texto AAAA-MM-DD, igual que en el calendario.
 */
import { addDays, isDate, toDay } from './calendar';

/** flota_vehiculos/{id} */
export interface Vehiculo {
  id: string;
  matricula: string;
  marca?: string;
  modelo?: string;
  /** fecha de la última ITV pasada */
  itvUltima?: string;
  /** fecha en que vence la ITV (la próxima que hay que pasar) */
  itvVence?: string;
  nota?: string;
}

/** flota_asignaciones/{id}: quién tiene el vehículo y desde/hasta qué día (hasta vacío = sigue con él). */
export interface Asignacion {
  id: string;
  vehiculoId: string;
  tipo: 'tecnico' | 'nombre';
  userId?: string;
  /** nombre de la persona (de un técnico del equipo o escrito a mano para desplazados) */
  nombre: string;
  desde: string;
  hasta?: string;
  nota?: string;
}

/** Días de aviso de la ITV. */
export const ITV_AVISO_URGENTE = 30;
export const ITV_AVISO_PROXIMA = 60;

/** Quita espacios y guiones y pasa a mayúsculas: "1234 abc" -> "1234ABC". */
export const normPlate = (s: string): string => s.replace(/[\s-]+/g, '').toUpperCase();
export const isPlate = (s: string): boolean => /^[A-Z0-9]{4,10}$/.test(s);

/** "1234ABC" -> "1234 ABC" (formato actual); otras matrículas se dejan igual. */
export const fmtPlate = (s: string): string => (/^\d{4}[A-Z]{3}$/.test(s) ? `${s.slice(0, 4)} ${s.slice(4)}` : s);

export type ItvLevel = 'none' | 'expired' | 'urgent' | 'soon' | 'ok';
export interface ItvState {
  level: ItvLevel;
  /** días hasta el vencimiento (negativo = vencida hace N días) */
  days: number | null;
}

export function itvState(vence: string | undefined, today: string): ItvState {
  if (!vence || !isDate(vence)) return { level: 'none', days: null };
  const days = toDay(vence) - toDay(today);
  if (days < 0) return { level: 'expired', days };
  if (days <= ITV_AVISO_URGENTE) return { level: 'urgent', days };
  if (days <= ITV_AVISO_PROXIMA) return { level: 'soon', days };
  return { level: 'ok', days };
}

export const ITV_ORDER: Record<ItvLevel, number> = { expired: 0, urgent: 1, soon: 2, ok: 3, none: 4 };

const covers = (a: Asignacion, today: string): boolean => a.desde <= today && (!a.hasta || a.hasta >= today);

/** Asignación vigente hoy (si hay varias, la que empezó más tarde). */
export function currentAssignment(list: Asignacion[], vehiculoId: string, today: string): Asignacion | null {
  const c = list.filter((a) => a.vehiculoId === vehiculoId && covers(a, today)).sort((a, b) => b.desde.localeCompare(a.desde));
  return c[0] ?? null;
}

/** Próxima asignación ya programada (empieza después de hoy). */
export function nextAssignment(list: Asignacion[], vehiculoId: string, today: string): Asignacion | null {
  const c = list.filter((a) => a.vehiculoId === vehiculoId && a.desde > today).sort((a, b) => a.desde.localeCompare(b.desde));
  return c[0] ?? null;
}

/** Historial de un vehículo, de más reciente a más antiguo. */
export const historyOf = (list: Asignacion[], vehiculoId: string): Asignacion[] =>
  list.filter((a) => a.vehiculoId === vehiculoId).sort((a, b) => b.desde.localeCompare(a.desde) || (b.hasta ?? '9999').localeCompare(a.hasta ?? '9999'));

/**
 * Al dar de alta una asignación que empieza en `desde`, las que siguen abiertas (o que llegan más allá de ese día)
 * se cierran el día anterior. Devuelve qué asignaciones hay que acortar y a qué fecha.
 */
export function closingFor(list: Asignacion[], vehiculoId: string, desde: string): { id: string; hasta: string }[] {
  const out: { id: string; hasta: string }[] = [];
  const prev = addDays(desde, -1);
  for (const a of list) {
    if (a.vehiculoId !== vehiculoId) continue;
    if (a.desde >= desde) continue; // las que empiezan igual o después no se tocan
    if (!a.hasta || a.hasta >= desde) out.push({ id: a.id, hasta: prev });
  }
  return out;
}

/** Días que dura una asignación (hasta hoy si sigue abierta). */
export const assignmentDays = (a: Pick<Asignacion, 'desde' | 'hasta'>, today: string): number => {
  const end = a.hasta ?? today;
  return Math.max(0, toDay(end) - toDay(a.desde) + 1);
};
