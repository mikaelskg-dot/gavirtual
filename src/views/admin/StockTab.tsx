import { useMemo, useState } from 'react';
import { useData } from '../../data/DataContext';
import { byText } from '../../lib/format';
import { baseOf, qtyOf } from '../../lib/stock';
import { api } from '../../api';
import { Empty, Field, Modal, Pill, Stepper, useAction, useToast } from '../../ui';

/** Matriz de stock: técnicos en filas, productos de una carpeta en columnas. */
export function StockTab() {
  const data = useData();
  const [territory, setTerritory] = useState('');
  const [folder, setFolder] = useState('');
  const [q, setQ] = useState('');
  const [adj, setAdj] = useState<{ uid: string; pid: string } | null>(null);
  const toast = useToast();

  const workers = useMemo(
    () => data.workers.filter((w) => !territory || w.territory === territory).sort((a, b) => byText(a.name, b.name)),
    [data.workers, territory],
  );
  const products = useMemo(() => {
    const s = q.trim().toLowerCase();
    return data.products
      .filter((p) => (!folder || p.category === folder) && (!s || `${p.code} ${p.name}`.toLowerCase().includes(s)))
      .sort((a, b) => byText(a.code, b.code));
  }, [data.products, folder, q]);
  const roleOf = (id: string) => data.roles.find((r) => r.id === id);

  let soldOut = 0;
  const cells = workers.map((w) => {
    const role = roleOf(w.technicianRoleId);
    return products.map((p) => {
      const c = qtyOf(data.stock[w.id], p.id);
      const base = baseOf(role, p.id);
      const zero = c === 0 && base > 0;
      if (zero) soldOut++;
      return { c, zero, none: c === 0 && base === 0 };
    });
  });

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Stock de todos los técnicos</h2>
          <span className="sub">
            {workers.length} técnicos · {products.length} productos · {soldOut} agotados
          </span>
        </div>
      </div>
      <div className="filters">
        <Field label="Territorio" htmlFor="stock-terr">
          <select id="stock-terr" value={territory} onChange={(e) => setTerritory(e.target.value)}>
            <option value="">Todos</option>
            {data.territories.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Carpeta" htmlFor="stock-folder">
          <select id="stock-folder" value={folder} onChange={(e) => setFolder(e.target.value)}>
            <option value="">Todas</option>
            {data.folderNames.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Buscar producto" htmlFor="stock-q">
          <input id="stock-q" type="search" value={q} placeholder="Código o nombre" onChange={(e) => setQ(e.target.value)} />
        </Field>
      </div>
      {workers.length === 0 ? (
        <Empty>No hay técnicos {territory ? 'en este territorio' : 'todavía. Créalos en la pestaña Equipo'}.</Empty>
      ) : products.length === 0 ? (
        <Empty>No hay productos con estos filtros.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="t matrix">
            <thead>
              <tr>
                <th className="k">Técnico</th>
                {products.map((p) => (
                  <th key={p.id} title={p.name}>
                    <span className="mono">{p.code}</span>
                    <span className="pn">{p.name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="k" style={{ fontWeight: 600, background: 'var(--surface-2)' }}>
                  Total en campo
                </td>
                {products.map((p) => (
                  <td key={p.id} style={{ fontWeight: 600, background: 'var(--surface-2)' }}>
                    {workers.reduce((a, w) => a + qtyOf(data.stock[w.id], p.id), 0)}
                  </td>
                ))}
              </tr>
              {workers.map((w, i) => (
                <tr key={w.id}>
                  <td className="k">
                    <b>{w.name}</b>
                    <span className="sub">{[w.territory, roleOf(w.technicianRoleId)?.name].filter(Boolean).join(' · ')}</span>
                  </td>
                  {cells[i].map((c, j) => (
                    <td key={products[j].id} className={c.zero ? 'zero' : c.none ? 'dash' : ''}>
                      <button type="button" className="cellbtn" title="Ajustar stock" aria-label={`Ajustar ${products[j].name} de ${w.name}`} onClick={() => setAdj({ uid: w.id, pid: products[j].id })}>
                        {c.none ? '–' : c.c}
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adj ? (
        <AdjustModal
          uid={adj.uid}
          pid={adj.pid}
          onClose={() => setAdj(null)}
          onSaved={(delta) => {
            setAdj(null);
            toast(`Stock ajustado (${delta > 0 ? '+' : ''}${delta})`);
          }}
        />
      ) : null}
      <div className="legend">
        <span>
          <Pill tone="crit">Agotado</Pill> sin unidades de un producto de su stock base
        </span>
        <span>– no es de su stock base y no tiene</span>
        <span>Pulsa una cifra para ajustar el stock real</span>
      </div>
    </section>
  );
}

function AdjustModal({ uid, pid, onClose, onSaved }: { uid: string; pid: string; onClose: () => void; onSaved: (delta: number) => void }) {
  const data = useData();
  const { busy, error, setError, run } = useAction();
  const worker = data.workers.find((w) => w.id === uid);
  const product = data.products.find((p) => p.id === pid);
  const current = qtyOf(data.stock[uid], pid);
  const base = baseOf(data.roles.find((r) => r.id === worker?.technicianRoleId), pid);
  const [qty, setQty] = useState(current);
  const [note, setNote] = useState('');

  const save = (): void => {
    if (qty === current) return setError('Cambia la cantidad para poder ajustar.');
    if (!note.trim()) return setError('Indica el motivo del ajuste (inventario, pérdida, alta inicial...).');
    void run(async () => {
      const r = await api.adjustStock(uid, pid, qty, note.trim());
      onSaved(r.delta);
    });
  };

  return (
    <Modal
      title="Ajustar stock"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar ajuste'}
          </button>
        </>
      }
    >
      <p>
        <b>{worker?.name}</b> · <span className="mono">{product?.code}</span> {product?.name}
      </p>
      <p className="sub">
        En la app tiene {current}
        {base ? ` (stock base: ${base})` : ''}. Indica la cantidad real que lleva ahora.
      </p>
      <div className="field">
        <label>Cantidad real</label>
        <Stepper value={qty} onChange={setQty} label={product?.name ?? 'producto'} />
      </div>
      <Field label="Motivo (obligatorio)" htmlFor="adj-note">
        <input id="adj-note" value={note} placeholder="Ej. inventario, pérdida, alta inicial" onChange={(e) => setNote(e.target.value)} autoComplete="off" />
      </Field>
      <p className="sub">Queda registrado en el historial con la diferencia. No cuenta como consumo ni genera entregas pendientes.</p>
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
