import type { Tx } from '../types';
import { dayKey, type TxType } from './ledger';
import { fmtDate, plural } from './format';

export interface Group {
  key: string;
  type: TxType;
  kind: Tx['kind'];
  note: string;
  ts: number;
  userId: string;
  userName: string;
  counterpartId: string | null;
  counterpartName: string | null;
  items: Tx[];
}

/** Tipo de consumo: normal, reparación (sustituciones en averías) o conexión a red. */
export type ConsKind = 'normal' | 'repair' | 'network' | 'install';
export const CONS_LABEL: Record<ConsKind, string> = { normal: 'Consumo', repair: 'Reparación', network: 'Conexión a red', install: 'Instalación' };
export const consKind = (t: Pick<Tx, 'kind'>): ConsKind => (t.kind === 'repair' ? 'repair' : t.kind === 'network' ? 'network' : t.kind === 'install' ? 'install' : 'normal');

export const TYPE_LABEL: Record<TxType, string> = { consumption: 'Consumo', restock: 'Reposición', transfer: 'Traspaso' };

/**
 * Agrupa movimientos: los consumos por Work Order (para no ver 15 líneas sueltas de una misma orden);
 * el resto por día, tipo y nota. Siempre de más reciente a más antiguo.
 */
export function groupTx(list: Tx[]): Group[] {
  const map = new Map<string, Group>();
  for (const t of list) {
    const key =
      t.type === 'consumption' && t.note
        ? `wo|${t.userId}|${t.note}|${t.kind}`
        : `${t.type}|${t.userId}|${dayKey(t.timestamp)}|${t.kind}|${t.note}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        type: t.type,
        kind: t.kind,
        note: t.note,
        ts: t.timestamp,
        userId: t.userId,
        userName: t.userName,
        counterpartId: t.counterpartId,
        counterpartName: t.counterpartName,
        items: [],
      };
      map.set(key, g);
    }
    g.items.push(t);
    if (t.timestamp > g.ts) g.ts = t.timestamp;
  }
  const out = [...map.values()].sort((a, b) => b.ts - a.ts);
  for (const g of out) g.items.sort((a, b) => a.productCode.localeCompare(b.productCode));
  return out;
}

/** "-3 uds (3 productos)". `viewerId` decide el signo de un traspaso (quien lo da resta, quien lo recibe suma). */
export function groupSummary(g: Group, viewerId?: string): { text: string; plus: boolean } {
  const units = g.items.reduce((a, t) => a + t.quantity, 0);
  const n = g.items.length;
  if (g.kind === 'adjust' || g.kind === 'reset') return { text: `${units > 0 ? '+' : ''}${plural(units, 'ud', 'uds')} (${plural(n, 'producto', 'productos')})`, plus: units > 0 };
  let sign = '';
  if (g.type === 'consumption' || g.kind === 'return') sign = '-';
  else if (g.type === 'restock') sign = '+';
  else if (viewerId) sign = g.userId === viewerId ? '-' : '+';
  return { text: `${sign}${plural(units, 'ud', 'uds')} (${plural(n, 'producto', 'productos')})`, plus: sign === '+' };
}

export const typeLabel = (g: Group): string => (g.type === 'consumption' ? CONS_LABEL[consKind(g)] : g.kind === 'reset' ? 'Reset stock base' : g.kind === 'adjust' ? 'Ajuste' : g.kind === 'return' ? 'Devolución a almacén' : g.type === 'restock' && g.kind === 'extra' ? 'Material extra' : TYPE_LABEL[g.type]);

export function groupTitle(g: Group, viewerId?: string): string {
  if (g.type === 'consumption') return g.note || `Consumo del ${fmtDate(g.ts)}`;
  if (g.type === 'restock') {
    if (g.kind === 'reset') return 'Reset stock base';
    if (g.kind === 'adjust') return `Ajuste de stock${g.note ? ` · ${g.note}` : ''}`;
    if (g.kind === 'extra') return `Material extra${g.note ? ` · ${g.note}` : ''}`;
    return g.note || `Reposición del ${fmtDate(g.ts)}`;
  }
  if (viewerId) return g.userId === viewerId ? `Traspaso a ${g.counterpartName ?? '?'}` : `Traspaso de ${g.userName}`;
  return `Traspaso: ${g.userName} → ${g.counterpartName ?? '?'}`;
}
