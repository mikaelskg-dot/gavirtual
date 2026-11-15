import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  EmailAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  type User,
} from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth, db, EMAIL_DOMAIN } from '../firebase';
import type { UserDoc } from '../types';

interface AuthState {
  /** true mientras se comprueba la sesión y se carga la ficha del usuario */
  loading: boolean;
  fbUser: User | null;
  /** ficha del usuario en Firestore (rol, nombre, territorio...) */
  profile: UserDoc | null;
  login: (employeeCode: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  changePassword: (current: string, next: string) => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth debe usarse dentro de <AuthProvider>');
  return v;
}

/** El código de empleado se convierte en un email interno que el usuario nunca ve. */
export const emailFor = (code: string): string => `${code.trim().toLowerCase()}@${EMAIL_DOMAIN}`;

function authMessage(e: unknown): string {
  const code = (e as { code?: string } | null)?.code ?? '';
  if (['auth/invalid-credential', 'auth/user-not-found', 'auth/wrong-password', 'auth/invalid-email'].includes(code)) {
    return 'Código de empleado o contraseña incorrectos.';
  }
  if (code === 'auth/too-many-requests') return 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.';
  if (code === 'auth/network-request-failed') return 'Sin conexión. Comprueba la cobertura e inténtalo de nuevo.';
  if (code === 'auth/user-disabled') return 'Este usuario está desactivado. Habla con almacén.';
  return 'No se ha podido iniciar sesión. Inténtalo de nuevo.';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authReady, setAuthReady] = useState(false);
  const [fbUser, setFbUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserDoc | null>(null);
  const [profileReady, setProfileReady] = useState(false);

  useEffect(
    () =>
      onAuthStateChanged(auth, (u) => {
        setFbUser(u);
        setAuthReady(true);
        if (!u) {
          setProfile(null);
          setProfileReady(true);
        } else setProfileReady(false);
      }),
    [],
  );

  const uid = fbUser?.uid;
  useEffect(() => {
    if (!uid) return;
    return onSnapshot(
      doc(db, 'users', uid),
      (snap) => {
        setProfile(snap.exists() ? ({ id: snap.id, ...snap.data() } as UserDoc) : null);
        setProfileReady(true);
      },
      () => {
        setProfile(null);
        setProfileReady(true);
      },
    );
  }, [uid]);

  const login = useCallback(async (code: string, password: string) => {
    try {
      await signInWithEmailAndPassword(auth, emailFor(code), password);
    } catch (e) {
      throw new Error(authMessage(e));
    }
  }, []);

  const logout = useCallback(() => signOut(auth), []);

  const changePassword = useCallback(async (current: string, next: string) => {
    const u = auth.currentUser;
    if (!u || !u.email) throw new Error('No hay sesión iniciada.');
    try {
      await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, current));
      await updatePassword(u, next);
    } catch (e) {
      const code = (e as { code?: string } | null)?.code ?? '';
      if (code === 'auth/invalid-credential' || code === 'auth/wrong-password') throw new Error('La contraseña actual no es correcta.');
      if (code === 'auth/weak-password') throw new Error('La nueva contraseña es demasiado corta (mínimo 6 caracteres).');
      if (code === 'auth/too-many-requests') throw new Error('Demasiados intentos. Espera unos minutos.');
      throw new Error('No se ha podido cambiar la contraseña. Inténtalo de nuevo.');
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({ loading: !authReady || !profileReady, fbUser, profile, login, logout, changePassword }),
    [authReady, profileReady, fbUser, profile, login, logout, changePassword],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
