import { useState, type FormEvent } from 'react';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { DataProvider, useData } from './data/DataContext';
import { ConfirmProvider, Field, Modal, ToastProvider, useAction, useToast } from './ui';
import { AdminView } from './views/admin/AdminView';
import { WorkerView } from './views/worker/WorkerView';
import type { UserDoc } from './types';
import { AppMenu } from './components/AppMenu';

function Login() {
  const { login } = useAuth();
  const { busy, error, setError, run } = useAction();
  const [code, setCode] = useState('');
  const [pass, setPass] = useState('');
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!code.trim() || !pass) return setError('Escribe tu código de empleado y tu contraseña.');
    void run(() => login(code, pass));
  };
  return (
    <div className="login-wrap">
      <div className="login card">
        <div className="login-mark" aria-hidden="true">
        </div>
        <div>
          <h1>STOCK VIRTUAL</h1>
          <p className="sub">• Uso personal</p>
        </div>
        <form onSubmit={submit}>
          <Field label="Código de empleado" htmlFor="lg-code">
            <input id="lg-code" inputMode="text" autoCapitalize="none" autoComplete="username" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <Field label="Contraseña" htmlFor="lg-pass">
            <input id="lg-pass" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
          </Field>
          {error ? (
            <p className="err" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Entrando…' : 'Acceder'}
          </button>
        </form>
      </div>
    </div>
  );
}

function PasswordModal({ onClose }: { onClose: () => void }) {
  const { changePassword } = useAuth();
  const toast = useToast();
  const { busy, error, setError, run } = useAction();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const save = (): void => {
    if (next.length < 6) return setError('La nueva contraseña debe tener al menos 6 caracteres.');
    void run(async () => {
      await changePassword(cur, next);
      toast('Contraseña cambiada');
      onClose();
    });
  };
  return (
    <Modal
      title="Cambiar contraseña"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={busy}>
            Guardar
          </button>
        </>
      }
    >
      <Field label="Contraseña actual" htmlFor="cp-cur">
        <input id="cp-cur" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
      </Field>
      <Field label="Nueva contraseña" htmlFor="cp-new">
        <input id="cp-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

function Shell({ me }: { me: UserDoc }) {
  const { logout } = useAuth();
  const data = useData();
  const [pw, setPw] = useState(false);
  return (
    <div className="wrap">
      <header className="appbar">
        <div className="brand">
          <div>
            <h1>Stock técnico</h1>
            <div className="brand-sub">
              {me.name} · {me.role === 'admin' ? 'Administrador' : me.role === 'almacen' ? 'Almacén' : 'Técnico'}
            </div>
          </div>
        </div>
        <AppMenu me={me} onPassword={() => setPw(true)} onLogout={() => void logout()} />
      </header>
      {data.errors.length ? (
        <div className="banner" role="alert">
          No se han podido cargar algunos datos ({data.errors.join(', ')}). Comprueba la conexión o las reglas de Firestore.
        </div>
      ) : null}
      {!data.ready ? <div className="splash">Cargando…</div> : me.role === 'admin' || me.role === 'almacen' ? <AdminView me={me} /> : <WorkerView me={me} />}
      {pw ? <PasswordModal onClose={() => setPw(false)} /> : null}
    </div>
  );
}

function Root() {
  const { loading, fbUser, profile, logout } = useAuth();
  if (loading) return <div className="splash">Cargando…</div>;
  if (!fbUser) return <Login />;
  if (!profile)
    return (
      <div className="login-wrap">
        <div className="login card">
          <h1>Sin ficha de usuario</h1>
          <p>Tu cuenta existe pero el almacén aún no ha completado tu alta. Avisa al administrador.</p>
          <button type="button" className="btn" onClick={() => void logout()}>
            Salir
          </button>
        </div>
      </div>
    );
  return (
    <DataProvider profile={profile}>
      <Shell me={profile} />
    </DataProvider>
  );
}

export function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AuthProvider>
          <Root />
        </AuthProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
