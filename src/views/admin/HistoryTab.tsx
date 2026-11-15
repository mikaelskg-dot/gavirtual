import { useMemo, useState } from 'react';
import { HistoryList } from '../../components/HistoryList';
import { HISTORY_DAYS, useData } from '../../data/DataContext';
import { byText } from '../../lib/format';
import { dayEnd, dayStart } from '../../lib/ledger';
import { consKind, groupTx } from '../../lib/history';
import { Field } from '../../ui';

/** Historial de todos los movimientos con filtros combinados (fecha, técnico, tipo), agrupado por Work Order. */
export function HistoryTab() {
  const data = useData();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [user, setUser] = useState('');
  const [type, setType] = useState('');

  const list = useMemo(() => {
    const a = from ? dayStart(from) : 0;
    const b = to ? dayEnd(to) : Infinity;
    return data.txs.filter(
      (t) => t.timestamp >= a && t.timestamp <= b && (!user || t.userId === user || t.counterpartId === user) && (!type || (type === 'return' ? t.kind === 'return' : type === 'repair' || type === 'network' || type === 'install' ? t.type === 'consumption' && consKind(t) === type : t.type === type)),
    );
  }, [data.txs, from, to, user, type]);
  const groups = useMemo(() => groupTx(list).length, [list]);

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Traspasos e historial</h2>
          <span className="sub">
            {groups} movimientos agrupados · {list.length} líneas · últimos {HISTORY_DAYS} días y todo lo pendiente
          </span>
        </div>
      </div>
      <div className="filters">
        <Field label="Desde" htmlFor="hf-from">
          <input id="hf-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Hasta" htmlFor="hf-to">
          <input id="hf-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Técnico" htmlFor="hf-user">
          <select id="hf-user" value={user} onChange={(e) => setUser(e.target.value)}>
            <option value="">Todos los técnicos</option>
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
        <Field label="Tipo" htmlFor="hf-type">
          <select id="hf-type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Todos los tipos</option>
            <option value="consumption">Consumos</option>
            <option value="repair">Reparaciones</option>
            <option value="network">Conexión a red</option>
            <option value="install">Instalaciones</option>
            <option value="return">Devoluciones a almacén</option>
            <option value="restock">Reposiciones</option>
            <option value="transfer">Traspasos</option>
          </select>
        </Field>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setFrom('');
            setTo('');
            setUser('');
            setType('');
          }}
        >
          Quitar filtros
        </button>
      </div>
      <HistoryList txs={list} showUser key={`${from}|${to}|${user}|${type}`} />
    </section>
  );
}
