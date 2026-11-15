import { useMemo, useState } from 'react';
import type { Tx } from '../types';
import { groupSummary, groupTitle, groupTx, typeLabel } from '../lib/history';
import { fmtDate, fmtDateTime } from '../lib/format';
import { Empty, Pill } from '../ui';

const PAGE = 40;

function Status({ t }: { t: Tx }) {
  const mine = t.type === 'consumption';
  if (mine) {
    if (t.deliveryStatus === 'pending') return <Pill tone="warn">{t.deliveredQty > 0 ? `Entregado ${t.deliveredQty} de ${t.quantity}` : 'Pendiente de entrega'}</Pill>;
    return <Pill tone="good">Entregado {fmtDate(t.deliveryDate ?? t.timestamp)}</Pill>;
  }
  if (t.type === 'restock' && t.missing > 0) return <Pill tone="warn">Faltaron {t.missing} en esa entrega</Pill>;
  return null;
}

/**
 * Historial agrupado (consumos por Work Order), de más reciente a más antiguo.
 * Cada grupo se despliega para ver el detalle de productos.
 */
export function HistoryList({ txs, viewerId, showUser }: { txs: Tx[]; viewerId?: string; showUser?: boolean }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [shown, setShown] = useState(PAGE);
  const groups = useMemo(() => groupTx(txs), [txs]);

  if (!groups.length) return <Empty>No hay movimientos con estos filtros.</Empty>;

  const toggle = (key: string): void =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  return (
    <div>
      {groups.slice(0, shown).map((g) => {
        const isOpen = open.has(g.key);
        const sum = groupSummary(g, viewerId);
        const isWO = g.type === 'consumption' && !!g.note;
        return (
          <div className="hgroup" key={g.key}>
            <button type="button" className="hhead" aria-expanded={isOpen} onClick={() => toggle(g.key)}>
              <span className="chev" aria-hidden="true">
                ›
              </span>
              <span>
                <span className={isWO ? 'htitle mono' : 'htitle'}>{groupTitle(g, viewerId)}</span>
                <span className="sub">
                  {typeLabel(g)} · {fmtDateTime(g.ts)}
                  {showUser && g.type !== 'transfer' ? ` · ${g.userName}` : ''}
                </span>
              </span>
              <span className={sum.plus ? 'hsum plus' : 'hsum'}>{sum.text}</span>
            </button>
            {isOpen ? (
              <div className="hdetail">
                <table className="dtable">
                  <tbody>
                    {g.items.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <span className="mono">{t.productCode}</span>
                        </td>
                        <td>{t.productName}</td>
                        <td className="num">{(t.kind === 'adjust' || t.kind === 'reset') && t.quantity > 0 ? `+${t.quantity}` : t.quantity}</td>
                        <td>
                          <Status t={t} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        );
      })}
      {groups.length > shown ? (
        <div className="more">
          <button type="button" className="btn" onClick={() => setShown((n) => n + PAGE)}>
            Ver más ({groups.length - shown} restantes)
          </button>
        </div>
      ) : null}
    </div>
  );
}
