import { useMemo, useState } from 'react';
import { HistoryList } from '../../components/HistoryList';
import { useData } from '../../data/DataContext';
import { groupByFolder } from '../../lib/catalog';
import { fmtDate, uds } from '../../lib/format';
import { CONS_LABEL, consKind } from '../../lib/history';
import { isReq, pendQty, pendingByWeek, startOfWeek, weekOf } from '../../lib/ledger';
import { baseOf, qtyOf, surplusFor, surplusText, type Surplus } from '../../lib/stock';
import type { TxType } from '../../lib/ledger';
import type { UserDoc } from '../../types';
import { Collapse, InfoModal, Modal, Pill } from '../../ui';
import { CartModal, type CartType } from './CartModal';
import { WeeklyModal } from './WeeklyModal';

type ModalState = null | { kind: 'cart'; type: CartType } | { kind: 'weekly' } | { kind: 'soldout' } | { kind: 'pending' };

const FILTERS: { id: 'all' | TxType; label: string }[] = [
  { id: 'all', label: 'Todo' },
  { id: 'consumption', label: 'Consumos' },
  { id: 'restock', label: 'Reposiciones' },
  { id: 'transfer', label: 'Traspasos' },
];

/** Vista del técnico (pensada para el móvil): su stock, acciones y su historial. */
export function WorkerView({ me }: { me: UserDoc }) {
  const data = useData();
  const [modal, setModal] = useState<ModalState>(null);
  const [info, setInfo] = useState<Surplus[] | null>(null);
  const [filter, setFilter] = useState<'all' | TxType>('all');

  const role = data.roles.find((r) => r.id === me.technicianRoleId);
  const items = data.stock[me.id];
  const now = Date.now();
  const currentWeek = startOfWeek(now);

  const myTxs = useMemo(() => data.txs.filter((t) => t.userId === me.id), [data.txs, me.id]);
  const history = useMemo(
    () => data.txs.filter((t) => (t.userId === me.id || t.counterpartId === me.id) && (filter === 'all' || t.type === filter)),
    [data.txs, me.id, filter],
  );

  // Solo se listan los productos que el técnico lleva o debería llevar (su stock base).
  const visible = data.products.filter((p) => qtyOf(items, p.id) > 0 || baseOf(role, p.id) > 0);
  const groups = groupByFolder(visible);
  const soldOutList = visible.filter((p) => qtyOf(items, p.id) === 0 && baseOf(role, p.id) > 0);
  const soldOut = soldOutList.length;
  const pending = myTxs.filter((t) => isReq(t) && t.deliveryStatus === 'pending').reduce((a, t) => a + pendQty(t), 0);
  // Lo que el almacén me debe reponer, por producto, con el origen de cada parte.
  const pendingList = useMemo(() => {
    const m = new Map<string, { id: string; name: string; code: string; qty: number; from: string[]; kinds: Record<string, number> }>();
    for (const t of myTxs) {
      if (!isReq(t) || t.deliveryStatus !== 'pending' || pendQty(t) <= 0) continue;
      const e = m.get(t.productId) ?? { id: t.productId, name: t.productName, code: t.productCode, qty: 0, from: [], kinds: {} };
      e.qty += pendQty(t);
      const kl = t.type === 'transfer' ? 'Traspaso' : CONS_LABEL[consKind(t)];
      e.kinds[kl] = (e.kinds[kl] ?? 0) + pendQty(t);
      e.from.push(t.type === 'transfer' ? `traspaso a ${t.counterpartName ?? '?'}` : t.note || `consumo del ${fmtDate(t.timestamp)}`);
      m.set(t.productId, e);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  }, [myTxs]);
  const ready = [...pendingByWeek(myTxs, currentWeek).values()].reduce((a, m) => a + [...m.values()].reduce((b, q) => b + q, 0), 0);
  const consumedThisWeek = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of myTxs) if (t.type === 'consumption' && weekOf(t) >= currentWeek) m.set(t.productId, (m.get(t.productId) ?? 0) + t.quantity);
    return m;
  }, [myTxs, currentWeek]);
  const surplus = surplusFor(data.products, items, role, data.txs, me.id, now);

  return (
    <main>
      <section className="card">
        <div className="hello">
          <h2>{me.name}</h2>
          <span className="sub">
            {[me.territory, role?.name].filter(Boolean).join(' · ')}
          </span>
        </div>
        <div className="stats">
          <button type="button" className={soldOut ? 'stat warn statbtn' : 'stat statbtn'} onClick={() => setModal({ kind: 'soldout' })}>
            <div className="n">{soldOut}</div>
            <div className="l">Productos agotados ›</div>
          </button>
          <button type="button" className="stat statbtn" onClick={() => setModal({ kind: 'pending' })}>
            <div className="n">{pending}</div>
            <div className="l">Consumo pendiente de reponer ›</div>
          </button>
        </div>
      </section>

      {surplus.length ? (
        <section className="card tight">
          <Collapse title="Material por encima de tu stock base" badge={<Pill tone="info">{surplus.length}</Pill>}>
            {surplus.map((x) => (
              <div className="crow" key={x.product.id}>
                <div className="pn">
                  <div className="pname">{x.product.name}</div>
                  <span className="sub">
                    Tienes {x.current}
                    {x.base ? `, tu base es ${x.base}` : ', no está en tu base'}
                    {x.reasons.length ? ` · ${x.reasons.join('; ')}` : ''}
                  </span>
                </div>
                <Pill tone="info">+{x.extra}</Pill>
              </div>
            ))}
          </Collapse>
        </section>
      ) : null}

      <section className="actions" aria-label="Acciones">
        <button type="button" className="btn primary" onClick={() => setModal({ kind: 'cart', type: 'consume' })}>
          Registrar consumo
        </button>
        <button type="button" className="btn" onClick={() => setModal({ kind: 'weekly' })}>
          Reposición semanal {ready ? <Pill tone="info">{uds(ready)}</Pill> : null}
        </button>
        <button type="button" className="btn" onClick={() => setModal({ kind: 'cart', type: 'extra' })}>
          Recibir material extra
        </button>
        <button type="button" className="btn" onClick={() => setModal({ kind: 'cart', type: 'transfer' })}>
          Traspasar a otro técnico
        </button>
        <button type="button" className="btn" onClick={() => setModal({ kind: 'cart', type: 'return' })}>
          Devolver a almacén
        </button>
      </section>

      {groups.length === 0 ? (
        <section className="card">
          <div className="empty">Todavía no tienes productos asignados. Habla con almacén para configurar tu stock base.</div>
        </section>
      ) : null}
      {groups.length ? (
        <section className="card tight">
          <Collapse title="Mi stock" badge={<Pill>{visible.length}</Pill>}>
            {groups.map((g) => (
              <Collapse key={g.name} title={g.name} badge={<span className="cfcount">{g.items.length}</span>}>
                {g.items.map((p) => {
                  const c = qtyOf(items, p.id);
                  const base = baseOf(role, p.id);
                  const out = c === 0;
                  const pct = base ? Math.min(100, Math.round((c / base) * 100)) : c > 0 ? 100 : 0;
                  return (
                    <div className="prow" key={p.id}>
                      <div>
                        <div className="pname">{p.name}</div>
                        <div className="pcode">{p.code}</div>
                      </div>
                      <div className={out ? 'pqty zero' : 'pqty'}>{c}</div>
                      <div className={out ? 'bar zero' : 'bar'} role="img" aria-label={`${c} de ${base} de stock base`}>
                        <i style={{ width: `${pct}%` }} />
                      </div>
                      <div className="pmeta">
                        <span>Esta semana: {consumedThisWeek.get(p.id) ?? 0}</span>
                        {out ? <Pill tone="crit">Agotado</Pill> : <span>{base ? `Base: ${base}` : 'Fuera de tu base'}</span>}
                      </div>
                    </div>
                  );
                })}
              </Collapse>
            ))}
          </Collapse>
        </section>
      ) : null}

      <section className="card">
        <div className="card-head">
          <h2>Mi historial</h2>
          <div className="chips">
            {FILTERS.map((f) => (
              <button type="button" key={f.id} className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <HistoryList txs={history} viewerId={me.id} key={filter} />
      </section>

      {modal?.kind === 'cart' ? <CartModal type={modal.type} me={me} onClose={() => setModal(null)} /> : null}
      {modal?.kind === 'weekly' ? <WeeklyModal me={me} onClose={() => setModal(null)} onDone={(s) => setInfo(s.length ? s : null)} /> : null}
      {modal?.kind === 'soldout' ? (
        <Modal title="Productos agotados" onClose={() => setModal(null)}>
          <p className="sub">Productos de tu stock base de los que tienes 0.</p>
          {soldOutList.length === 0 ? (
            <div className="empty">No tienes ningún producto agotado.</div>
          ) : (
            soldOutList.map((p) => (
              <div className="crow" key={p.id}>
                <div className="pn">
                  <div className="pname">{p.name}</div>
                  <div className="pcode">{p.code}</div>
                </div>
                <Pill tone="crit">Base: {baseOf(role, p.id)}</Pill>
              </div>
            ))
          )}
        </Modal>
      ) : null}
      {modal?.kind === 'pending' ? (
        <Modal title="Pendiente de reponer" onClose={() => setModal(null)}>
          <p className="sub">Lo que has consumido y almacén todavía te tiene que devolver. Los traspasos entre compañeros no se incluyen.</p>
          {pendingList.length === 0 ? (
            <div className="empty">No tienes nada pendiente de reponer.</div>
          ) : (
            pendingList.map((x) => (
              <div className="crow" key={x.id}>
                <div className="pn">
                  <div className="pname">{x.name}</div>
                  <div className="pcode">
                    {x.code} · {x.from.slice(0, 3).join('; ')}
                    {x.from.length > 3 ? ` y ${x.from.length - 3} más` : ''}
                  </div>
                  <div className="pcode">
                    {Object.entries(x.kinds).map(([k, q]) => `${k}: ${q}`).join(' · ')}
                  </div>
                </div>
                <Pill tone="warn">{x.qty}</Pill>
              </div>
            ))
          )}
        </Modal>
      ) : null}
      {info ? (
        <InfoModal title="Material por encima de tu stock base" intro="Es solo un aviso informativo." items={info.map(surplusText)} onClose={() => setInfo(null)} />
      ) : null}
    </main>
  );
}
