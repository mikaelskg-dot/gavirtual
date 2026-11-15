import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { collection, onSnapshot, query, where, type DocumentData, type Query } from 'firebase/firestore';
import { db } from '../firebase';
import { DAY } from '../lib/ledger';
import { folderNames } from '../lib/catalog';
import type { Folder, Pack, Product, StockDoc, StockItem, TechRole, Tx, UserDoc } from '../types';

/**
 * Días de movimientos que carga el almacén (además de todo lo pendiente de entregar).
 * El técnico carga siempre todos los suyos.
 */
export const HISTORY_DAYS = 120;

interface Source<T> {
  data: T[];
  loaded: boolean;
  error: string | null;
}

/** Escucha una consulta en tiempo real. `make` se evalúa solo cuando cambian `deps`. */
export function useQuery<T extends { id: string }>(make: () => Query<DocumentData> | null, deps: readonly unknown[]): Source<T> {
  const [state, setState] = useState<Source<T>>({ data: [], loaded: false, error: null });
  useEffect(() => {
    const q = make();
    if (!q) {
      setState({ data: [], loaded: true, error: null });
      return;
    }
    setState((s) => ({ ...s, loaded: false }));
    return onSnapshot(
      q,
      (snap) => setState({ data: snap.docs.map((d) => ({ id: d.id, ...d.data() }) as unknown as T), loaded: true, error: null }),
      (err) => setState({ data: [], loaded: true, error: err.message }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

export interface Data {
  ready: boolean;
  errors: string[];
  users: UserDoc[];
  workers: UserDoc[];
  products: Product[];
  folders: Folder[];
  folderNames: string[];
  roles: TechRole[];
  packs: Pack[];
  territories: string[];
  /** stock por técnico: { uid: { productId: { currentStock } } } */
  stock: Record<string, Record<string, StockItem>>;
  /** movimientos, de más reciente a más antiguo */
  txs: Tx[];
}

const Ctx = createContext<Data | null>(null);

export function useData(): Data {
  const v = useContext(Ctx);
  if (!v) throw new Error('useData debe usarse dentro de <DataProvider>');
  return v;
}

export function DataProvider({ profile, children }: { profile: UserDoc; children: ReactNode }) {
  const isAdmin = profile.role === 'admin' || profile.role === 'almacen'; // personal de almacén: ve todo lo del panel
  const uid = profile.id;
  const since = useMemo(() => Date.now() - HISTORY_DAYS * DAY, []);

  const users = useQuery<UserDoc>(() => query(collection(db, 'users')), []);
  const products = useQuery<Product>(() => query(collection(db, 'catalog')), []);
  const folders = useQuery<Folder>(() => query(collection(db, 'folders')), []);
  const roles = useQuery<TechRole>(() => query(collection(db, 'technicianRoles')), []);
  const packs = useQuery<Pack>(() => query(collection(db, 'packs')), []);
  const config = useQuery<{ id: string; territories?: string[] }>(() => query(collection(db, 'config')), []);

  // Un técnico solo puede leer su propio documento de stock; el almacén los lee todos.
  const stock = useQuery<StockDoc>(
    () => (isAdmin ? query(collection(db, 'stock')) : query(collection(db, 'stock'), where('userId', '==', uid))),
    [isAdmin, uid],
  );

  // Movimientos. Técnico: los suyos + los traspasos que ha recibido. Almacén: ventana reciente + todo lo pendiente.
  const txA = useQuery<Tx>(
    () =>
      isAdmin
        ? query(collection(db, 'transactions'), where('timestamp', '>=', since))
        : query(collection(db, 'transactions'), where('userId', '==', uid)),
    [isAdmin, uid, since],
  );
  const txB = useQuery<Tx>(
    () =>
      isAdmin
        ? query(collection(db, 'transactions'), where('deliveryStatus', '==', 'pending'))
        : query(collection(db, 'transactions'), where('counterpartId', '==', uid)),
    [isAdmin, uid],
  );

  const sources = [users, products, folders, roles, packs, config, stock, txA, txB];
  const ready = sources.every((s) => s.loaded);
  const errors = [...new Set(sources.map((s) => s.error).filter((e): e is string => !!e))];

  const value = useMemo<Data>(() => {
    const merged = new Map<string, Tx>();
    for (const t of [...txA.data, ...txB.data]) merged.set(t.id, t);
    const stockByUser: Data['stock'] = {};
    for (const s of stock.data) stockByUser[s.userId ?? s.id] = s.items ?? {};
    return {
      ready,
      errors,
      users: users.data,
      workers: users.data.filter((u) => u.role === 'worker'),
      products: products.data,
      folders: folders.data,
      folderNames: folderNames(folders.data, products.data),
      roles: roles.data,
      packs: packs.data,
      territories: [...(config.data.find((c) => c.id === 'settings')?.territories ?? [])].sort((a, b) => a.localeCompare(b, 'es')),
      stock: stockByUser,
      txs: [...merged.values()].sort((a, b) => b.timestamp - a.timestamp),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, errors.join('|'), users.data, products.data, folders.data, roles.data, packs.data, config.data, stock.data, txA.data, txB.data]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
