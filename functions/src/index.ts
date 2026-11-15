/**
 * Cloud Functions (v2, región europe-west1). Cada operación es una función "callable" que la web invoca
 * con la sesión del usuario. La lógica está en ops.ts; aquí solo se conecta con Firebase.
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { defineString } from 'firebase-functions/params';
import { OPS, OpError, type Deps } from './ops';

initializeApp();
setGlobalOptions({ region: 'europe-west1', maxInstances: 10 });

/**
 * Dominio ficticio de los emails internos (el técnico escribe 551488, Firebase ve 551488@stock.local).
 * Debe coincidir con VITE_EMAIL_DOMAIN de la web. Se cambia en functions/.env (EMAIL_DOMAIN=...).
 */
const EMAIL_DOMAIN = defineString('EMAIL_DOMAIN', { default: 'stock.local' });

function deps(): Deps {
  return { db: getFirestore(), auth: getAuth(), FieldValue, emailDomain: EMAIL_DOMAIN.value() };
}

type Op = (d: Deps, uid: string | undefined, data: unknown) => Promise<unknown>;

function handler(op: Op) {
  return async (req: CallableRequest<unknown>) => {
    try {
      return await op(deps(), req.auth?.uid, req.data);
    } catch (e) {
      if (e instanceof OpError) throw new HttpsError(e.code, e.message);
      console.error(e);
      throw new HttpsError('internal', 'No se ha podido completar la operación. Inténtalo de nuevo.');
    }
  };
}

// Técnico
export const registerConsumption = onCall(handler(OPS.registerConsumption));
export const registerExtra = onCall(handler(OPS.registerExtra));
export const returnToWarehouse = onCall(handler(OPS.returnToWarehouse));
export const registerTransfer = onCall(handler(OPS.registerTransfer));
export const registerWeekly = onCall(handler(OPS.registerWeekly));

// Almacén
export const adminDeliver = onCall(handler(OPS.adminDeliver));
export const adjustStock = onCall(handler(OPS.adjustStock));
export const resetToBase = onCall(handler(OPS.resetToBase));
export const createUser = onCall(handler(OPS.createUser));
export const updateUser = onCall(handler(OPS.updateUser));
export const setPassword = onCall(handler(OPS.setPassword));
export const deleteUser = onCall(handler(OPS.deleteUser));
