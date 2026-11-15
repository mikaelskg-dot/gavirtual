import { useState } from 'react';
import { api } from '../../api';
import { useData } from '../../data/DataContext';
import { byText } from '../../lib/format';
import type { UserDoc } from '../../types';
import { ZONAS } from '../../lib/calendar';
import { Field, Modal, Pill, useAction, useConfirm, useToast } from '../../ui';

const RANK: Record<UserDoc['role'], number> = { admin: 0, almacen: 1, worker: 2 };
const ROLE_LABEL: Record<UserDoc['role'], string> = { admin: 'Administrador', almacen: 'Almacén', worker: 'Técnico' };

type ModalState = null | { kind: 'user'; id?: string } | { kind: 'password'; user: UserDoc };

/** Contraseña legible de 8 caracteres (sin 0/O/1/l/I para evitar confusiones al dictarla). */
function genPassword(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint32Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((n) => chars[n % chars.length]).join('');
}

/** Gestión de usuarios: código de empleado + contraseña. Las cuentas se crean y modifican desde las Cloud Functions. */
export function TeamTab({ me }: { me: UserDoc }) {
  const data = useData();
  const toast = useToast();
  const confirm = useConfirm();
  const [modal, setModal] = useState<ModalState>(null);
  const [fTerr, setFTerr] = useState('');
  const [fRole, setFRole] = useState('');

  const list = data.users
    .filter((u) => (!fTerr || u.territory === fTerr) && (!fRole || u.technicianRoleId === fRole))
    .sort((a, b) => (a.role === b.role ? byText(a.name, b.name) : RANK[a.role] - RANK[b.role]));
  const locked = (u: UserDoc): boolean => u.role === 'admin' && me.role !== 'admin'; // solo un administrador toca a administradores
  const roleName = (id: string): string => data.roles.find((r) => r.id === id)?.name ?? '—';

  const remove = async (u: UserDoc): Promise<void> => {
    const ok = await confirm({
      title: 'Eliminar usuario',
      message: `Se eliminará a ${u.name} (código ${u.employeeCode}) y su stock. Sus movimientos siguen en el historial.`,
      confirmLabel: 'Eliminar',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteUser(u.id);
      toast('Usuario eliminado');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'No se ha podido eliminar');
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Equipo</h2>
          <span className="sub">{list.length === data.users.length ? `${data.users.length} usuarios` : `${list.length} de ${data.users.length} usuarios`}</span>
        </div>
        <button type="button" className="btn primary" onClick={() => setModal({ kind: 'user' })}>
          Nuevo usuario
        </button>
      </div>
      <div className="note" style={{ marginBottom: 12 }}>
        Cada persona entra con su <b>código de empleado</b> y la contraseña que tú le indiques. Si olvidan la contraseña, puedes restablecerla aquí.
      </div>
      <div className="calfilters" style={{ marginTop: 0 }}>
        <label>
          <span className="lbl">Territorio</span>
          <select value={fTerr} onChange={(e) => setFTerr(e.target.value)}>
            <option value="">Todos</option>
            {data.territories.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="lbl">Rol técnico</span>
          <select value={fRole} onChange={(e) => setFRole(e.target.value)}>
            <option value="">Todos</option>
            {data.roles
              .slice()
              .sort((a, b) => byText(a.name, b.name))
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
          </select>
        </label>
        {fTerr || fRole ? (
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setFTerr('');
              setFRole('');
            }}
          >
            Quitar filtros
          </button>
        ) : null}
      </div>
      {list.length === 0 ? <div className="empty">Ningún usuario coincide con los filtros.</div> : null}
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Código</th>
              <th>Rol</th>
              <th>Departamento</th>
              <th>Territorio</th>
              <th>Rol técnico</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((u) => (
              <tr key={u.id}>
                <td>
                  <b>{u.name}</b>
                </td>
                <td className="mono">{u.employeeCode}</td>
                <td>{u.role === 'worker' ? <Pill>{ROLE_LABEL[u.role]}</Pill> : <Pill tone="info">{ROLE_LABEL[u.role]}</Pill>}</td>
                <td>{u.department || '—'}</td>
                <td>{u.territory || '—'}</td>
                <td>{u.role === 'worker' ? roleName(u.technicianRoleId) : '—'}</td>
                <td>
                  <div className="actions-cell">
                    <button type="button" className="btn sm" onClick={() => setModal({ kind: 'user', id: u.id })} disabled={locked(u)}>
                      Editar
                    </button>
                    <button type="button" className="btn sm" onClick={() => setModal({ kind: 'password', user: u })} disabled={locked(u)}>
                      Contraseña
                    </button>
                    <button type="button" className="btn sm danger" onClick={() => void remove(u)} disabled={u.id === me.id || locked(u)} title={u.id === me.id ? 'No puedes eliminar tu propio usuario' : locked(u) ? 'Solo un administrador puede hacerlo' : undefined}>
                      Eliminar
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {modal?.kind === 'user' ? (
        <UserModal
          me={me}
          id={modal.id}
          onClose={() => setModal(null)}
          onSaved={(created) => {
            setModal(null);
            toast(created ? 'Usuario creado' : 'Usuario guardado');
          }}
        />
      ) : null}
      {modal?.kind === 'password' ? (
        <PasswordModal
          user={modal.user}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            toast('Contraseña actualizada');
          }}
        />
      ) : null}
    </section>
  );
}

function UserModal({ me, id, onClose, onSaved }: { me: UserDoc; id?: string; onClose: () => void; onSaved: (created: boolean) => void }) {
  const data = useData();
  const { busy, error, setError, run } = useAction();
  const cur = id ? data.users.find((u) => u.id === id) : undefined;
  const [code, setCode] = useState(cur?.employeeCode ?? '');
  const [name, setName] = useState(cur?.name ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserDoc['role']>(cur?.role ?? 'worker');
  const [department, setDepartment] = useState(cur?.department ?? '');
  const [territory, setTerritory] = useState(cur?.territory ?? data.territories[0] ?? '');
  const [zona, setZona] = useState<NonNullable<UserDoc['zona']>>(cur?.zona ?? '');
  const [roleId, setRoleId] = useState(cur?.technicianRoleId ?? data.roles[0]?.id ?? '');

  const save = (): void => {
    const c = code.trim();
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(c)) return setError('El código de empleado debe tener entre 3 y 32 caracteres (letras, números, punto o guion).');
    if (!name.trim()) return setError('Escribe el nombre.');
    if (!id && password.length < 6) return setError('La contraseña debe tener al menos 6 caracteres.');
    if (role === 'worker' && !roleId) return setError('Elige el rol técnico. Si no hay ninguno, créalo antes en Configuración.');
    const base = {
      employeeCode: c,
      name: name.trim(),
      role,
      department: department.trim(),
      territory: role === 'worker' ? territory : '',
      technicianRoleId: role === 'worker' ? roleId : '',
      zona: role === 'worker' ? zona : ('' as const),
    };
    void run(async () => {
      if (id) await api.updateUser(id, base);
      else await api.createUser({ ...base, password });
      onSaved(!id);
    });
  };

  return (
    <Modal
      title={id ? 'Editar usuario' : 'Nuevo usuario'}
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
        <Field label="Código de empleado" htmlFor="uf-code">
          <input id="uf-code" value={code} placeholder="551488" onChange={(e) => setCode(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Nombre completo" htmlFor="uf-name">
          <input id="uf-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
        {!id ? (
          <Field label="Contraseña (mínimo 6 caracteres)" htmlFor="uf-pass">
            <div style={{ display: 'flex', gap: 6 }}>
              <input id="uf-pass" type="text" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
              <button type="button" className="btn" onClick={() => setPassword(genPassword())}>
                Generar
              </button>
            </div>
          </Field>
        ) : null}
        <Field label="Rol" htmlFor="uf-role">
          <select id="uf-role" value={role} onChange={(e) => setRole(e.target.value === 'admin' ? 'admin' : e.target.value === 'almacen' ? 'almacen' : 'worker')}>
            <option value="worker">Técnico</option>
            <option value="almacen">Almacén</option>
            {me.role === 'admin' ? <option value="admin">Administrador</option> : null}
          </select>
        </Field>
        <Field label="Departamento" htmlFor="uf-dep">
          <input id="uf-dep" value={department} onChange={(e) => setDepartment(e.target.value)} autoComplete="off" />
        </Field>
        {role === 'worker' ? (
          <>
            <Field label="Territorio" htmlFor="uf-terr">
              <select id="uf-terr" value={territory} onChange={(e) => setTerritory(e.target.value)}>
                <option value="">Sin territorio</option>
                {data.territories.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={me.role === 'admin' ? 'Zona (calendario)' : 'Zona (calendario, solo la cambia un administrador)'} htmlFor="uf-zona">
              <select id="uf-zona" value={zona} disabled={me.role !== 'admin'} onChange={(e) => setZona(ZONAS.find((z) => z === e.target.value) ?? '')}>
                <option value="">Sin zona</option>
                {ZONAS.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Rol técnico (stock base)" htmlFor="uf-trole">
              <select id="uf-trole" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                {data.roles.length === 0 ? <option value="">No hay roles: créalos en Configuración</option> : null}
                {data.roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>
          </>
        ) : null}
      </div>
      {!id && role === 'worker' ? <p className="sub">El técnico empieza con el stock base de su rol técnico.</p> : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

function PasswordModal({ user, onClose, onSaved }: { user: UserDoc; onClose: () => void; onSaved: () => void }) {
  const { busy, error, setError, run } = useAction();
  const [password, setPassword] = useState('');

  const save = (): void => {
    if (password.length < 6) return setError('La contraseña debe tener al menos 6 caracteres.');
    void run(async () => {
      await api.setPassword(user.id, password);
      onSaved();
    });
  };

  return (
    <Modal
      title={`Nueva contraseña para ${user.name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar contraseña'}
          </button>
        </>
      }
    >
      <p className="sub">Se cerrará la sesión que tenga abierta. Apunta la contraseña antes de guardar: después no se puede consultar.</p>
      <Field label="Contraseña (mínimo 6 caracteres)" htmlFor="pw-new">
        <div style={{ display: 'flex', gap: 6 }}>
          <input id="pw-new" type="text" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
          <button type="button" className="btn" onClick={() => setPassword(genPassword())}>
            Generar
          </button>
        </div>
      </Field>
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
