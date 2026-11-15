import { useMemo, useState } from 'react';
import { addDoc, collection, deleteDoc, doc, query, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { db } from '../../firebase';
import { useData, useQuery } from '../../data/DataContext';
import { addDays, fmtShort, isDate, toDay, todayMadrid } from '../../lib/calendar';
import {
  ITV_ORDER, assignmentDays, closingFor, currentAssignment, fmtPlate, historyOf, isPlate, itvState, nextAssignment, normPlate,
  type Asignacion, type ItvState, type Vehiculo,
} from '../../lib/fleet';
import { Empty, Field, Modal, Pill, useAction, useConfirm, useToast } from '../../ui';

const COL_VEH = 'flota_vehiculos';
const COL_ASI = 'flota_asignaciones';

type ModalState = null | { kind: 'veh'; id?: string } | { kind: 'assign'; veh: Vehiculo; edit?: Asignacion } | { kind: 'history'; veh: Vehiculo };
type Filter = 'all' | 'free' | 'itv';

const nameOf = (a: Asignacion, users: { id: string; name: string }[]): string => (a.tipo === 'tecnico' ? users.find((u) => u.id === a.userId)?.name ?? a.nombre : a.nombre);

function ItvPill({ s }: { s: ItvState }) {
  if (s.level === 'none') return <Pill>Sin fecha</Pill>;
  const d = s.days ?? 0;
  if (s.level === 'expired') return <Pill tone="crit">Vencida hace {-d} {-d === 1 ? 'día' : 'días'}</Pill>;
  if (s.level === 'urgent') return <Pill tone="crit">{d === 0 ? 'Vence hoy' : `Vence en ${d} ${d === 1 ? 'día' : 'días'}`}</Pill>;
  if (s.level === 'soon') return <Pill tone="warn">Vence en {d} días</Pill>;
  return <Pill tone="good">Al día</Pill>;
}

/** Flota: vehículos, quién los tiene (técnico o nombre escrito) con fechas, e ITV. Para almacén y administrador. */
export function FleetTab() {
  const data = useData();
  const today = useMemo(() => todayMadrid(), []);
  const vq = useQuery<Vehiculo>(() => query(collection(db, COL_VEH)), []);
  const aq = useQuery<Asignacion>(() => query(collection(db, COL_ASI)), []);
  const [modal, setModal] = useState<ModalState>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'plate' | 'itv'>('plate');
  const toast = useToast();
  const confirm = useConfirm();

  const users = data.users;
  const rows = useMemo(
    () =>
      vq.data.map((v) => ({
        v,
        cur: currentAssignment(aq.data, v.id, today),
        next: nextAssignment(aq.data, v.id, today),
        itv: itvState(v.itvVence, today),
      })),
    [vq.data, aq.data, today],
  );

  const stats = useMemo(
    () => ({
      total: rows.length,
      free: rows.filter((r) => !r.cur).length,
      expired: rows.filter((r) => r.itv.level === 'expired').length,
      urgent: rows.filter((r) => r.itv.level === 'urgent').length,
    }),
    [rows],
  );

  const shown = useMemo(() => {
    const needle = normPlate(q);
    const text = q.trim().toLowerCase();
    return rows
      .filter((r) => (filter === 'free' ? !r.cur : filter === 'itv' ? r.itv.level === 'expired' || r.itv.level === 'urgent' || r.itv.level === 'soon' : true))
      .filter(
        (r) =>
          !text ||
          (needle && r.v.matricula.includes(needle)) ||
          `${r.v.marca ?? ''} ${r.v.modelo ?? ''}`.toLowerCase().includes(text) ||
          (r.cur ? nameOf(r.cur, users).toLowerCase().includes(text) : false),
      )
      .sort((a, b) =>
        sort === 'itv'
          ? ITV_ORDER[a.itv.level] - ITV_ORDER[b.itv.level] || (a.itv.days ?? 0) - (b.itv.days ?? 0) || a.v.matricula.localeCompare(b.v.matricula)
          : a.v.matricula.localeCompare(b.v.matricula),
      );
  }, [rows, filter, q, sort, users]);

  const release = async (v: Vehiculo, cur: Asignacion): Promise<void> => {
    const ok = await confirm({
      title: 'Liberar vehículo',
      message: `${fmtPlate(v.matricula)} dejará de estar asignado a ${nameOf(cur, users)} a partir de hoy. Queda en el historial.`,
      confirmLabel: 'Liberar',
    });
    if (!ok) return;
    try {
      // Libre desde hoy: el último día con él fue ayer. Si empezó hoy mismo, la asignación no llegó a existir y se borra.
      if (cur.desde >= today) await deleteDoc(doc(db, COL_ASI, cur.id));
      else await updateDoc(doc(db, COL_ASI, cur.id), { hasta: addDays(today, -1) });
      toast('Vehículo liberado');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'No se ha podido liberar');
    }
  };

  const loading = !vq.loaded || !aq.loaded;
  const errors = [vq.error, aq.error].filter(Boolean);

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Flota</h2>
          <span className="sub">Vehículos, quién los tiene y cuándo, y el control de la ITV.</span>
        </div>
        <button type="button" className="btn primary" onClick={() => setModal({ kind: 'veh' })}>
          Nuevo vehículo
        </button>
      </div>

      {errors.length ? (
        <p className="err" role="alert">
          No se ha podido cargar la flota: {errors.join(', ')}. ¿Has desplegado las reglas de Firestore?
        </p>
      ) : null}

      <div className="stats" style={{ marginBottom: 12 }}>
        <div className="stat">
          <div className="n">{stats.total}</div>
          <div className="l">Vehículos</div>
        </div>
        <div className="stat">
          <div className="n">{stats.free}</div>
          <div className="l">Libres hoy</div>
        </div>
        <div className={stats.expired ? 'stat warn' : 'stat'}>
          <div className="n">{stats.expired}</div>
          <div className="l">ITV vencidas</div>
        </div>
        <div className={stats.urgent ? 'stat warn' : 'stat'}>
          <div className="n">{stats.urgent}</div>
          <div className="l">ITV en 30 días</div>
        </div>
      </div>

      <div className="calfilters" style={{ marginTop: 0 }}>
        <div className="chips" role="group" aria-label="Filtro">
          {([['all', 'Todos'], ['free', 'Libres hoy'], ['itv', 'ITV por revisar']] as const).map(([id, label]) => (
            <button type="button" key={id} className="chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <label>
          <span className="lbl">Ordenar</span>
          <select value={sort} onChange={(e) => setSort(e.target.value === 'itv' ? 'itv' : 'plate')}>
            <option value="plate">Por matrícula</option>
            <option value="itv">ITV más urgente primero</option>
          </select>
        </label>
        <label className="grow">
          <span className="lbl">Buscar</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Matrícula, modelo o persona" />
        </label>
      </div>

      {loading ? <div className="empty">Cargando flota…</div> : null}
      {!loading && rows.length === 0 ? <Empty>Todavía no hay vehículos. Pulsa «Nuevo vehículo».</Empty> : null}
      {!loading && rows.length > 0 && shown.length === 0 ? <Empty>Ningún vehículo coincide con el filtro.</Empty> : null}

      {shown.length ? (
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Matrícula</th>
                <th>Vehículo</th>
                <th>Lo tiene</th>
                <th>ITV</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map(({ v, cur, next, itv }) => (
                <tr key={v.id}>
                  <td className="mono">
                    <b>{fmtPlate(v.matricula)}</b>
                  </td>
                  <td>{[v.marca, v.modelo].filter(Boolean).join(' ') || '—'}</td>
                  <td>
                    {cur ? (
                      <>
                        <b>{nameOf(cur, users)}</b> {cur.tipo === 'nombre' ? <Pill tone="info">Desplazado</Pill> : null}
                        <div className="sub">
                          desde {fmtShort(cur.desde, true)}
                          {cur.hasta ? ` hasta ${fmtShort(cur.hasta, true)}` : ''}
                        </div>
                      </>
                    ) : (
                      <>
                        <Pill>Libre</Pill>
                      </>
                    )}
                    {next ? (
                      <div className="sub">
                        Próxima: {nameOf(next, users)} desde {fmtShort(next.desde, true)}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {v.itvVence ? <div>{fmtShort(v.itvVence, true)}</div> : null}
                    <ItvPill s={itv} />
                  </td>
                  <td>
                    <div className="actions-cell">
                      <button type="button" className="btn sm" onClick={() => setModal({ kind: 'assign', veh: v })}>
                        Asignar
                      </button>
                      {cur ? (
                        <button type="button" className="btn sm" onClick={() => void release(v, cur)}>
                          Liberar
                        </button>
                      ) : null}
                      <button type="button" className="btn sm" onClick={() => setModal({ kind: 'history', veh: v })}>
                        Historial
                      </button>
                      <button type="button" className="btn sm" onClick={() => setModal({ kind: 'veh', id: v.id })}>
                        Editar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {modal?.kind === 'veh' ? (
        <VehicleModal
          id={modal.id}
          vehicles={vq.data}
          assignments={aq.data}
          onClose={() => setModal(null)}
          onSaved={(msg) => {
            setModal(null);
            toast(msg);
          }}
        />
      ) : null}
      {modal?.kind === 'assign' ? (
        <AssignModal
          veh={modal.veh}
          edit={modal.edit}
          assignments={aq.data}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(modal.edit ? { kind: 'history', veh: modal.veh } : null);
            toast(modal.edit ? 'Asignación guardada' : 'Vehículo asignado');
          }}
        />
      ) : null}
      {modal?.kind === 'history' ? <HistoryModal veh={modal.veh} assignments={aq.data} today={today} onClose={() => setModal(null)} onEdit={(a) => setModal({ kind: 'assign', veh: modal.veh, edit: a })} /> : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function VehicleModal({
  id, vehicles, assignments, onClose, onSaved,
}: {
  id?: string; vehicles: Vehiculo[]; assignments: Asignacion[]; onClose: () => void; onSaved: (msg: string) => void;
}) {
  const confirm = useConfirm();
  const { busy, error, setError, run } = useAction();
  const cur = id ? vehicles.find((v) => v.id === id) : undefined;
  const [matricula, setMatricula] = useState(cur?.matricula ?? '');
  const [marca, setMarca] = useState(cur?.marca ?? '');
  const [modelo, setModelo] = useState(cur?.modelo ?? '');
  const [itvUltima, setItvUltima] = useState(cur?.itvUltima ?? '');
  const [itvVence, setItvVence] = useState(cur?.itvVence ?? '');
  const [nota, setNota] = useState(cur?.nota ?? '');

  const save = (): void => {
    const plate = normPlate(matricula);
    if (!isPlate(plate)) return setError('Escribe la matrícula (4 a 10 letras o números, sin símbolos).');
    if (vehicles.some((v) => v.id !== id && v.matricula === plate)) return setError('Ya existe un vehículo con esa matrícula.');
    if (itvUltima && !isDate(itvUltima)) return setError('La fecha de la última ITV no es válida.');
    if (itvVence && !isDate(itvVence)) return setError('La fecha de vencimiento de la ITV no es válida.');
    const payload: Record<string, string> = { matricula: plate };
    if (marca.trim()) payload.marca = marca.trim().slice(0, 40);
    if (modelo.trim()) payload.modelo = modelo.trim().slice(0, 40);
    if (itvUltima) payload.itvUltima = itvUltima;
    if (itvVence) payload.itvVence = itvVence;
    if (nota.trim()) payload.nota = nota.trim().slice(0, 200);
    void run(async () => {
      if (id) await setDoc(doc(db, COL_VEH, id), payload);
      else await addDoc(collection(db, COL_VEH), payload);
      onSaved(id ? 'Vehículo guardado' : 'Vehículo creado');
    });
  };

  const remove = async (): Promise<void> => {
    if (!id || !cur) return;
    const mine = assignments.filter((a) => a.vehiculoId === id);
    const ok = await confirm({
      title: 'Eliminar vehículo',
      message: `Se eliminará ${fmtPlate(cur.matricula)}${mine.length ? ` y sus ${mine.length} asignaciones del historial` : ''}. Esto no se puede deshacer.`,
      confirmLabel: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    void run(async () => {
      const b = writeBatch(db);
      for (const a of mine) b.delete(doc(db, COL_ASI, a.id));
      b.delete(doc(db, COL_VEH, id));
      await b.commit();
      onSaved('Vehículo eliminado');
    });
  };

  return (
    <Modal
      title={id ? 'Editar vehículo' : 'Nuevo vehículo'}
      onClose={onClose}
      footer={
        <>
          {id ? (
            <button type="button" className="btn danger" onClick={() => void remove()} disabled={busy}>
              Eliminar
            </button>
          ) : null}
          <span className="grow" />
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
        <Field label="Matrícula" htmlFor="fv-mat">
          <input id="fv-mat" value={matricula} placeholder="1234 ABC" onChange={(e) => setMatricula(e.target.value.toUpperCase())} autoComplete="off" />
        </Field>
        <Field label="Marca" htmlFor="fv-marca">
          <input id="fv-marca" value={marca} maxLength={40} onChange={(e) => setMarca(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Modelo" htmlFor="fv-modelo">
          <input id="fv-modelo" value={modelo} maxLength={40} onChange={(e) => setModelo(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Última ITV pasada" htmlFor="fv-itv0">
          <input id="fv-itv0" type="date" value={itvUltima} onChange={(e) => setItvUltima(e.target.value)} />
        </Field>
        <Field label="Vence la ITV (próxima)" htmlFor="fv-itv1">
          <input id="fv-itv1" type="date" value={itvVence} onChange={(e) => setItvVence(e.target.value)} />
        </Field>
        <Field label="Nota (opcional)" htmlFor="fv-nota">
          <input id="fv-nota" value={nota} maxLength={200} onChange={(e) => setNota(e.target.value)} autoComplete="off" />
        </Field>
      </div>
      <p className="sub">Los avisos de ITV salen 60 días antes (aviso) y 30 días antes (urgente).</p>
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function AssignModal({ veh, edit, assignments, onClose, onSaved }: { veh: Vehiculo; edit?: Asignacion; assignments: Asignacion[]; onClose: () => void; onSaved: () => void }) {
  const data = useData();
  const { busy, error, setError, run } = useAction();
  const workers = useMemo(() => data.workers.slice().sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })), [data.workers]);
  const [tipo, setTipo] = useState<'tecnico' | 'nombre'>(edit?.tipo ?? 'tecnico');
  const [userId, setUserId] = useState(edit?.userId ?? '');
  const [nombre, setNombre] = useState(edit?.tipo === 'nombre' ? edit.nombre : '');
  const [desde, setDesde] = useState(edit?.desde ?? todayMadrid());
  const [hasta, setHasta] = useState(edit?.hasta ?? '');
  const [nota, setNota] = useState(edit?.nota ?? '');

  const save = (): void => {
    let who = '';
    if (tipo === 'tecnico') {
      const u = workers.find((w) => w.id === userId);
      if (!u) return setError('Elige el técnico.');
      who = u.name;
    } else {
      who = nombre.trim();
      if (!who) return setError('Escribe el nombre de la persona.');
    }
    if (!isDate(desde)) return setError('Indica desde qué día lo tiene.');
    if (hasta && !isDate(hasta)) return setError('La fecha final no es válida.');
    if (hasta && toDay(hasta) < toDay(desde)) return setError('La fecha final no puede ser anterior a la inicial.');
    const payload: Record<string, string> = { vehiculoId: veh.id, tipo, nombre: who.slice(0, 80), desde };
    if (tipo === 'tecnico') payload.userId = userId;
    if (hasta) payload.hasta = hasta;
    if (nota.trim()) payload.nota = nota.trim().slice(0, 200);
    void run(async () => {
      if (edit) {
        await setDoc(doc(db, COL_ASI, edit.id), payload);
      } else {
        // las asignaciones que siguen abiertas o solapan se cierran el día anterior
        const b = writeBatch(db);
        for (const c of closingFor(assignments, veh.id, desde)) b.update(doc(db, COL_ASI, c.id), { hasta: c.hasta });
        b.set(doc(collection(db, COL_ASI)), payload);
        await b.commit();
      }
      onSaved();
    });
  };

  return (
    <Modal
      title={`${edit ? 'Editar asignación' : 'Asignar'} · ${fmtPlate(veh.matricula)}`}
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
      <div className="field">
        <span className="lbl">¿Quién lo tiene?</span>
        <div className="seg" role="group" aria-label="Tipo de persona">
          <button type="button" aria-pressed={tipo === 'tecnico'} onClick={() => setTipo('tecnico')}>
            Técnico del equipo
          </button>
          <button type="button" aria-pressed={tipo === 'nombre'} onClick={() => setTipo('nombre')}>
            Otra persona (desplazado)
          </button>
        </div>
      </div>
      <div className="formgrid">
        {tipo === 'tecnico' ? (
          <Field label="Técnico" htmlFor="fa-user">
            <select id="fa-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Elige un técnico…</option>
              {workers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label="Nombre" htmlFor="fa-nombre">
            <input id="fa-nombre" value={nombre} maxLength={80} onChange={(e) => setNombre(e.target.value)} autoComplete="off" placeholder="Ej. Pedro Gómez (desplazado de Málaga)" />
          </Field>
        )}
        <Field label="Lo tiene desde" htmlFor="fa-desde">
          <input id="fa-desde" type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
        </Field>
        <Field label="Hasta (vacío = sigue con él)" htmlFor="fa-hasta">
          <input id="fa-hasta" type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
        </Field>
        <Field label="Nota (opcional)" htmlFor="fa-nota">
          <input id="fa-nota" value={nota} maxLength={200} onChange={(e) => setNota(e.target.value)} autoComplete="off" />
        </Field>
      </div>
      {!edit ? <p className="sub">Si el vehículo ya estaba asignado, esa asignación se cierra el día anterior al inicio de la nueva.</p> : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function HistoryModal({ veh, assignments, today, onClose, onEdit }: { veh: Vehiculo; assignments: Asignacion[]; today: string; onClose: () => void; onEdit: (a: Asignacion) => void }) {
  const data = useData();
  const toast = useToast();
  const confirm = useConfirm();
  const list = useMemo(() => historyOf(assignments, veh.id), [assignments, veh.id]);

  const remove = async (a: Asignacion): Promise<void> => {
    const ok = await confirm({ title: 'Borrar asignación', message: `${nameOf(a, data.users)} · desde ${fmtShort(a.desde, true)}.`, confirmLabel: 'Borrar', danger: true });
    if (!ok) return;
    try {
      await deleteDoc(doc(db, COL_ASI, a.id));
      toast('Asignación borrada');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'No se ha podido borrar');
    }
  };

  return (
    <Modal
      title={`Historial · ${fmtPlate(veh.matricula)}`}
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          <button type="button" className="btn primary" onClick={onClose}>
            Cerrar
          </button>
        </>
      }
    >
      {veh.itvUltima || veh.itvVence ? (
        <p className="sub" style={{ marginBottom: 10 }}>
          ITV: {veh.itvUltima ? `última el ${fmtShort(veh.itvUltima, true)}` : 'sin última fecha'} · {veh.itvVence ? `vence el ${fmtShort(veh.itvVence, true)}` : 'sin fecha de vencimiento'}
        </p>
      ) : null}
      {list.length === 0 ? (
        <Empty>Este vehículo no ha tenido ninguna asignación todavía.</Empty>
      ) : (
        list.map((a) => {
          const days = assignmentDays(a, today);
          const active = a.desde <= today && (!a.hasta || a.hasta >= today);
          return (
            <div className="crow" key={a.id}>
              <div className="pn">
                <div className="pname">
                  {nameOf(a, data.users)} {a.tipo === 'nombre' ? <Pill tone="info">Desplazado</Pill> : null} {active ? <Pill tone="good">Ahora</Pill> : null} {a.desde > today ? <Pill tone="warn">Programada</Pill> : null}
                </div>
                <div className="pcode">
                  {fmtShort(a.desde, true)} – {a.hasta ? fmtShort(a.hasta, true) : 'sigue'} · {days} {days === 1 ? 'día' : 'días'}
                  {a.nota ? ` · ${a.nota}` : ''}
                </div>
              </div>
              <button type="button" className="btn sm" onClick={() => onEdit(a)}>
                Editar
              </button>
              <button type="button" className="btn sm danger" onClick={() => void remove(a)}>
                Borrar
              </button>
            </div>
          );
        })
      )}
    </Modal>
  );
}
