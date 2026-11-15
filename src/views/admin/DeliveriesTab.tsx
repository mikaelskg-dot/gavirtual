import { useMemo, useState } from 'react';
import { api } from '../../api';
import { useData } from '../../data/DataContext';
import { byText, fmtDate, plural, weekLabel } from '../../lib/format';
import { isReq, pendQty, weekOf } from '../../lib/ledger';
import { Empty, Field, Pill, useAction, useToast } from '../../ui';

const CHUNK = 150;

/** Entregas: líneas de consumo/traspaso que el almacén debe reponer. */
export function DeliveriesTab() {
  const data = useData();
  const toast = useToast();
  const { busy, error, run } = useAction();
  const [status, setStatus] = useState<'pending' | 'delivered' | ''>('pending');
  const [user, setUser] = useState('');
  const [week, setWeek] = useState('');
  const [sel, setSel] = useState<Set<string>>(() => new Set());

  const reqs = useMemo(() => data.txs.filter(isReq), [data.txs]);
  const weeks = useMemo(() => [...new Set(reqs.map(weekOf))].sort((a, b) => b - a), [reqs]);
  const list = useMemo(
    () =>
      reqs
        .filter((t) => (!status || t.deliveryStatus === status) && (!user || t.userId === user) && (!week || String(weekOf(t)) === week))
        .sort((a, b) => byText(a.userName, b.userName) || a.timestamp - b.timestamp),
    [reqs, status, user, week],
  );
  const pending = list.filter((t) => t.deliveryStatus === 'pending');
  const selected = pending.filter((t) => sel.has(t.id));
  const selUnits = selected.reduce((a, t) => a + pendQty(t), 0);

  const toggle = (id: string): void =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allSelected = pending.length > 0 && selected.length === pending.length;

  const deliver = (): void => {
    const ids = selected.map((t) => t.id);
    void run(async () => {
      let delivered = 0;
      let skipped = 0;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const r = await api.adminDeliver(ids.slice(i, i + CHUNK));
        delivered += r.delivered;
        skipped += r.skipped;
      }
      setSel(new Set());
      toast(skipped ? `${plural(delivered, 'línea entregada', 'líneas entregadas')} · ${skipped} ya estaban entregadas` : `${plural(delivered, 'línea entregada', 'líneas entregadas')}`);
    });
  };

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Entregas</h2>
          <span className="sub">
            {pending.length} líneas pendientes en esta vista · {selected.length} seleccionadas ({selUnits} uds)
          </span>
        </div>
        <button type="button" className="btn primary" onClick={deliver} disabled={busy || selected.length === 0}>
          {busy ? 'Entregando…' : `Marcar ${selected.length || ''} como entregadas`}
        </button>
      </div>
      <div className="filters">
        <Field label="Estado" htmlFor="dl-status">
          <select id="dl-status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="pending">Pendientes</option>
            <option value="delivered">Entregadas</option>
            <option value="">Todas</option>
          </select>
        </Field>
        <Field label="Técnico" htmlFor="dl-user">
          <select id="dl-user" value={user} onChange={(e) => setUser(e.target.value)}>
            <option value="">Todos</option>
            {data.workers
              .slice()
              .sort((a, b) => byText(a.name, b.name))
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Semana" htmlFor="dl-week">
          <select id="dl-week" value={week} onChange={(e) => setWeek(e.target.value)}>
            <option value="">Todas</option>
            {weeks.map((w) => (
              <option key={w} value={String(w)}>
                {weekLabel(w)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
      {list.length === 0 ? (
        <Empty>No hay líneas con estos filtros.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Seleccionar todas las pendientes"
                    checked={allSelected}
                    disabled={pending.length === 0}
                    onChange={() => setSel(allSelected ? new Set() : new Set(pending.map((t) => t.id)))}
                  />
                </th>
                <th>Técnico</th>
                <th>Producto</th>
                <th>Cant.</th>
                <th>Tipo</th>
                <th>Semana</th>
                <th>Fecha</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id}>
                  <td>
                    {t.deliveryStatus === 'pending' ? (
                      <input type="checkbox" aria-label={`Seleccionar ${t.productName} de ${t.userName}`} checked={sel.has(t.id)} onChange={() => toggle(t.id)} />
                    ) : null}
                  </td>
                  <td>{t.userName}</td>
                  <td>
                    <span className="mono">{t.productCode}</span> {t.productName}
                  </td>
                  <td>{t.deliveryStatus === 'pending' ? `${pendQty(t)}${pendQty(t) !== t.quantity ? ` de ${t.quantity}` : ''}` : t.quantity}</td>
                  <td>{t.type === 'transfer' ? `Traspaso${t.counterpartName ? ` → ${t.counterpartName}` : ''}` : 'Consumo'}</td>
                  <td>{weekLabel(weekOf(t))}</td>
                  <td>{fmtDate(t.timestamp)}</td>
                  <td>{t.deliveryStatus === 'pending' ? <Pill tone="warn">Pendiente</Pill> : <Pill tone="good">Entregada</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
