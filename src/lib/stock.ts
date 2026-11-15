import type { Product, StockItem, TechRole, Tx } from '../types';
import { DAY } from './ledger';
import { fmtDate } from './format';

export type StockItems = Record<string, StockItem>;

export const qtyOf = (items: StockItems | undefined, pid: string): number => items?.[pid]?.currentStock ?? 0;
export const baseOf = (role: TechRole | undefined, pid: string): number => role?.baseStock?.[pid] ?? 0;

export interface Surplus {
  product: { id: string; name: string; code: string };
  current: number;
  base: number;
  extra: number;
  reasons: string[];
}

/**
 * ¿Por qué tiene este técnico más que su stock base? Mira los últimos 45 días:
 * traspasos recibidos y material extra recogido en almacén.
 */
export function surplusReasons(txs: Tx[], uid: string, pid: string, surplus: number, now: number): string[] {
  const since = now - 45 * DAY;
  const out: string[] = [];
  let left = surplus;
  for (const t of txs.filter((x) => x.productId === pid && x.timestamp >= since).sort((a, b) => b.timestamp - a.timestamp)) {
    if (left <= 0) break;
    if (t.type === 'transfer' && t.counterpartId === uid) {
      out.push(`${t.userName} te traspasó ${t.quantity} el ${fmtDate(t.timestamp)}`);
      left -= t.quantity;
    } else if (t.type === 'restock' && t.kind === 'extra' && t.userId === uid) {
      out.push(`Recibiste ${t.quantity} de material extra el ${fmtDate(t.timestamp)}`);
      left -= t.quantity;
    }
  }
  return out;
}

/** Productos en los que el técnico supera su stock base. `add` = unidades que se van a sumar (para proyectar). */
export function surplusFor(
  products: Product[],
  items: StockItems | undefined,
  role: TechRole | undefined,
  txs: Tx[],
  uid: string,
  now: number,
  add: Record<string, number> = {},
): Surplus[] {
  const out: Surplus[] = [];
  const onlyAdded = Object.keys(add).length > 0; // proyección: solo los productos que se van a sumar
  for (const p of products) {
    if (onlyAdded && (add[p.id] ?? 0) <= 0) continue;
    const current = qtyOf(items, p.id) + (add[p.id] ?? 0);
    const base = baseOf(role, p.id);
    if (current > base) {
      out.push({ product: { id: p.id, name: p.name, code: p.code }, current, base, extra: current - base, reasons: surplusReasons(txs, uid, p.id, current - base, now) });
    }
  }
  return out;
}

export function surplusText(s: Surplus): string {
  const base = s.base ? ` y tu stock base es ${s.base}` : ', un producto que no está en tu stock base';
  return `${s.product.name}: tendrás ${s.current}${base} (${s.extra} de más).${s.reasons.length ? ` ${s.reasons.join('; ')}.` : ''}`;
}
