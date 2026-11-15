import { useMemo, useState } from 'react';
import { api } from '../../api';
import { ProductPicker } from '../../components/ProductPicker';
import { useData } from '../../data/DataContext';
import { sortPacks } from '../../lib/catalog';
import { uds } from '../../lib/format';
import { qtyOf } from '../../lib/stock';
import type { Pack, UserDoc } from '../../types';
import { Field, Modal, useAction, useToast } from '../../ui';

export type CartType = 'consume' | 'extra' | 'transfer' | 'return';

const CFG = {
  consume: {
    title: 'Registrar consumo',
    cta: 'Registrar consumo',
    done: 'Consumo registrado',
    limit: true,
    noteLabel: 'Work Order o motivo (obligatorio)',
    notePh: 'Ej. WO-31890, avería en cliente',
    noteReq: true,
  },
  extra: {
    title: 'Recibir material extra',
    cta: 'Registrar recepción',
    done: 'Material extra registrado',
    limit: false,
    noteLabel: 'Motivo (opcional)',
    notePh: 'Ej. Producto especial para una instalación',
    noteReq: false,
  },
  transfer: {
    title: 'Traspasar material',
    cta: 'Realizar traspaso',
    done: 'Traspaso realizado',
    limit: true,
    noteLabel: 'Motivo (opcional)',
    notePh: 'Ej. Cubrir una avería urgente',
    noteReq: false,
  },
  return: {
    title: 'Devolver a almacén',
    cta: 'Devolver material',
    done: 'Devuelto a almacén',
    limit: true,
    noteLabel: 'Motivo (opcional)',
    notePh: 'Ej. Material de más, producto sin usar',
    noteReq: false,
  },
} as const;

/** Consumo, material extra o traspaso: eliges productos (o un pack) y cantidades. */
export function CartModal({ type, me, onClose }: { type: CartType; me: UserDoc; onClose: () => void }) {
  const cfg = CFG[type];
  const data = useData();
  const toast = useToast();
  const { busy, error, setError, run } = useAction();
  const [note, setNote] = useState('');
  const [to, setTo] = useState('');
  const [qty, setQty] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState('');
  const [packId, setPackId] = useState('');
  const [ckind, setCkind] = useState<'' | 'repair' | 'network' | 'install'>('');

  const items = data.stock[me.id];
  const eligible = useMemo(() => (cfg.limit ? data.products.filter((p) => qtyOf(items, p.id) > 0) : data.products), [cfg.limit, data.products, items]);
  const lines = Object.entries(qty).filter(([, n]) => n > 0);
  const units = lines.reduce((a, [, n]) => a + n, 0);
  // Resumen compacto: cada producto una vez; si la cantidad no es 1, va entre paréntesis.
  const summary = lines
    .map(([pid, n]) => ({ pid, n, name: data.products.find((p) => p.id === pid)?.name ?? pid }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));

  const setOne = (pid: string, n: number): void => {
    setQty((q) => ({ ...q, [pid]: n }));
    setError('');
    setNotice('');
  };

  // Solo se puede añadir un pack, una vez. Pulsar de nuevo el pack activo lo quita.
  const addPack = (pk: Pack): void => {
    const next = { ...qty };
    if (packId === pk.id) {
      for (const [pid, n] of Object.entries(pk.items)) if (next[pid] !== undefined) next[pid] = Math.max(0, next[pid] - n);
      setQty(next);
      setPackId('');
      setError('');
      setNotice('');
      return;
    }
    if (packId) return;
    let capped = false;
    for (const [pid, n] of Object.entries(pk.items)) {
      if (!data.products.some((p) => p.id === pid)) continue;
      const want = (next[pid] ?? 0) + n;
      const got = Math.min(want, qtyOf(items, pid));
      if (got < want) capped = true;
      if (got > 0) next[pid] = got;
    }
    setQty(next);
    setPackId(pk.id);
    setError('');
    setNotice(capped ? 'Algunos productos del pack se limitaron a tu stock disponible.' : '');
  };

  const submit = (): void => {
    if (cfg.noteReq && !note.trim()) return setError('Escribe la Work Order o el motivo del consumo.');
    if (type === 'transfer' && !to) return setError('Elige a qué técnico entregas el material.');
    if (type === 'consume' && !ckind) return setError('Marca el tipo: Reparación, Conexión a red o Instalación.');
    if (!lines.length) return setError('Selecciona al menos un producto.');
    void run(async () => {
      const input = lines.map(([productId, quantity]) => ({ productId, quantity }));
      if (type === 'consume') await api.registerConsumption(note.trim(), input, ckind);
      else if (type === 'extra') await api.registerExtra(note.trim(), input);
      else if (type === 'return') await api.returnToWarehouse(note.trim(), input);
      else await api.registerTransfer(to, note.trim(), input);
      toast(`${cfg.done}: ${uds(units)}`);
      onClose();
    });
  };

  return (
    <Modal
      title={cfg.title}
      onClose={onClose}
      footer={
        <>
          {summary.length ? (
            <ul className="cartsum" aria-label="Resumen de lo seleccionado">
              {summary.map((x) => (
                <li key={x.pid}>
                  {x.name}
                  {x.n !== 1 ? <b> ({x.n})</b> : null}
                </li>
              ))}
            </ul>
          ) : null}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className="btn primary" onClick={submit} disabled={busy}>
            {busy ? 'Guardando…' : cfg.cta}
          </button>
        </>
      }
    >
      {type === 'transfer' ? (
        <Field label="Entregar a" htmlFor="m-to">
          <select id="m-to" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Elige un técnico…</option>
            {data.workers
              .filter((w) => w.id !== me.id)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                  {w.territory ? ` · ${w.territory}` : ''}
                </option>
              ))}
          </select>
        </Field>
      ) : null}
      <Field label={cfg.noteLabel} htmlFor="m-note">
        <input id="m-note" value={note} placeholder={cfg.notePh} autoComplete="off" maxLength={120} onChange={(e) => {
              setNote(e.target.value);
              setError('');
            }} />
      </Field>
      {type === 'consume' ? (
        <div className="kinds" role="group" aria-label="Tipo de consumo (obligatorio)">
          {([['install', 'Instalación'], ['repair', 'Reparación'], ['network', 'Conexión a red']] as const).map(([id, label]) => (
            <label className="kind" key={id}>
              <input type="checkbox" checked={ckind === id} onChange={(e) => { setCkind(e.target.checked ? id : ''); setError(''); }} />
              {label}
            </label>
          ))}
        </div>
      ) : null}
      {type === 'consume' && data.packs.length ? (
        <div className="field">
          <span className="lbl">Añadir un pack completo</span>
          <div className="chips">
            {sortPacks(data.packs).map((pk) => (
              <button type="button" key={pk.id} className="chip" aria-pressed={packId === pk.id} disabled={!!packId && packId !== pk.id} onClick={() => addPack(pk)}>
                {pk.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {notice ? <div className="note">{notice}</div> : null}
      <ProductPicker
        products={eligible}
        compact={type === 'consume'}
        qty={qty}
        onChange={setOne}
        max={cfg.limit ? (pid) => qtyOf(items, pid) : undefined}
        hint={cfg.limit ? (p) => ` · Disponible: ${qtyOf(items, p.id)}` : undefined}
        emptyText={cfg.limit ? 'No tienes material disponible.' : 'El catálogo está vacío.'}
      />
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
