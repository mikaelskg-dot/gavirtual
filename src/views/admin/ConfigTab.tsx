import { useMemo, useState } from 'react';
import { api } from '../../api';
import { addDoc, arrayRemove, arrayUnion, collection, deleteDoc, doc, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { db } from '../../firebase';
import { ProductPicker } from '../../components/ProductPicker';
import { useData } from '../../data/DataContext';
import { sortPacks } from '../../lib/catalog';
import { byText, plural } from '../../lib/format';
import { Empty, Field, Modal, useAction, useConfirm, useToast } from '../../ui';

type Target = null | { kind: 'role' | 'pack'; id?: string } | { kind: 'team'; id: string } | { kind: 'packorder' };

const sum = (m: Record<string, number> | undefined): number => Object.values(m ?? {}).reduce((a, n) => a + n, 0);

/** Territorios, roles técnicos (stock base) y packs de consumo. */
export function ConfigTab() {
  const data = useData();
  const toast = useToast();
  const confirm = useConfirm();
  const { error, setError, run } = useAction();
  const [terr, setTerr] = useState('');
  const [modal, setModal] = useState<Target>(null);

  const addTerritory = (): void => {
    const t = terr.trim();
    if (!t) return;
    if (data.territories.some((x) => x.toLowerCase() === t.toLowerCase())) return setError('Ese territorio ya existe.');
    void run(async () => {
      await setDoc(doc(db, 'config', 'settings'), { territories: arrayUnion(t) }, { merge: true });
      setTerr('');
    });
  };

  const removeTerritory = async (t: string): Promise<void> => {
    const n = data.workers.filter((w) => w.territory === t).length;
    if (n) return toast(`Hay ${plural(n, 'técnico', 'técnicos')} en «${t}». Cámbialos de territorio primero.`);
    await run(() => setDoc(doc(db, 'config', 'settings'), { territories: arrayRemove(t) }, { merge: true }));
  };

  const removeRole = async (id: string): Promise<void> => {
    const r = data.roles.find((x) => x.id === id);
    if (!r) return;
    const n = data.workers.filter((w) => w.technicianRoleId === id).length;
    if (n) return toast(`No se puede eliminar: lo usan ${plural(n, 'técnico', 'técnicos')}.`);
    if (!(await confirm({ title: 'Eliminar rol técnico', message: `Se eliminará «${r.name}».`, confirmLabel: 'Eliminar', danger: true }))) return;
    await deleteDoc(doc(db, 'technicianRoles', id));
    toast('Rol eliminado');
  };

  const removePack = async (id: string): Promise<void> => {
    const p = data.packs.find((x) => x.id === id);
    if (!p) return;
    if (!(await confirm({ title: 'Eliminar pack', message: `Se eliminará «${p.name}».`, confirmLabel: 'Eliminar', danger: true }))) return;
    await deleteDoc(doc(db, 'packs', id));
    toast('Pack eliminado');
  };

  return (
    <>
      <section className="card">
        <div className="card-head">
          <div>
            <h2>Roles técnicos y stock base</h2>
            <span className="sub">El stock base es lo que debe llevar cada técnico de ese rol</span>
          </div>
          <button type="button" className="btn primary" onClick={() => setModal({ kind: 'role' })}>
            Nuevo rol
          </button>
        </div>
        {data.roles.length === 0 ? (
          <Empty>Crea al menos un rol para poder dar de alta técnicos.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Rol</th>
                  <th>Productos</th>
                  <th>Unidades base</th>
                  <th>Técnicos</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.roles
                  .slice()
                  .sort((a, b) => byText(a.name, b.name))
                  .map((r) => (
                    <tr key={r.id}>
                      <td>
                        <b>{r.name}</b>
                      </td>
                      <td>{Object.keys(r.baseStock ?? {}).length}</td>
                      <td>{sum(r.baseStock)}</td>
                      <td>
                        <button type="button" className="btn sm" onClick={() => setModal({ kind: 'team', id: r.id })} title="Ver técnicos de este rol">
                          {data.workers.filter((w) => w.technicianRoleId === r.id).length}
                        </button>
                      </td>
                      <td>
                        <div className="actions-cell">
                          <button type="button" className="btn sm" onClick={() => setModal({ kind: 'role', id: r.id })}>
                            Editar
                          </button>
                          <button type="button" className="btn sm danger" onClick={() => void removeRole(r.id)}>
                            Eliminar
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Packs de consumo</h2>
            <span className="sub">Conjuntos de productos que el técnico añade de golpe (p. ej. una instalación tipo)</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {data.packs.length > 1 ? (
              <button type="button" className="btn" onClick={() => setModal({ kind: 'packorder' })}>
                Ordenar packs
              </button>
            ) : null}
            <button type="button" className="btn primary" onClick={() => setModal({ kind: 'pack' })}>
              Nuevo pack
            </button>
          </div>
        </div>
        {data.packs.length === 0 ? (
          <Empty>No hay packs.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Pack</th>
                  <th>Productos</th>
                  <th>Unidades</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sortPacks(data.packs).map((p) => (
                    <tr key={p.id}>
                      <td>
                        <b>{p.name}</b>
                      </td>
                      <td>{Object.keys(p.items ?? {}).length}</td>
                      <td>{sum(p.items)}</td>
                      <td>
                        <div className="actions-cell">
                          <button type="button" className="btn sm" onClick={() => setModal({ kind: 'pack', id: p.id })}>
                            Editar
                          </button>
                          <button type="button" className="btn sm danger" onClick={() => void removePack(p.id)}>
                            Eliminar
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>


      <section className="card">
        <div className="card-head">
          <div>
            <h2>Territorios</h2>
            <span className="sub">Zonas en las que trabajan los técnicos</span>
          </div>
        </div>
        <div className="chips">
          {data.territories.length === 0 ? <Empty>Aún no hay territorios.</Empty> : null}
          {data.territories.map((t) => (
            <span className="chip" key={t}>
              {t}{' '}
              <button type="button" className="x" aria-label={`Eliminar ${t}`} onClick={() => void removeTerritory(t)}>
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="filters">
          <Field label="Nuevo territorio" htmlFor="terr-new">
            <input id="terr-new" value={terr} onChange={(e) => setTerr(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTerritory()} autoComplete="off" />
          </Field>
          <button type="button" className="btn primary" onClick={addTerritory}>
            Añadir
          </button>
        </div>
        {error ? (
          <p className="err" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      {modal?.kind === 'packorder' ? (
        <PackOrderModal
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            toast('Orden de packs guardado');
          }}
        />
      ) : null}
      {modal?.kind === 'team' ? <RoleTeamModal roleId={modal.id} onClose={() => setModal(null)} /> : null}
      {modal && (modal.kind === 'role' || modal.kind === 'pack') ? (
        <QtySetModal
          kind={modal.kind}
          id={modal.id}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            toast(modal.kind === 'role' ? 'Rol guardado' : 'Pack guardado');
          }}
        />
      ) : null}
    </>
  );
}

/** Edita un rol (stock base) o un pack: nombre + cantidades por producto. */
function QtySetModal({ kind, id, onClose, onSaved }: { kind: 'role' | 'pack'; id?: string; onClose: () => void; onSaved: () => void }) {
  const data = useData();
  const { busy, error, setError, run } = useAction();
  const isRole = kind === 'role';
  const cur = isRole ? data.roles.find((r) => r.id === id) : data.packs.find((p) => p.id === id);
  const initial = isRole ? (cur as { baseStock?: Record<string, number> } | undefined)?.baseStock : (cur as { items?: Record<string, number> } | undefined)?.items;
  const [name, setName] = useState(cur?.name ?? '');
  const [qty, setQty] = useState<Record<string, number>>({ ...(initial ?? {}) });
  const total = sum(qty);

  const save = (): void => {
    const n = name.trim();
    if (!n) return setError('Escribe un nombre.');
    const dup = (isRole ? data.roles : data.packs).some((x) => x.name.toLowerCase() === n.toLowerCase() && x.id !== id);
    if (dup) return setError('Ya existe uno con ese nombre.');
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(qty)) if (v > 0) clean[k] = v;
    if (!isRole && Object.keys(clean).length === 0) return setError('Añade al menos un producto al pack.');
    const payload = isRole ? { name: n, baseStock: clean } : { name: n, items: clean };
    void run(async () => {
      const col = isRole ? 'technicianRoles' : 'packs';
      if (id) await updateDoc(doc(db, col, id), payload);
      else await addDoc(collection(db, col), payload);
      onSaved();
    });
  };

  return (
    <Modal
      title={`${id ? 'Editar' : 'Nuevo'} ${isRole ? 'rol técnico' : 'pack'}`}
      onClose={onClose}
      footer={
        <>
          <span className="grow">{total} uds en total</span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar'}
          </button>
        </>
      }
    >
      <Field label="Nombre" htmlFor="qs-name">
        <input id="qs-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </Field>
      <p className="sub">{isRole ? 'Cantidad base de cada producto.' : 'Cantidad de cada producto del pack.'}</p>
      <ProductPicker products={data.products} qty={qty} onChange={(pid, n) => setQty((s) => ({ ...s, [pid]: n }))} />
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

/** Técnicos de un rol, cada uno con un botón para dejarle exactamente su stock base. */
function RoleTeamModal({ roleId, onClose }: { roleId: string; onClose: () => void }) {
  const data = useData();
  const toast = useToast();
  const confirm = useConfirm();
  const [busyId, setBusyId] = useState('');
  const role = data.roles.find((r) => r.id === roleId);
  const team = data.workers.filter((w) => w.technicianRoleId === roleId).sort((a, b) => byText(a.name, b.name));

  const reset = async (uid: string, name: string): Promise<void> => {
    const ok = await confirm({
      title: 'Reset a stock base',
      message: `${name} se quedará exactamente con el stock base de «${role?.name ?? ''}»: se completará lo que le falte y se pondrá a 0 lo que le sobre o no esté en su base. Quedará anotado en el historial como «Reset stock base».`,
      confirmLabel: 'Resetear',
      danger: true,
    });
    if (!ok) return;
    setBusyId(uid);
    try {
      const r = await api.resetToBase(uid);
      toast(`Stock de ${name} reseteado (${plural(r.changed, 'producto', 'productos')})`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'No se ha podido resetear');
    } finally {
      setBusyId('');
    }
  };

  return (
    <Modal title={`Técnicos · ${role?.name ?? ''}`} onClose={onClose}>
      {team.length === 0 ? (
        <Empty>No hay técnicos con este rol.</Empty>
      ) : (
        team.map((w) => (
          <div className="crow" key={w.id}>
            <div className="pn">
              <div className="pname">{w.name}</div>
              <div className="pcode">{[w.employeeCode, w.territory].filter(Boolean).join(' · ')}</div>
            </div>
            <button type="button" className="btn sm" disabled={busyId === w.id} onClick={() => void reset(w.id, w.name)}>
              {busyId === w.id ? 'Reseteando…' : 'Reset a stock base'}
            </button>
          </div>
        ))
      )}
    </Modal>
  );
}

/** Ordena los packs con flechas: es el orden en que los ve el técnico al registrar un consumo. */
function PackOrderModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const data = useData();
  const { busy, error, run } = useAction();
  const initial = useMemo(() => sortPacks(data.packs).map((p) => p.id), [data.packs]);
  const [ids, setIds] = useState(initial);
  const byId = useMemo(() => new Map(data.packs.map((p) => [p.id, p])), [data.packs]);

  const move = (i: number, d: -1 | 1): void =>
    setIds((s) => {
      const a = s.slice();
      const j = i + d;
      if (j < 0 || j >= a.length) return s;
      [a[i], a[j]] = [a[j], a[i]];
      return a;
    });

  const save = (): void => {
    const changed = ids.map((id, i) => ({ id, pos: i + 1 })).filter((x) => byId.get(x.id)?.order !== x.pos);
    void run(async () => {
      for (let i = 0; i < changed.length; i += 400) {
        const b = writeBatch(db);
        changed.slice(i, i + 400).forEach((x) => b.update(doc(db, 'packs', x.id), { order: x.pos }));
        await b.commit();
      }
      onDone();
    });
  };

  return (
    <Modal
      title="Ordenar packs"
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar orden'}
          </button>
        </>
      }
    >
      <p className="sub" style={{ marginBottom: 10 }}>
        Es el orden en que el técnico ve los packs al registrar un consumo. Sube y baja con las flechas y pulsa «Guardar orden».
      </p>
      {ids.map((id, i) => {
        const p = byId.get(id);
        if (!p) return null;
        return (
          <div className="crow" key={id}>
            <span className="mono" style={{ width: 26, flex: 'none', color: 'var(--ink-2)' }}>
              {i + 1}
            </span>
            <div className="pn" style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
              <div className="pname">{p.name}</div>
              <div className="pcode">{plural(Object.keys(p.items ?? {}).length, 'producto', 'productos')}</div>
            </div>
            <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
              <button type="button" className="btn sm" onClick={() => move(i, -1)} disabled={i === 0 || busy} aria-label={`Subir ${p.name}`}>
                ▲
              </button>
              <button type="button" className="btn sm" onClick={() => move(i, 1)} disabled={i === ids.length - 1 || busy} aria-label={`Bajar ${p.name}`}>
                ▼
              </button>
            </div>
          </div>
        );
      })}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
