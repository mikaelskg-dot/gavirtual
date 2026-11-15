import { useMemo, useState } from 'react';
import { api } from '../../api';
import { useData } from '../../data/DataContext';
import { byText, uds, weekLabel } from '../../lib/format';
import { isReq, pendQty, pendingByWeek, planWeekly, startOfWeek, weekOf } from '../../lib/ledger';
import { baseOf, qtyOf, surplusFor, surplusReasons, type Surplus } from '../../lib/stock';
import type { UserDoc } from '../../types';
import { Empty, Modal, Stepper, useAction, useToast } from '../../ui';

interface Row {
  pid: string;
  name: string;
  code: string;
  folder: string;
  requested: number;
  transferQty: number;
  transferTo: string[];
}

/**
 * Reposición semanal: checklist con lo pendiente de las semanas CERRADAS. El técnico marca lo que va cogiendo
 * en almacén; lo que no coge (o coge incompleto) queda pendiente para su próximo pedido.
 */
export function WeeklyModal({ me, onClose, onDone }: { me: UserDoc; onClose: () => void; onDone: (surplus: Surplus[]) => void }) {
  const data = useData();
  const toast = useToast();
  const { busy, error, setError, run } = useAction();

  const myTxs = useMemo(() => data.txs.filter((t) => t.userId === me.id), [data.txs, me.id]);
  const currentWeek = startOfWeek(Date.now());
  const byWeek = useMemo(() => pendingByWeek(myTxs, currentWeek), [myTxs, currentWeek]);
  const weekKeys = useMemo(() => [...byWeek.keys()].sort((a, b) => a - b), [byWeek]);
  const [weeks, setWeeks] = useState<Set<number>>(() => new Set(weekKeys));
  const [got, setGot] = useState<Record<string, number>>({});

  const role = data.roles.find((r) => r.id === me.technicianRoleId);
  const items = data.stock[me.id];
  const sel = weekKeys.filter((w) => weeks.has(w));

  const rows = useMemo<Row[]>(() => {
    const lines = myTxs.filter((t) => isReq(t) && t.deliveryStatus === 'pending' && pendQty(t) > 0 && weekOf(t) < currentWeek && sel.includes(weekOf(t)));
    const map = new Map<string, Row>();
    for (const t of lines) {
      let r = map.get(t.productId);
      if (!r) {
        const p = data.products.find((x) => x.id === t.productId);
        r = { pid: t.productId, name: p?.name ?? t.productName, code: p?.code ?? t.productCode, folder: p?.category || 'Sin carpeta', requested: 0, transferQty: 0, transferTo: [] };
        map.set(t.productId, r);
      }
      r.requested += pendQty(t);
      if (t.type === 'transfer') {
        r.transferQty += pendQty(t);
        if (t.counterpartName && !r.transferTo.includes(t.counterpartName)) r.transferTo.push(t.counterpartName);
      }
    }
    return [...map.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myTxs, data.products, currentWeek, sel.join(',')]);

  const folders = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of rows) m.set(r.folder, [...(m.get(r.folder) ?? []), r]);
    return [...m].sort((a, b) => byText(a[0], b[0])).map(([name, list]) => ({ name, list: list.sort((a, b) => byText(a.code, b.code)) }));
  }, [rows]);

  const gotOf = (r: Row): number => Math.min(got[r.pid] ?? 0, r.requested);
  const ticked = rows.filter((r) => gotOf(r) > 0).length;
  const gotUnits = rows.reduce((a, r) => a + gotOf(r), 0);
  const reqUnits = rows.reduce((a, r) => a + r.requested, 0);
  const allDone = rows.length > 0 && rows.every((r) => gotOf(r) >= r.requested);

  const currentWeekPending = myTxs.filter((t) => isReq(t) && t.deliveryStatus === 'pending' && weekOf(t) >= currentWeek).reduce((a, t) => a + pendQty(t), 0);

  const toggleWeek = (w: number): void => {
    setWeeks((s) => {
      const n = new Set(s);
      if (n.has(w)) n.delete(w);
      else n.add(w);
      return n;
    });
    setGot({}); // al cambiar las semanas, el checklist vuelve a empezar
    setError('');
  };

  const setOne = (r: Row, n: number): void => {
    setGot((g) => ({ ...g, [r.pid]: Math.max(0, Math.min(r.requested, n)) }));
    setError('');
  };

  const submit = (): void => {
    const clean: Record<string, number> = {};
    for (const r of rows) if (gotOf(r) > 0) clean[r.pid] = gotOf(r);
    const plan = planWeekly(myTxs, sel, currentWeek, clean);
    if (!plan.ok) return setError(plan.error);
    void run(async () => {
      const surplus = surplusFor(data.products, items, role, data.txs, me.id, Date.now(), clean);
      await api.registerWeekly(sel, clean);
      toast(`Reposición registrada: ${uds(gotUnits)}`);
      onDone(surplus);
      onClose();
    });
  };

  return (
    <Modal
      title="Reposición semanal"
      onClose={onClose}
      footer={
        <>
          <span className="grow">
            {ticked} de {rows.length} productos · {gotUnits} de {reqUnits} uds
          </span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className="btn primary" onClick={submit} disabled={busy || !rows.length}>
            {busy ? 'Guardando…' : 'Confirmar reposición'}
          </button>
        </>
      }
    >
      {weekKeys.length === 0 ? (
        <Empty>No tienes material pendiente de semanas anteriores.</Empty>
      ) : (
        <div className="field">
          <span className="lbl">Semanas incluidas</span>
          <div className="chips">
            {weekKeys.map((w) => {
              const total = [...(byWeek.get(w)?.values() ?? [])].reduce((a, q) => a + q, 0);
              return (
                <button type="button" key={w} className="chip" aria-pressed={weeks.has(w)} onClick={() => toggleWeek(w)}>
                  {weekLabel(w)} ({total})
                </button>
              );
            })}
          </div>
        </div>
      )}
      {currentWeekPending > 0 ? (
        <div className="note">Esta semana llevas {uds(currentWeekPending)} gastadas. Se repondrán en el próximo ciclo, a partir del lunes.</div>
      ) : null}
      {weekKeys.length > 0 && rows.length === 0 ? <Empty>Elige al menos una semana.</Empty> : null}
      {rows.length > 0 ? (
        <>
          <div className="pick">
            <span className="lbl">Marca cada producto según lo vayas cogiendo en almacén</span>
            <button
              type="button"
              className="btn sm"
              onClick={() => setGot(allDone ? {} : Object.fromEntries(rows.map((r) => [r.pid, r.requested])))}
            >
              {allDone ? 'Desmarcar todo' : 'Marcar todo como recogido'}
            </button>
          </div>
          {folders.map((f) => (
            <div className="cartcat" key={f.name}>
              <h3>{f.name}</h3>
              {f.list.map((r) => {
                const g = gotOf(r);
                const proj = qtyOf(items, r.pid) + g;
                const base = baseOf(role, r.pid);
                const over = g > 0 && proj > base ? proj - base : 0;
                const reasons = over ? surplusReasons(data.txs, me.id, r.pid, over, Date.now()) : [];
                return (
                  <div className="witem" key={r.pid}>
                    <div className="wrow">
                      <label className="wlab" htmlFor={`w-${r.pid}`}>
                        <input
                          className="chk"
                          type="checkbox"
                          id={`w-${r.pid}`}
                          checked={g > 0}
                          onChange={(e) => setOne(r, e.currentTarget.checked ? r.requested : 0)}
                        />
                        <span className="pn">
                          <span className="pname">{r.name}</span>
                          <span className="pcode">
                            {r.code} · Pedido: {r.requested}
                          </span>
                        </span>
                      </label>
                      <Stepper value={g} max={r.requested} onChange={(n) => setOne(r, n)} label={r.name} />
                    </div>
                    {r.transferQty > 0 ? (
                      <div className="hint">
                        Incluye {r.transferQty} por traspaso a {r.transferTo.join(', ')}.
                      </div>
                    ) : null}
                    {g > 0 && g < r.requested ? (
                      <div className="hint warn">Faltan {r.requested - g}: quedarán pendientes para tu próximo pedido.</div>
                    ) : null}
                    {over ? (
                      <div className="hint info">
                        Quedarás con {proj} {base ? `(tu stock base es ${base})` : 'y no está en tu stock base'}. {reasons.join('; ')}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
          <p className="sub">Lo que no marques, o cojas incompleto, se queda pendiente para tu próximo pedido.</p>
        </>
      ) : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
