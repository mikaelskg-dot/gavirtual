import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, initializeFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';

// Este módulo solo se carga si hay configuración (ver main.tsx).
const env = import.meta.env;

export const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  appId: env.VITE_FIREBASE_APP_ID,
});

export const auth = getAuth(app);
// Si la red (antivirus, cortafuegos o proxy de empresa) bloquea la conexión continua de Firestore, la app cambia sola a
// consultas periódicas (long polling). Sin esto, algunos equipos no reciben los cambios en tiempo real hasta recargar con F5.
export const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
export const functions = getFunctions(app, env.VITE_FUNCTIONS_REGION || 'europe-west1');

if (env.VITE_USE_EMULATORS === 'true') {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
}

/** Dominio ficticio de los emails internos: el técnico escribe 551488 y Firebase ve 551488@stock.local */
export const EMAIL_DOMAIN: string = env.VITE_EMAIL_DOMAIN || 'stock.local';
