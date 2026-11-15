import { useMemo, useState } from 'react';
import { useData } from '../../data/DataContext';
import { DAY, isReq, pendQty } from '../../lib/ledger';
import { CONS_LABEL, consKind, type ConsKind } from '../../lib/history';
import { Empty } from '../../ui';

const PERIODS = [7, 30, 90] as const;

function Bars({ rows }: { rows: { id: string; label: string; value: number }[] }) {
  if (!rows.length) return <Empty>Sin consumos en este periodo.</Empty>;
  const top = rows[0].value;
  return (
    <>
      {rows.map((r) => (
        <div className="rank" key={r.id}>
          <span>{r.label}</span>
          <div className="track">
            <i style={{ width: `${Math.round((r.value / top) * 100)}%` }} />
          </div>
          <span className="v">{r.value}</span>
        </div>
      ))}
    </>
  );
}

/** KPIs de consumo y rankings de productos y técnicos. */
export function SpendTab() {
  const data = useData();
  const [days, setDays] = useState<number>(30);
  const [kind, setKind] = useState<'all' | ConsKind>('all');

  const stats = useMemo(() => {
    const since = Date.now() - days * DAY;
    const byP = new Map<string, number>();
    const byU = new Map<string, number>();
    const orders = new Set<string>();
    let total = 0;
    const perKind: Record<ConsKind, number> = { normal: 0, repair: 0, network: 0, install: 0 };
    for (const t of data.txs) {
      if (t.type !== 'consumption' || t.timestamp < since) continue;
      perKind[consKind(t)] += t.quantity;
      if (kind !== 'all' && consKind(t) !== kind) continue;
      total += t.quantity;
      byP.set(t.productId, (byP.get(t.productId) ?? 0) + t.quantity);
      byU.set(t.userId, (byU.get(t.userId) ?? 0) + t.quantity);
      orders.add(`${t.userId}|${t.note || t.id}`);
    }
    const name = (id: string, fallback: string): string => data.products.find((p) => p.id === id)?.name ?? fallback;
    const prodNames = new Map<string, string>();
    for (const t of data.txs) if (!prodNames.has(t.productId)) prodNames.set(t.productId, t.productName);
    const products = [...byP].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, value]) => ({ id, value, label: name(id, prodNames.get(id) ?? id) }));
    const userName = (id: string): string => data.users.find((u) => u.id === id)?.name ?? data.txs.find((t) => t.userId === id)?.userName ?? id;
    const users = [...byU].sort((a, b) => b[1] - a[1]).map(([id, value]) => ({ id, value, label: userName(id) }));
    return { total, orders: orders.size, products, users, perKind };
  }, [data.txs, data.products, data.users, days, kind]);

  const pendingUnits = data.txs.filter((t) => isReq(t) && t.deliveryStatus === 'pending').reduce((a, t) => a + pendQty(t), 0);

  return (
    <>
      <section className="card">
        <div className="card-head">
          <div>
            <h2>Consumo y gastos</h2>
            <span className="sub">Unidades consumidas por los técnicos</span>
          </div>
          <div className="chips">
            {PERIODS.map((d) => (
              <button type="button" key={d} className="chip" aria-pressed={days === d} onClick={() => setDays(d)}>
                {d} días
              </button>
            ))}
          </div>
        </div>
        <div className="chips" role="group" aria-label="Tipo de consumo" style={{ marginBottom: 12 }}>
          {([['all', 'Todo'], ['normal', CONS_LABEL.normal], ['repair', CONS_LABEL.repair], ['network', CONS_LABEL.network], ['install', CONS_LABEL.install]] as const).map(([id, label]) => (
            <button type="button" key={id} className="chip" aria-pressed={kind === id} onClick={() => setKind(id)}>
              {label} ({id === 'all' ? stats.perKind.normal + stats.perKind.repair + stats.perKind.network + stats.perKind.install : stats.perKind[id]})
            </button>
          ))}
        </div>
        <div className="stats">
          <div className="stat">
            <div className="n">{stats.total}</div>
            <div className="l">Unidades consumidas</div>
          </div>
          <div className="stat">
            <div className="n">{stats.orders}</div>
            <div className="l">Órdenes de trabajo</div>
          </div>
          <div className={pendingUnits ? 'stat warn' : 'stat'}>
            <div className="n">{pendingUnits}</div>
            <div className="l">Uds pendientes de entrega</div>
          </div>
          <div className="stat">
            <div className="n">{stats.orders ? (stats.total / stats.orders).toFixed(1).replace('.', ',') : '0'}</div>
            <div className="l">Uds por orden</div>
          </div>
        </div>
      </section>
      <div className="grid2">
        <section className="card">
          <div className="card-head">
            <h3>Productos más consumidos</h3>
          </div>
          <Bars rows={stats.products} />
        </section>
        <section className="card">
          <div className="card-head">
            <h3>Consumo por técnico</h3>
          </div>
          <Bars rows={stats.users} />
        </section>
      </div>
    </>
  );
}
