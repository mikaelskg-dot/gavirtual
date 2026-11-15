import { useMemo, useState } from 'react';
import { addDoc, collection, deleteDoc, deleteField, doc, updateDoc, writeBatch, type WriteBatch } from 'firebase/firestore';
import { db } from '../../firebase';
import { useData } from '../../data/DataContext';
import { byPriority, matchesProduct, PRIORITY_LABEL } from '../../lib/catalog';
import type { Priority } from '../../types';
import { byText } from '../../lib/format';
import { Empty, Field, Modal, Pill, useAction, useConfirm, useToast } from '../../ui';

type ModalState = null | { kind: 'product'; id?: string; folder?: string } | { kind: 'folder'; old?: string } | { kind: 'order' };

const FOLDER_ICON = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
  </svg>
);

type Op = (b: WriteBatch) => void;

/** Ejecuta escrituras en lotes (Firestore admite 500 por lote). */
async function runBatches(ops: Op[]): Promise<void> {
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach((op) => op(b));
    await b.commit();
  }
}

/** Catálogo organizado en carpetas. */
export function CatalogTab() {
  const data = useData();
  const toast = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [modal, setModal] = useState<ModalState>(null);

  const cats = useMemo(
    () => data.folderNames.filter((c) => !q.trim() || data.products.some((p) => p.category === c && matchesProduct(p, q))),
    [data.folderNames, data.products, q],
  );
  const searching = q.trim().length > 0;

  const toggle = (name: string): void =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  const deleteFolder = async (name: string): Promise<void> => {
    const n = data.products.filter((p) => p.category === name).length;
    if (n) return toast(`Mueve o elimina primero los ${n} productos de «${name}»`);
    const f = data.folders.find((x) => x.name === name);
    if (f) await deleteDoc(doc(db, 'folders', f.id));
    toast('Carpeta eliminada');
  };

  const deleteProduct = async (id: string): Promise<void> => {
    const p = data.products.find((x) => x.id === id);
    if (!p) return;
    const ok = await confirm({
      title: 'Eliminar producto',
      message: `Se eliminará «${p.name}» del catálogo, de los stocks base y de los packs. El historial conserva sus movimientos.`,
      confirmLabel: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    const ops: Op[] = [(b) => b.delete(doc(db, 'catalog', id))];
    for (const r of data.roles) if (r.baseStock?.[id] !== undefined) ops.push((b) => b.update(doc(db, 'technicianRoles', r.id), { [`baseStock.${id}`]: deleteField() }));
    for (const k of data.packs) if (k.items?.[id] !== undefined) ops.push((b) => b.update(doc(db, 'packs', k.id), { [`items.${id}`]: deleteField() }));
    try {
      await runBatches(ops);
      toast('Producto eliminado');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'No se ha podido eliminar');
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Catálogo de productos</h2>
          <span className="sub">
            {data.products.length} productos en {data.folderNames.length} carpetas
          </span>
        </div>
        <div className="chips">
          <button type="button" className="btn" onClick={() => setModal({ kind: 'order' })}>
            Ordenar habituales
          </button>
          <button type="button" className="btn" onClick={() => setModal({ kind: 'folder' })}>
            Nueva carpeta
          </button>
          <button type="button" className="btn primary" onClick={() => setModal({ kind: 'product' })}>
            Nuevo producto
          </button>
        </div>
      </div>
      <div className="filters">
        <Field label="Buscar" htmlFor="cat-q">
          <input id="cat-q" type="search" value={q} placeholder="Código o nombre" onChange={(e) => setQ(e.target.value)} />
        </Field>
        <button type="button" className="btn" onClick={() => setOpen(new Set(data.folderNames))}>
          Abrir todas
        </button>
        <button type="button" className="btn" onClick={() => setOpen(new Set())}>
          Cerrar todas
        </button>
      </div>
      {cats.length === 0 ? (
        <Empty>{searching ? 'Ningún producto coincide con la búsqueda.' : 'Aún no hay carpetas. Crea la primera.'}</Empty>
      ) : (
        <div className="folders">
          {cats.map((c) => {
            const all = data.products.filter((p) => p.category === c);
            const list = all.filter((p) => matchesProduct(p, q)).sort((a, b) => byText(a.code, b.code));
            const isOpen = searching || open.has(c);
            return (
              <div className="folder" key={c}>
                <div className="fhead">
                  <button type="button" className="fbtn" aria-expanded={isOpen} onClick={() => toggle(c)}>
                    <span className="chev" aria-hidden="true">
                      ›
                    </span>
                    {FOLDER_ICON}
                    <span className="fname">{c}</span>
                    <Pill>{searching ? `${list.length} de ${all.length}` : all.length}</Pill>
                  </button>
                  {isOpen ? (
                    <div className="actions-cell">
                      <button type="button" className="btn sm" onClick={() => setModal({ kind: 'product', folder: c })}>
                        Añadir producto
                      </button>
                      <button type="button" className="btn sm" onClick={() => setModal({ kind: 'folder', old: c })}>
                        Renombrar
                      </button>
                      <button type="button" className="btn sm danger" onClick={() => void deleteFolder(c)}>
                        Eliminar
                      </button>
                    </div>
                  ) : null}
                </div>
                {isOpen ? (
                  <div className="fbody">
                    {list.length ? (
                      <div className="table-wrap">
                        <table className="t">
                          <thead>
                            <tr>
                              <th>Código</th>
                              <th>Producto</th>
                              <th />
                            </tr>
                          </thead>
                          <tbody>
                            {list.map((p) => (
                              <tr key={p.id}>
                                <td className="mono">{p.code}</td>
                                <td>
                                  {p.name}
                                  {p.priority ? (
                                    <>
                                      {' '}
                                      <Pill tone={p.priority === 'muy-habitual' ? 'info' : undefined}>{PRIORITY_LABEL[p.priority]}</Pill>
                                    </>
                                  ) : null}
                                </td>
                                <td>
                                  <div className="actions-cell">
                                    <button type="button" className="btn sm" onClick={() => setModal({ kind: 'product', id: p.id })}>
                                      Editar
                                    </button>
                                    <button type="button" className="btn sm danger" onClick={() => void deleteProduct(p.id)}>
                                      Eliminar
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <Empty>Esta carpeta está vacía.</Empty>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {modal?.kind === 'order' ? (
        <OrderModal
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            toast('Orden guardado');
          }}
        />
      ) : null}
      {modal?.kind === 'product' ? (
        <ProductModal
          id={modal.id}
          folder={modal.folder}
          onClose={() => setModal(null)}
          onSaved={(folder) => {
            setOpen((s) => new Set(s).add(folder));
            setModal(null);
            toast('Producto guardado');
          }}
        />
      ) : null}
      {modal?.kind === 'folder' ? (
        <FolderModal
          old={modal.old}
          onClose={() => setModal(null)}
          onSaved={(name, renamed) => {
            setOpen((s) => {
              const n = new Set(s);
              if (modal.old) n.delete(modal.old);
              return n.add(name);
            });
            setModal(null);
            toast(renamed ? 'Carpeta renombrada' : 'Carpeta creada');
          }}
        />
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function ProductModal({ id, folder, onClose, onSaved }: { id?: string; folder?: string; onClose: () => void; onSaved: (folder: string) => void }) {
  const data = useData();
  const { busy, error, setError, run } = useAction();
  const cur = id ? data.products.find((p) => p.id === id) : undefined;
  const [code, setCode] = useState(cur?.code ?? '');
  const [name, setName] = useState(cur?.name ?? '');
  const [category, setCategory] = useState(cur?.category ?? folder ?? data.folderNames[0] ?? '');
  const [priority, setPriority] = useState<Priority>(cur?.priority ?? '');

  const save = (): void => {
    const c = code.trim();
    const n = name.trim();
    if (!category) return setError('Crea primero una carpeta para guardar el producto.');
    if (!c || !n) return setError('El código y el nombre son obligatorios.');
    if (data.products.some((p) => p.code.toLowerCase() === c.toLowerCase() && p.id !== id)) return setError('Ya existe un producto con ese código.');
    void run(async () => {
      if (id) await updateDoc(doc(db, 'catalog', id), { code: c, name: n, category, priority });
      else await addDoc(collection(db, 'catalog'), { code: c, name: n, category, priority });
      onSaved(category);
    });
  };

  return (
    <Modal
      title={id ? 'Editar producto' : 'Nuevo producto'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar'}
          </button>
        </>
      }
    >
      <div className="formgrid">
        <Field label="Código" htmlFor="pf-code">
          <input id="pf-code" value={code} placeholder="CON-SC01" onChange={(e) => setCode(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Nombre" htmlFor="pf-name">
          <input id="pf-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Carpeta" htmlFor="pf-cat">
          <select id="pf-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
            {data.folderNames.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Prioridad" htmlFor="pf-prio">
          <select id="pf-prio" value={priority} onChange={(e) => setPriority(e.target.value === 'muy-habitual' ? 'muy-habitual' : e.target.value === 'habitual' ? 'habitual' : '')}>
            <option value="">Ninguna</option>
            <option value="muy-habitual">Muy habitual</option>
            <option value="habitual">Habitual</option>
          </select>
        </Field>
      </div>
      <p className="sub">Los productos habituales aparecen arriba al registrar un consumo.</p>
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

function FolderModal({ old, onClose, onSaved }: { old?: string; onClose: () => void; onSaved: (name: string, renamed: boolean) => void }) {
  const data = useData();
  const { busy, error, setError, run } = useAction();
  const [name, setName] = useState(old ?? '');

  const save = (): void => {
    const n = name.trim();
    if (!n) return setError('Escribe un nombre para la carpeta.');
    if (data.folderNames.some((c) => c.toLowerCase() === n.toLowerCase() && c !== old)) return setError('Ya existe una carpeta con ese nombre.');
    void run(async () => {
      if (!old) await addDoc(collection(db, 'folders'), { name: n });
      else {
        const ops: Op[] = [];
        const f = data.folders.find((x) => x.name === old);
        if (f) ops.push((b) => b.update(doc(db, 'folders', f.id), { name: n }));
        else ops.push((b) => b.set(doc(collection(db, 'folders')), { name: n }));
        for (const p of data.products) if (p.category === old) ops.push((b) => b.update(doc(db, 'catalog', p.id), { category: n }));
        await runBatches(ops);
      }
      onSaved(n, !!old);
    });
  };

  return (
    <Modal
      title={old ? 'Renombrar carpeta' : 'Nueva carpeta'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar'}
          </button>
        </>
      }
    >
      <Field label="Nombre de la carpeta" htmlFor="ff-name">
        <input id="ff-name" value={name} placeholder="Ej. Herramientas" onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </Field>
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

/** Orden de los productos «muy habituales» y «habituales»: es el que ve el técnico al registrar un consumo. */
function OrderModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const data = useData();
  const { busy, error, run } = useAction();
  const initial = useMemo(() => {
    const m: Record<'muy-habitual' | 'habitual', string[]> = { 'muy-habitual': [], habitual: [] };
    for (const g of byPriority(data.products)) m[g.priority] = g.items.map((p) => p.id);
    return m;
  }, [data.products]);
  const [lists, setLists] = useState(initial);
  const byId = useMemo(() => new Map(data.products.map((p) => [p.id, p])), [data.products]);

  const move = (k: 'muy-habitual' | 'habitual', i: number, d: -1 | 1): void =>
    setLists((s) => {
      const a = s[k].slice();
      const j = i + d;
      if (j < 0 || j >= a.length) return s;
      [a[i], a[j]] = [a[j], a[i]];
      return { ...s, [k]: a };
    });

  const save = (): void => {
    const ops: Op[] = [];
    for (const k of ['muy-habitual', 'habitual'] as const)
      lists[k].forEach((id, i) => {
        if (byId.get(id)?.order !== i + 1) ops.push((b) => b.update(doc(db, 'catalog', id), { order: i + 1 }));
      });
    void run(async () => {
      if (ops.length) await runBatches(ops);
      onDone();
    });
  };

  const section = (k: 'muy-habitual' | 'habitual') => (
    <div key={k} style={{ marginBottom: 14 }}>
      <h3 className="sub" style={{ margin: '4px 0' }}>
        {k === 'muy-habitual' ? 'Muy habituales' : 'Habituales'}
      </h3>
      {lists[k].length === 0 ? <Empty>No hay productos {k === 'muy-habitual' ? 'muy habituales' : 'habituales'}.</Empty> : null}
      {lists[k].map((id, i) => {
        const p = byId.get(id);
        if (!p) return null;
        return (
          <div className="crow" key={id}>
            <span className="mono" style={{ width: 26, flex: 'none', color: 'var(--ink-2)' }}>
              {i + 1}
            </span>
            <div className="pn" style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
              <div className="pname">{p.name}</div>
              <div className="pcode">{p.code}</div>
            </div>
            <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
              <button type="button" className="btn sm" onClick={() => move(k, i, -1)} disabled={i === 0 || busy} aria-label={`Subir ${p.name}`}>
                ▲
              </button>
              <button type="button" className="btn sm" onClick={() => move(k, i, 1)} disabled={i === lists[k].length - 1 || busy} aria-label={`Bajar ${p.name}`}>
                ▼
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <Modal
      title="Ordenar habituales"
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
        Es el orden en que el técnico ve estos productos al registrar un consumo. Sube y baja con las flechas y pulsa «Guardar orden».
      </p>
      {section('muy-habitual')}
      {section('habitual')}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
