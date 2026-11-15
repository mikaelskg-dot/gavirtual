import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';

export interface ItemInput {
  productId: string;
  quantity: number;
}

export interface UserInput {
  employeeCode: string;
  name: string;
  role: 'admin' | 'almacen' | 'worker';
  department: string;
  territory: string;
  technicianRoleId: string;
  zona?: '' | 'Sevilla Este' | 'Sevilla Oeste' | 'Huelva';
}

/** Llama a una Cloud Function y devuelve su resultado; si falla, lanza un Error con un mensaje en español. */
async function call<T>(name: string, data: unknown): Promise<T> {
  try {
    const res = await httpsCallable(functions, name)(data);
    return res.data as T;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === 'functions/unavailable' || err.code === 'functions/deadline-exceeded') {
      throw new Error('No hay conexión con el servidor. Comprueba la cobertura e inténtalo de nuevo.');
    }
    if (err.code === 'functions/internal' || err.code === 'functions/unknown' || !err.message) {
      throw new Error('No se ha podido completar la operación. Inténtalo de nuevo.');
    }
    throw new Error(err.message);
  }
}

export const api = {
  /** Técnico */
  registerConsumption: (note: string, items: ItemInput[], kind: '' | 'repair' | 'network' | 'install' = '') =>
    call<{ ok: true; lines: number }>('registerConsumption', { note, items, kind }),
  returnToWarehouse: (note: string, items: ItemInput[]) => call<{ ok: true; lines: number }>('returnToWarehouse', { note, items }),
  registerExtra: (note: string, items: ItemInput[]) => call<{ ok: true; lines: number }>('registerExtra', { note, items }),
  registerTransfer: (toUserId: string, note: string, items: ItemInput[]) =>
    call<{ ok: true; lines: number }>('registerTransfer', { toUserId, note, items }),
  registerWeekly: (weeks: number[], got: Record<string, number>) => call<{ ok: true; units: number }>('registerWeekly', { weeks, got }),

  /** Almacén */
  adminDeliver: (txIds: string[]) => call<{ ok: true; delivered: number; skipped: number }>('adminDeliver', { txIds }),
  adjustStock: (userId: string, productId: string, quantity: number, note: string) =>
    call<{ ok: true; delta: number }>('adjustStock', { userId, productId, quantity, note }),
  resetToBase: (userId: string) => call<{ ok: true; changed: number }>('resetToBase', { userId }),
  createUser: (u: UserInput & { password: string }) => call<{ ok: true; uid: string }>('createUser', u),
  updateUser: (uid: string, u: Partial<UserInput>) => call<{ ok: true }>('updateUser', { uid, ...u }),
  setPassword: (uid: string, password: string) => call<{ ok: true }>('setPassword', { uid, password }),
  deleteUser: (uid: string) => call<{ ok: true }>('deleteUser', { uid }),
};
