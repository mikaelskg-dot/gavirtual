/**
 * Lógica pura de ciclos semanales y entregas. No depende de Firebase.
 *
 * IMPORTANTE: este archivo existe dos veces, idéntico:
 *   - functions/src/ledger.ts  (servidor)
 *   - src/lib/ledger.ts        (navegador)
 * Si lo cambias en un sitio, cópialo al otro (`npm run sync-ledger` lo hace).
 */

/** Zona horaria del negocio: la semana (lunes a domingo) se calcula siempre en esta zona. */
export const TZ = 'Europe/Madrid';
export const DAY = 86_400_000;

export type TxType = 'consumption' | 'restock' | 'transfer';

/** Campos mínimos de un movimiento para calcular pendientes y entregas. */
export interface TxLine {
  id: string;
  type: TxType;
  userId: string;
  userName: string;
  productId: string;
  productName: string;
  productCode: string;
  quantity: number;
  deliveredQty?: number;
  deliveryStatus: 'pending' | 'delivered';
  timestamp: number;
  weekStart?: number;
  counterpartName?: string | null;
}

/* ------------------------------------------------------------------ */
/* Fechas en zona horaria                                              */
/* ------------------------------------------------------------------ */

const WEEKDAYS: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = lunes
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function parts(ts: number, tz: string): Parts {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ts))) o[p.type] = p.value;
  return {
    year: Number(o.year),
    month: Number(o.month),
    day: Number(o.day),
    hour: Number(o.hour) % 24,
    minute: Number(o.minute),
    second: Number(o.second),
    weekday: WEEKDAYS[o.weekday] ?? 0,
  };
}

/** Diferencia (ms) entre la hora local de `tz` y UTC en el instante `ts`. */
function offsetMs(ts: number, tz: string): number {
  const p = parts(ts, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Instante (UTC, ms) en el que empieza el día civil y-m-d en `tz`. Admite días fuera de rango (d = -3, etc.). */
function zonedMidnight(y: number, m: number, d: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetMs(guess, tz);
  t = guess - offsetMs(t, tz); // segunda pasada: acierta también en el cambio de hora
  return t;
}

/** Lunes 00:00 (hora local de `tz`) de la semana a la que pertenece `ts`. */
export function startOfWeek(ts: number, tz: string = TZ): number {
  const p = parts(ts, tz);
  return zonedMidnight(p.year, p.month, p.day - p.weekday, tz);
}

/** Número de semana ISO a partir del lunes (en ms) que abre la semana. */
export function isoWeek(weekStartTs: number, tz: string = TZ): number {
  const p = parts(weekStartTs + 12 * 3_600_000, tz); // mediodía: evita saltos por cambio de hora
  const dt = new Date(Date.UTC(p.year, p.month - 1, p.day));
  dt.setUTCDate(dt.getUTCDate() + 3 - ((dt.getUTCDay() + 6) % 7));
  const w1 = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((dt.getTime() - w1.getTime()) / DAY - 3 + ((w1.getUTCDay() + 6) % 7)) / 7);
}

/** 'AAAA-MM-DD' (valor de un <input type="date">) -> instante en que empieza ese día en la zona horaria del negocio. */
export function dayStart(dateStr: string, tz: string = TZ): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return zonedMidnight(y, m, d, tz);
}

/** 'AAAA-MM-DD' -> último milisegundo de ese día en la zona horaria del negocio. */
export function dayEnd(dateStr: string, tz: string = TZ): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return zonedMidnight(y, m, d + 1, tz) - 1;
}

/** Clave de día civil (para agrupar movimientos sin Work Order). */
export function dayKey(ts: number, tz: string = TZ): string {
  const p = parts(ts, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/* ------------------------------------------------------------------ */
/* Pendientes y entregas                                               */
/* ------------------------------------------------------------------ */

/** Consumos y traspasos enviados son los movimientos que el almacén debe reponer. */
/** Solo los consumos se reponen. Los traspasos entre técnicos los resuelven ellos (el almacén no repone). */
export const isReq = (t: Pick<TxLine, 'type'>): boolean => t.type === 'consumption';

/** Unidades de una línea que todavía no se han repuesto. */
export const pendQty = (t: Pick<TxLine, 'type' | 'quantity' | 'deliveredQty'>): number =>
  isReq(t) ? Math.max(0, t.quantity - (t.deliveredQty ?? 0)) : 0;

/** Semana (lunes) a la que pertenece un movimiento. */
export const weekOf = (t: Pick<TxLine, 'timestamp' | 'weekStart'>): number => t.weekStart ?? startOfWeek(t.timestamp);

const isPending = (t: TxLine): boolean => isReq(t) && t.deliveryStatus === 'pending' && pendQty(t) > 0;

/**
 * Pendiente de reponer por semana CERRADA (anterior a la semana en curso) y producto.
 * Lo gastado esta semana no aparece: se repone en el siguiente ciclo.
 */
export function pendingByWeek(lines: TxLine[], currentWeek: number): Map<number, Map<string, number>> {
  const out = new Map<number, Map<string, number>>();
  for (const t of lines) {
    if (!isPending(t)) continue;
    const w = weekOf(t);
    if (w >= currentWeek) continue;
    let m = out.get(w);
    if (!m) out.set(w, (m = new Map()));
    m.set(t.productId, (m.get(t.productId) ?? 0) + pendQty(t));
  }
  return out;
}

export interface PlanTake {
  id: string;
  take: number;
  completes: boolean;
}

export interface PlanItem {
  productId: string;
  productName: string;
  productCode: string;
  requested: number;
  got: number;
  takes: PlanTake[];
}

export type PlanResult = { ok: true; items: PlanItem[] } | { ok: false; error: string };

const byAge = (a: TxLine, b: TxLine): number => a.timestamp - b.timestamp || a.id.localeCompare(b.id);

/** Reparte `qty` unidades entre las líneas, de la más antigua a la más reciente. */
function allocate(lines: TxLine[], qty: number): PlanTake[] {
  const takes: PlanTake[] = [];
  let left = qty;
  for (const t of lines) {
    if (left <= 0) break;
    const pend = pendQty(t);
    const take = Math.min(pend, left);
    if (take > 0) takes.push({ id: t.id, take, completes: take === pend });
    left -= take;
  }
  return takes;
}

/**
 * Reposición semanal de un técnico: `got` es lo que ha recogido por producto.
 * - Solo cuenta lo pendiente de las semanas elegidas, y siempre semanas cerradas.
 * - No se puede recoger más de lo pedido; menos sí (queda pendiente para el próximo pedido).
 */
export function planWeekly(
  lines: TxLine[],
  weeks: number[],
  currentWeek: number,
  got: Record<string, number>,
): PlanResult {
  const sel = new Set(weeks);
  if (!sel.size) return { ok: false, error: 'Elige al menos una semana.' };
  if ([...sel].some((w) => w >= currentWeek)) return { ok: false, error: 'La semana en curso todavía no se puede reponer.' };

  const byProduct = new Map<string, TxLine[]>();
  for (const t of lines.filter((x) => isPending(x) && sel.has(weekOf(x))).sort(byAge)) {
    const l = byProduct.get(t.productId);
    if (l) l.push(t);
    else byProduct.set(t.productId, [t]);
  }

  const items: PlanItem[] = [];
  for (const [productId, q] of Object.entries(got)) {
    if (!Number.isInteger(q) || q < 0) return { ok: false, error: 'Cantidad no válida.' };
    if (q === 0) continue;
    const ls = byProduct.get(productId);
    if (!ls) return { ok: false, error: 'Hay un producto que no está pendiente en las semanas elegidas.' };
    const requested = ls.reduce((a, t) => a + pendQty(t), 0);
    if (q > requested) return { ok: false, error: `Has indicado más cantidad de la pendiente de ${ls[0].productName}.` };
    items.push({ productId, productName: ls[0].productName, productCode: ls[0].productCode, requested, got: q, takes: allocate(ls, q) });
  }
  if (!items.length) return { ok: false, error: 'Marca al menos un producto que hayas recogido.' };
  return { ok: true, items };
}

export interface DeliveryGroup {
  userId: string;
  userName: string;
  productId: string;
  productName: string;
  productCode: string;
  quantity: number;
  takes: PlanTake[];
}

/** Entrega completa de las líneas pendientes indicadas, agrupada por técnico y producto. */
export function planDelivery(lines: TxLine[]): DeliveryGroup[] {
  const groups = new Map<string, DeliveryGroup>();
  for (const t of lines.filter(isPending).sort(byAge)) {
    const key = `${t.userId}|${t.productId}`;
    const take = pendQty(t);
    let g = groups.get(key);
    if (!g) {
      g = { userId: t.userId, userName: t.userName, productId: t.productId, productName: t.productName, productCode: t.productCode, quantity: 0, takes: [] };
      groups.set(key, g);
    }
    g.quantity += take;
    g.takes.push({ id: t.id, take, completes: true });
  }
  return [...groups.values()];
}
