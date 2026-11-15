import type { TxLine } from './lib/ledger';

/** admin: todo (incluido el calendario). almacen: panel de almacén. worker: técnico. */
export type Role = 'admin' | 'almacen' | 'worker';

/** users/{uid}. El id del documento es el uid de Firebase Authentication. */
export interface UserDoc {
  id: string;
  employeeCode: string;
  name: string;
  role: Role;
  department: string;
  territory: string;
  technicianRoleId: string;
  /** Zona para el calendario (solo la edita un administrador). */
  zona?: '' | 'Sevilla Este' | 'Sevilla Oeste' | 'Huelva';
}

/** catalog/{id}. `category` es el nombre de la carpeta. */
export interface Product {
  id: string;
  code: string;
  name: string;
  category: string;
  /** Prioridad de uso: aparece arriba al registrar un consumo. Vacío = sin prioridad. */
  priority?: Priority;
  /** Posición dentro de su grupo de prioridad (1 = primero). Sin valor: al final, por código. */
  order?: number;
}

export type Priority = '' | 'muy-habitual' | 'habitual';

/** folders/{id}: permite tener carpetas vacías. */
export interface Folder {
  id: string;
  name: string;
}

/** technicianRoles/{id}: baseStock es { productId: cantidad } */
export interface TechRole {
  id: string;
  name: string;
  baseStock: Record<string, number>;
}

/** packs/{id}: conjunto de productos que se añaden de golpe al registrar un consumo. */
export interface Pack {
  id: string;
  name: string;
  items: Record<string, number>;
  /** posición que fija el administrador (1, 2, 3…); sin posición, al final por nombre */
  order?: number;
}

/** transactions/{id}. Solo lo escriben las Cloud Functions. */
export interface Tx extends TxLine {
  kind: '' | 'weekly' | 'extra' | 'adjust' | 'reset' | 'repair' | 'network' | 'install' | 'return';
  note: string;
  weekStart: number;
  deliveryDate: number | null;
  deliveredQty: number;
  missing: number;
  counterpartId: string | null;
  counterpartName: string | null;
}

export interface StockItem {
  currentStock: number;
  lastRestockedAt?: number;
  lastUpdatedAt?: number;
}

/** stock/{uid}: todo el stock de un técnico en un solo documento. */
export interface StockDoc {
  id: string;
  userId: string;
  items: Record<string, StockItem>;
}
