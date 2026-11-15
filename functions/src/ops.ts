/**
 * Operaciones de negocio del servidor. Todo lo que modifica stock, movimientos o usuarios pasa por aquí.
 *
 * Las funciones reciben sus dependencias (`Deps`) en lugar de importarlas, para poder probarlas con una
 * base de datos en memoria (ver test-support/). `index.ts` las expone como Cloud Functions.
 */
import type { Auth } from 'firebase-admin/auth';
import type { FieldValue, Firestore } from 'firebase-admin/firestore';
import { isoWeek, planDelivery, planWeekly, startOfWeek, type TxLine, type TxType } from './ledger';

/* ------------------------------------------------------------------ */
/* Tipos y errores                                                     */
/* ------------------------------------------------------------------ */

export type OpCode =
  | 'unauthenticated'
  | 'permission-denied'
  | 'invalid-argument'
  | 'failed-precondition'
  | 'not-found'
  | 'already-exists';

/** Error "esperado" con mensaje en español para el usuario. `index.ts` lo convierte en HttpsError. */
export class OpError extends Error {
  code: OpCode;
  constructor(code: OpCode, message: string) {
    super(message);
    this.name = 'OpError';
    this.code = code;
  }
}

export interface Deps {
  db: Firestore;
  auth: Auth;
  FieldValue: typeof FieldValue;
  /** Dominio ficticio con el que se construye el email interno: 551488 -> 551488@stock.local */
  emailDomain: string;
  now?: () => number;
}

export interface Profile {
  employeeCode: string;
  name: string;
  role: 'admin' | 'almacen' | 'worker';
  department: string;
  territory: string;
  technicianRoleId: string;
  /** Zona del técnico (calendario): '' | 'Sevilla Este' | 'Sevilla Oeste' | 'Huelva'. Solo la cambia un administrador. */
  zona?: string;
}

export interface Item {
  productId: string;
  quantity: number;
}

type Snap = { exists: boolean; id: string; data(): unknown };

const MAX_ITEMS = 100;
const MAX_DELIVER = 150;

/* ------------------------------------------------------------------ */
/* Utilidades de validación                                            */
/* ------------------------------------------------------------------ */

const nowOf = (d: Deps): number => (d.now ? d.now() : Date.now());

function cleanText(raw: unknown, max: number, requiredMsg?: string): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (requiredMsg && !s) throw new OpError('invalid-argument', requiredMsg);
  if (s.length > max) throw new OpError('invalid-argument', `El texto es demasiado largo (máximo ${max} caracteres).`);
  return s;
}

function cleanId(raw: unknown, msg = 'Identificador no válido.'): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 128 || raw.includes('/') || raw === '.' || raw === '..') {
    throw new OpError('invalid-argument', msg);
  }
  return raw;
}

export function parseItems(raw: unknown, max = MAX_ITEMS): Item[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new OpError('invalid-argument', 'Selecciona al menos un producto.');
  if (raw.length > max) throw new OpError('invalid-argument', `Demasiados productos en una sola operación (máximo ${max}).`);
  const merged = new Map<string, number>();
  for (const r of raw) {
    const o = r as { productId?: unknown; quantity?: unknown } | null;
    const productId = cleanId(o?.productId);
    const q = o?.quantity;
    if (typeof q !== 'number' || !Number.isInteger(q) || q < 1 || q > 100_000) {
      throw new OpError('invalid-argument', 'Las cantidades deben ser números enteros mayores que cero.');
    }
    merged.set(productId, (merged.get(productId) ?? 0) + q);
  }
  return [...merged].map(([productId, quantity]) => ({ productId, quantity }));
}

function parseWeeks(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 26) throw new OpError('invalid-argument', 'Elige al menos una semana.');
  const out = new Set<number>();
  for (const w of raw) {
    if (typeof w !== 'number' || !Number.isInteger(w) || startOfWeek(w) !== w) throw new OpError('invalid-argument', 'Semana no válida.');
    out.add(w);
  }
  return [...out].sort((a, b) => a - b);
}

function parseGot(raw: unknown): Record<string, number> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new OpError('invalid-argument', 'Marca al menos un producto que hayas recogido.');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 400) throw new OpError('invalid-argument', 'Demasiados productos.');
  const out: Record<string, number> = {};
  for (const [k, v] of entries) {
    cleanId(k);
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100_000) throw new OpError('invalid-argument', 'Cantidad no válida.');
    out[k] = v;
  }
  return out;
}

export async function loadCaller(d: Deps, uid: string | undefined): Promise<{ uid: string; profile: Profile }> {
  if (!uid) throw new OpError('unauthenticated', 'Inicia sesión para continuar.');
  const snap = await d.db.doc(`users/${uid}`).get();
  if (!snap.exists) throw new OpError('permission-denied', 'Tu usuario no está dado de alta en la aplicación.');
  return { uid, profile: snap.data() as Profile };
}

/** Almacén o administrador: todo lo que hoy hace el panel de almacén. */
function requireStaff(p: Profile): void {
  if (p.role !== 'admin' && p.role !== 'almacen') throw new OpError('permission-denied', 'Solo el almacén puede hacer esto.');
}

/** Solo el administrador (rol completo). */
function requireAdmin(p: Profile): void {
  if (p.role !== 'admin') throw new OpError('permission-denied', 'Solo el administrador puede hacer esto.');
}

const ZONAS = ['Sevilla Este', 'Sevilla Oeste', 'Huelva'];

function parseZona(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'string' && ZONAS.includes(v)) return v;
  throw new OpError('invalid-argument', 'Zona no válida.');
}

const isRole = (v: unknown): v is Profile['role'] => v === 'admin' || v === 'almacen' || v === 'worker';

function requireWorker(p: Profile): void {
  if (p.role !== 'worker') throw new OpError('permission-denied', 'Esta acción es para técnicos.');
}

/* ------------------------------------------------------------------ */
/* Documentos que se escriben                                          */
/* ------------------------------------------------------------------ */

function stockQty(snap: Snap, pid: string): number {
  if (!snap.exists) return 0;
  const data = snap.data() as { items?: Record<string, { currentStock?: unknown }> } | undefined;
  const v = data?.items?.[pid]?.currentStock;
  return typeof v === 'number' ? v : 0;
}

function readProduct(snap: Snap): { name: string; code: string } {
  if (!snap.exists) throw new OpError('not-found', 'Uno de los productos ya no existe en el catálogo.');
  const p = snap.data() as { name: string; code: string };
  return { name: p.name, code: p.code };
}

interface TxInit {
  ts: number;
  type: TxType;
  kind?: '' | 'weekly' | 'extra' | 'adjust' | 'reset' | 'repair' | 'network' | 'install' | 'return';
  user: { id: string; name: string };
  product: { id: string; name: string; code: string };
  quantity: number;
  note: string;
  pending?: boolean;
  missing?: number;
  counterpart?: { id: string; name: string };
}

function txDoc(i: TxInit): Record<string, unknown> {
  return {
    timestamp: i.ts,
    weekStart: startOfWeek(i.ts),
    type: i.type,
    kind: i.kind ?? '',
    userId: i.user.id,
    userName: i.user.name,
    productId: i.product.id,
    productName: i.product.name,
    productCode: i.product.code,
    quantity: i.quantity,
    note: i.note,
    deliveryStatus: i.pending ? 'pending' : 'delivered',
    deliveryDate: i.pending ? null : i.ts,
    deliveredQty: 0,
    missing: i.missing ?? 0,
    // Siempre presentes (null si no aplica): las reglas de seguridad leen estos campos.
    counterpartId: i.counterpart?.id ?? null,
    counterpartName: i.counterpart?.name ?? null,
  };
}

/** Un único documento de stock por técnico: stock/{uid} = { userId, items: { productId: { currentStock, ... } } } */
function stockPatch(d: Deps, uid: string, deltas: Record<string, number>, ts: number, restocked: boolean): Record<string, unknown> {
  const items: Record<string, unknown> = {};
  for (const [pid, delta] of Object.entries(deltas)) {
    items[pid] = {
      currentStock: d.FieldValue.increment(delta),
      lastUpdatedAt: ts,
      ...(restocked ? { lastRestockedAt: ts } : {}),
    };
  }
  return { userId: uid, items, updatedAt: ts };
}

function initialStock(uid: string, base: Record<string, number>, ts: number): Record<string, unknown> {
  const items: Record<string, unknown> = {};
  for (const [pid, n] of Object.entries(base)) if (typeof n === 'number' && n > 0) items[pid] = { currentStock: n, lastUpdatedAt: ts };
  return { userId: uid, items, updatedAt: ts };
}

/* ------------------------------------------------------------------ */
/* Operaciones de técnico                                              */
/* ------------------------------------------------------------------ */

/** Consumo: Work Order obligatoria, no se puede gastar más de lo que se tiene. */
export async function registerConsumption(d: Deps, uid: string | undefined, data: unknown): Promise<{ ok: true; lines: number }> {
  const { uid: me, profile } = await loadCaller(d, uid);
  requireWorker(profile);
  const input = (data ?? {}) as { note?: unknown; items?: unknown; kind?: unknown };
  const note = cleanText(input.note, 120, 'Escribe la Work Order o el motivo del consumo.');
  // Tipo de consumo: '' (normal), 'repair' (reparación / sustitución) o 'network' (conexión a red).
  const kind = input.kind === 'repair' || input.kind === 'network' || input.kind === 'install' ? input.kind : '';
  if (input.kind !== undefined && input.kind !== null && input.kind !== '' && !kind) throw new OpError('invalid-argument', 'Tipo de consumo no válido.');
  const items = parseItems(input.items);
  const ts = nowOf(d);

  await d.db.runTransaction(async (tx) => {
    const stockRef = d.db.doc(`stock/${me}`);
    const [stockSnap, ...prodSnaps] = await tx.getAll(stockRef, ...items.map((i) => d.db.doc(`catalog/${i.productId}`)));
    const deltas: Record<string, number> = {};
    items.forEach((i, k) => {
      const p = readProduct(prodSnaps[k]);
      const have = stockQty(stockSnap, i.productId);
      if (i.quantity > have) throw new OpError('failed-precondition', `No tienes suficientes unidades de ${p.name} (dispones de ${have}).`);
      deltas[i.productId] = -i.quantity;
      tx.set(
        d.db.collection('transactions').doc(),
        txDoc({ ts, type: 'consumption', kind, user: { id: me, name: profile.name }, product: { id: i.productId, ...p }, quantity: i.quantity, note, pending: true }),
      );
    });
    tx.set(stockRef, stockPatch(d, me, deltas, ts, false), { merge: true });
  });
  return { ok: true, lines: items.length };
}

/** Material extra recogido en almacén fuera de la reposición semanal. No toca lo pendiente. */
export async function registerExtra(d: Deps, uid: string | undefined, data: unknown): Promise<{ ok: true; lines: number }> {
  const { uid: me, profile } = await loadCaller(d, uid);
  requireWorker(profile);
  const input = (data ?? {}) as { note?: unknown; items?: unknown };
  const note = cleanText(input.note, 120);
  const items = parseItems(input.items);
  const ts = nowOf(d);

  await d.db.runTransaction(async (tx) => {
    const prodSnaps = await tx.getAll(...items.map((i) => d.db.doc(`catalog/${i.productId}`)));
    const deltas: Record<string, number> = {};
    items.forEach((i, k) => {
      const p = readProduct(prodSnaps[k]);
      deltas[i.productId] = i.quantity;
      tx.set(
        d.db.collection('transactions').doc(),
        txDoc({ ts, type: 'restock', kind: 'extra', user: { id: me, name: profile.name }, product: { id: i.productId, ...p }, quantity: i.quantity, note }),
      );
    });
    tx.set(d.db.doc(`stock/${me}`), stockPatch(d, me, deltas, ts, true), { merge: true });
  });
  return { ok: true, lines: items.length };
}

/**
 * Devolución de material al almacén: el técnico se desprende de unidades sin pasar por consumo.
 * Resta stock y deja un `restock/return` (cantidad positiva). No es consumo, no genera pendientes ni confirmación.
 */
export async function returnToWarehouse(d: Deps, uid: string | undefined, data: unknown): Promise<{ ok: true; lines: number }> {
  const { uid: me, profile } = await loadCaller(d, uid);
  requireWorker(profile);
  const input = (data ?? {}) as { note?: unknown; items?: unknown };
  const note = cleanText(input.note, 120);
  const items = parseItems(input.items);
  const ts = nowOf(d);

  await d.db.runTransaction(async (tx) => {
    const stockRef = d.db.doc(`stock/${me}`);
    const snaps = await tx.getAll(stockRef, ...items.map((i) => d.db.doc(`catalog/${i.productId}`)));
    const out: Record<string, number> = {};
    items.forEach((i, k) => {
      const p = readProduct(snaps[1 + k]);
      const have = stockQty(snaps[0], i.productId);
      if (i.quantity > have) throw new OpError('failed-precondition', `No tienes suficientes unidades de ${p.name} (dispones de ${have}).`);
      out[i.productId] = -i.quantity;
      tx.set(
        d.db.collection('transactions').doc(),
        txDoc({ ts, type: 'restock', kind: 'return', user: { id: me, name: profile.name }, product: { id: i.productId, ...p }, quantity: i.quantity, note }),
      );
    });
    tx.set(stockRef, stockPatch(d, me, out, ts, false), { merge: true });
  });
  return { ok: true, lines: items.length };
}


/** Traspaso entre técnicos. Queda pendiente de reponer para quien da el material. */
export async function registerTransfer(d: Deps, uid: string | undefined, data: unknown): Promise<{ ok: true; lines: number }> {
  const { uid: me, profile } = await loadCaller(d, uid);
  requireWorker(profile);
  const input = (data ?? {}) as { toUserId?: unknown; note?: unknown; items?: unknown };
  const toId = cleanId(input.toUserId, 'Elige a qué técnico entregas el material.');
  if (toId === me) throw new OpError('invalid-argument', 'No puedes traspasarte material a ti mismo.');
  const note = cleanText(input.note, 120);
  const items = parseItems(input.items);
  const ts = nowOf(d);

  await d.db.runTransaction(async (tx) => {
    const stockRef = d.db.doc(`stock/${me}`);
    const toRef = d.db.doc(`users/${toId}`);
    const snaps = await tx.getAll(stockRef, toRef, ...items.map((i) => d.db.doc(`catalog/${i.productId}`)));
    const stockSnap = snaps[0];
    const toSnap = snaps[1];
    if (!toSnap.exists || (toSnap.data() as Profile).role !== 'worker') throw new OpError('not-found', 'El técnico destinatario no existe.');
    const to = toSnap.data() as Profile;
    const out: Record<string, number> = {};
    const inn: Record<string, number> = {};
    items.forEach((i, k) => {
      const p = readProduct(snaps[2 + k]);
      const have = stockQty(stockSnap, i.productId);
      if (i.quantity > have) throw new OpError('failed-precondition', `No tienes suficientes unidades de ${p.name} (dispones de ${have}).`);
      out[i.productId] = -i.quantity;
      inn[i.productId] = i.quantity;
      tx.set(
        d.db.collection('transactions').doc(),
        txDoc({
          ts,
          type: 'transfer',
          user: { id: me, name: profile.name },
          product: { id: i.productId, ...p },
          quantity: i.quantity,
          note,
          pending: false,
          counterpart: { id: toId, name: to.name },
        }),
      );
    });
    tx.set(stockRef, stockPatch(d, me, out, ts, false), { merge: true });
    tx.set(d.db.doc(`stock/${toId}`), stockPatch(d, toId, inn, ts, false), { merge: true });
  });
  return { ok: true, lines: items.length };
}

/**
 * Reposición semanal. El servidor recalcula lo pendiente de las semanas elegidas (siempre cerradas),
 * así que el cliente no puede inventarse cantidades. Lo que no se recoge queda pendiente.
 */
export async function registerWeekly(d: Deps, uid: string | undefined, data: unknown): Promise<{ ok: true; units: number }> {
  const { uid: me, profile } = await loadCaller(d, uid);
  requireWorker(profile);
  const input = (data ?? {}) as { weeks?: unknown; got?: unknown };
  const weeks = parseWeeks(input.weeks);
  const got = parseGot(input.got);
  const ts = nowOf(d);
  const currentWeek = startOfWeek(ts);

  const units = await d.db.runTransaction(async (tx) => {
    const q = d.db.collection('transactions').where('userId', '==', me).where('deliveryStatus', '==', 'pending');
    const qs = await tx.get(q);
    const lines: TxLine[] = qs.docs.map((s) => ({ id: s.id, ...(s.data() as Omit<TxLine, 'id'>) }));
    const plan = planWeekly(lines, weeks, currentWeek, got);
    if (!plan.ok) throw new OpError('failed-precondition', plan.error);

    const note = `Reposición semanal · sem ${weeks.map((w) => isoWeek(w)).join(', ')}`;
    const deltas: Record<string, number> = {};
    let total = 0;
    for (const item of plan.items) {
      for (const t of item.takes) {
        tx.update(d.db.doc(`transactions/${t.id}`), {
          deliveredQty: d.FieldValue.increment(t.take),
          ...(t.completes ? { deliveryStatus: 'delivered', deliveryDate: ts } : {}),
        });
      }
      tx.set(
        d.db.collection('transactions').doc(),
        txDoc({
          ts,
          type: 'restock',
          kind: 'weekly',
          user: { id: me, name: profile.name },
          product: { id: item.productId, name: item.productName, code: item.productCode },
          quantity: item.got,
          note,
          missing: item.requested - item.got,
        }),
      );
      deltas[item.productId] = item.got;
      total += item.got;
    }
    tx.set(d.db.doc(`stock/${me}`), stockPatch(d, me, deltas, ts, true), { merge: true });
    return total;
  });
  return { ok: true, units };
}

/* ------------------------------------------------------------------ */
/* Operaciones de almacén                                              */
/* ------------------------------------------------------------------ */

/** Marca como entregadas líneas pendientes (de uno o varios técnicos) y repone su stock. */
export async function adminDeliver(
  d: Deps,
  uid: string | undefined,
  data: unknown,
): Promise<{ ok: true; delivered: number; skipped: number }> {
  const { profile } = await loadCaller(d, uid);
  requireStaff(profile);
  const raw = (data as { txIds?: unknown } | null)?.txIds;
  if (!Array.isArray(raw) || raw.length === 0) throw new OpError('invalid-argument', 'Selecciona al menos un registro.');
  if (raw.length > MAX_DELIVER) throw new OpError('invalid-argument', `Máximo ${MAX_DELIVER} registros por entrega.`);
  const ids = [...new Set(raw.map((x) => cleanId(x)))];
  const ts = nowOf(d);

  const result = await d.db.runTransaction(async (tx) => {
    const snaps = await tx.getAll(...ids.map((id) => d.db.doc(`transactions/${id}`)));
    const lines: TxLine[] = snaps.filter((s) => s.exists).map((s) => ({ id: s.id, ...(s.data() as Omit<TxLine, 'id'>) }));
    const groups = planDelivery(lines);
    if (!groups.length) throw new OpError('failed-precondition', 'No hay nada pendiente en la selección.');

    const userIds = [...new Set(groups.map((g) => g.userId))];
    const userSnaps = await tx.getAll(...userIds.map((u) => d.db.doc(`users/${u}`)));
    const alive = new Set(userSnaps.filter((s) => s.exists).map((s) => s.id));

    let delivered = 0;
    let skipped = 0;
    const perUser = new Map<string, Record<string, number>>();
    for (const g of groups) {
      if (!alive.has(g.userId)) {
        skipped += g.takes.length;
        continue;
      }
      for (const t of g.takes) {
        tx.update(d.db.doc(`transactions/${t.id}`), {
          deliveredQty: d.FieldValue.increment(t.take),
          deliveryStatus: 'delivered',
          deliveryDate: ts,
        });
        delivered++;
      }
      tx.set(
        d.db.collection('transactions').doc(),
        txDoc({
          ts,
          type: 'restock',
          kind: 'weekly',
          user: { id: g.userId, name: g.userName },
          product: { id: g.productId, name: g.productName, code: g.productCode },
          quantity: g.quantity,
          note: 'Entrega registrada por almacén',
        }),
      );
      const m = perUser.get(g.userId) ?? {};
      m[g.productId] = (m[g.productId] ?? 0) + g.quantity;
      perUser.set(g.userId, m);
    }
    for (const [u, deltas] of perUser) tx.set(d.db.doc(`stock/${u}`), stockPatch(d, u, deltas, ts, true), { merge: true });
    return { delivered, skipped };
  });
  return { ok: true, ...result };
}

/* ------------------------------------------------------------------ */
/* Gestión de usuarios (código de empleado + contraseña)               */
/* ------------------------------------------------------------------ */

function parseCode(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(s)) {
    throw new OpError('invalid-argument', 'El código de empleado debe tener entre 3 y 32 caracteres (letras, números, punto o guion).');
  }
  return s;
}

function parsePassword(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < 6) throw new OpError('invalid-argument', 'La contraseña debe tener al menos 6 caracteres.');
  if (raw.length > 128) throw new OpError('invalid-argument', 'La contraseña es demasiado larga.');
  return raw;
}

const emailOf = (d: Deps, code: string): string => `${code.toLowerCase()}@${d.emailDomain}`;

function mapAuthError(e: unknown): never {
  const code = (e as { code?: string } | null)?.code;
  if (code === 'auth/email-already-exists') throw new OpError('already-exists', 'Ya existe un usuario con ese código de empleado.');
  if (code === 'auth/invalid-password') throw new OpError('invalid-argument', 'La contraseña no es válida (mínimo 6 caracteres).');
  if (code === 'auth/user-not-found') throw new OpError('not-found', 'El usuario no existe.');
  throw e;
}

async function ensureAnotherAdmin(d: Deps, excludeId: string): Promise<void> {
  const s = await d.db.collection('users').where('role', '==', 'admin').get();
  if (!s.docs.some((x) => x.id !== excludeId)) throw new OpError('failed-precondition', 'Debe quedar al menos un administrador.');
}

async function roleBase(d: Deps, roleId: string): Promise<Record<string, number>> {
  const rs = await d.db.doc(`technicianRoles/${cleanId(roleId)}`).get();
  if (!rs.exists) throw new OpError('not-found', 'El rol técnico elegido no existe.');
  return ((rs.data() as { baseStock?: Record<string, number> }).baseStock ?? {}) as Record<string, number>;
}

/** Alta de usuario: crea la cuenta (código@dominio + contraseña), su ficha y, si es técnico, su stock inicial (el de su rol). */
export async function createUser(d: Deps, uid: string | undefined, data: unknown): Promise<{ ok: true; uid: string }> {
  const { profile } = await loadCaller(d, uid);
  requireStaff(profile);
  const i = (data ?? {}) as Record<string, unknown>;
  const code = parseCode(i.employeeCode);
  const name = cleanText(i.name, 80, 'Escribe el nombre.');
  const password = parsePassword(i.password);
  if (!isRole(i.role)) throw new OpError('invalid-argument', 'Elige el rol del usuario.');
  const role = i.role;
  if (role === 'admin') requireAdmin(profile); // solo un administrador puede crear administradores
  const department = cleanText(i.department, 80);
  const territory = role === 'worker' ? cleanText(i.territory, 80) : '';
  const zona = role === 'worker' ? parseZona(i.zona) : '';
  if (zona) requireAdmin(profile); // solo un administrador asigna la zona
  let roleId = '';
  let base: Record<string, number> = {};
  if (role === 'worker') {
    roleId = cleanId(i.technicianRoleId, 'Elige el rol técnico.');
    base = await roleBase(d, roleId);
  }

  let created: { uid: string };
  try {
    created = await d.auth.createUser({ email: emailOf(d, code), password, displayName: name });
  } catch (e) {
    mapAuthError(e);
  }
  const ts = nowOf(d);
  try {
    await d.db.runTransaction(async (tx) => {
      tx.set(d.db.doc(`users/${created.uid}`), { employeeCode: code, name, role, department, territory, technicianRoleId: roleId, zona, createdAt: ts });
      if (role === 'worker') tx.set(d.db.doc(`stock/${created.uid}`), initialStock(created.uid, base, ts));
    });
  } catch (e) {
    await d.auth.deleteUser(created.uid).catch(() => undefined); // no dejar cuentas huérfanas
    throw e;
  }
  return { ok: true, uid: created.uid };
}

/** Edición de usuario (datos, rol, territorio, código de empleado). */
export async function updateUser(d: Deps, uid: string | undefined, data: unknown): Promise<{ ok: true }> {
  const { profile } = await loadCaller(d, uid);
  requireStaff(profile);
  const i = (data ?? {}) as Record<string, unknown>;
  const targetId = cleanId(i.uid);
  const ref = d.db.doc(`users/${targetId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new OpError('not-found', 'El usuario no existe.');
  const cur = snap.data() as Profile;

  const role = i.role === undefined ? cur.role : isRole(i.role) ? i.role : undefined;
  if (!role) throw new OpError('invalid-argument', 'Rol no válido.');
  // Tocar a un administrador, o convertir a alguien en administrador, es solo del administrador (evita escaladas de privilegio).
  if (cur.role === 'admin' || role === 'admin') requireAdmin(profile);
  const next: Profile = {
    employeeCode: i.employeeCode === undefined ? cur.employeeCode : parseCode(i.employeeCode),
    name: i.name === undefined ? cur.name : cleanText(i.name, 80, 'Escribe el nombre.'),
    role,
    department: i.department === undefined ? cur.department : cleanText(i.department, 80),
    territory: '',
    technicianRoleId: '',
    zona: '',
  };
  let base: Record<string, number> = {};
  if (role === 'worker') {
    next.territory = i.territory === undefined ? cur.territory : cleanText(i.territory, 80);
    next.technicianRoleId = i.technicianRoleId === undefined ? cur.technicianRoleId : cleanId(i.technicianRoleId, 'Elige el rol técnico.');
    base = await roleBase(d, next.technicianRoleId);
  }
  if (role === 'worker') next.zona = i.zona === undefined ? (cur.zona ?? '') : parseZona(i.zona);
  if ((next.zona ?? '') !== (cur.zona ?? '')) requireAdmin(profile); // la zona solo la cambia un administrador
  if (cur.role === 'admin' && role !== 'admin') await ensureAnotherAdmin(d, targetId);

  const authProps: { email?: string; displayName?: string } = {};
  if (next.employeeCode.toLowerCase() !== cur.employeeCode.toLowerCase()) authProps.email = emailOf(d, next.employeeCode);
  if (next.name !== cur.name) authProps.displayName = next.name;
  if (Object.keys(authProps).length) {
    try {
      await d.auth.updateUser(targetId, authProps);
    } catch (e) {
      mapAuthError(e);
    }
  }

  const ts = nowOf(d);
  await d.db.runTransaction(async (tx) => {
    const stockRef = d.db.doc(`stock/${targetId}`);
    const stockSnap = role === 'worker' ? await tx.get(stockRef) : undefined;
    tx.update(ref, { ...next });
    if (stockSnap && !stockSnap.exists) tx.set(stockRef, initialStock(targetId, base, ts));
  });
  return { ok: true };
}

/** Restablece la contraseña de un usuario y cierra sus sesiones abiertas. */
export async function setPassword(d: Deps, uid: string | undefined, data: unknown): Promise<{ ok: true }> {
  const { profile } = await loadCaller(d, uid);
  requireStaff(profile);
  const i = (data ?? {}) as { uid?: unknown; password?: unknown };
  const targetId = cleanId(i.uid);
  const password = parsePassword(i.password);
  const target = await d.db.doc(`users/${targetId}`).get();
  if (target.exists && (target.data() as Profile).role === 'admin') requireAdmin(profile);
  try {
    await d.auth.updateUser(targetId, { password });
    await d.auth.revokeRefreshTokens(targetId);
  } catch (e) {
    mapAuthError(e);
  }
  return { ok: true };
}

/** Elimina la cuenta, la ficha y el stock del usuario. Sus movimientos se conservan en el historial. */
export async function deleteUser(d: Deps, uid: string | undefined, data: unknown): Promise<{ ok: true }> {
  const { uid: me, profile } = await loadCaller(d, uid);
  requireStaff(profile);
  const targetId = cleanId((data as { uid?: unknown } | null)?.uid);
  if (targetId === me) throw new OpError('failed-precondition', 'No puedes eliminar tu propio usuario.');
  const snap = await d.db.doc(`users/${targetId}`).get();
  if (!snap.exists) throw new OpError('not-found', 'El usuario no existe.');
  if ((snap.data() as Profile).role === 'admin') {
    requireAdmin(profile);
    await ensureAnotherAdmin(d, targetId);
  }
  try {
    await d.auth.deleteUser(targetId);
  } catch (e) {
    if ((e as { code?: string } | null)?.code !== 'auth/user-not-found') throw e;
  }
  await d.db.runTransaction(async (tx) => {
    tx.delete(d.db.doc(`users/${targetId}`));
    tx.delete(d.db.doc(`stock/${targetId}`));
  });
  return { ok: true };
}


/**
 * Ajuste manual del almacén: fija la cantidad real de un producto en un técnico (inventario, pérdida, alta inicial...).
 * Deja un movimiento `restock/adjust` con la diferencia (con signo) y el motivo. No cuenta como consumo ni genera pendientes.
 */
export async function adjustStock(d: Deps, uid: string | undefined, data: unknown): Promise<{ ok: true; delta: number }> {
  const { uid: me, profile } = await loadCaller(d, uid);
  requireStaff(profile);
  const input = (data ?? {}) as { userId?: unknown; productId?: unknown; quantity?: unknown; note?: unknown };
  const target = typeof input.userId === 'string' ? input.userId : '';
  const pid = typeof input.productId === 'string' ? input.productId : '';
  const qty = input.quantity;
  if (!target || !pid) throw new OpError('invalid-argument', 'Faltan el técnico o el producto.');
  if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 0 || qty > 100_000) {
    throw new OpError('invalid-argument', 'La cantidad debe ser un número entero de 0 o más.');
  }
  const note = cleanText(input.note, 120);
  if (!note) throw new OpError('invalid-argument', 'Indica el motivo del ajuste.');
  const ts = nowOf(d);

  const delta = await d.db.runTransaction(async (tx) => {
    const [userSnap, prodSnap, stockSnap] = (await tx.getAll(
      d.db.doc(`users/${target}`),
      d.db.doc(`catalog/${pid}`),
      d.db.doc(`stock/${target}`),
    )) as Snap[];
    if (!userSnap.exists) throw new OpError('not-found', 'El técnico ya no existe.');
    const worker = userSnap.data() as Profile;
    if (worker.role !== 'worker') throw new OpError('invalid-argument', 'Solo se puede ajustar el stock de técnicos.');
    const product = readProduct(prodSnap);
    const diff = qty - stockQty(stockSnap, pid);
    if (diff === 0) throw new OpError('failed-precondition', 'Ya tiene esa cantidad: no hay nada que ajustar.');
    tx.set(
      d.db.collection('transactions').doc(),
      txDoc({ ts, type: 'restock', kind: 'adjust', user: { id: target, name: worker.name }, product: { id: pid, ...product }, quantity: diff, note }),
    );
    tx.set(d.db.doc(`stock/${target}`), stockPatch(d, target, { [pid]: diff }, ts, false), { merge: true });
    return diff;
  });
  void me;
  return { ok: true, delta };
}

/**
 * Reset a stock base: deja a un técnico exactamente con el stock base de su rol técnico.
 * Lo que le sobra (incluidos los productos que no están en su base) pasa a 0 y lo que le falta se completa.
 * Cada diferencia queda en el historial como "Reset stock base" (movimiento `restock/reset` con la diferencia con signo).
 */
export async function resetToBase(d: Deps, uid: string | undefined, data: unknown): Promise<{ ok: true; changed: number }> {
  const { profile } = await loadCaller(d, uid);
  requireStaff(profile);
  const target = typeof (data as { userId?: unknown } | null)?.userId === 'string' ? (data as { userId: string }).userId : '';
  if (!target) throw new OpError('invalid-argument', 'Falta el técnico.');
  const ts = nowOf(d);

  const changed = await d.db.runTransaction(async (tx) => {
    const userSnap = (await tx.get(d.db.doc(`users/${target}`))) as Snap;
    if (!userSnap.exists) throw new OpError('not-found', 'El técnico ya no existe.');
    const worker = userSnap.data() as Profile;
    if (worker.role !== 'worker') throw new OpError('invalid-argument', 'Solo se puede resetear el stock de técnicos.');
    const roleSnap = (await tx.get(d.db.doc(`technicianRoles/${worker.technicianRoleId}`))) as Snap;
    if (!roleSnap.exists) throw new OpError('failed-precondition', 'El técnico no tiene un rol técnico válido.');
    const base = ((roleSnap.data() as { baseStock?: Record<string, number> }).baseStock ?? {}) as Record<string, number>;
    const stockSnap = (await tx.get(d.db.doc(`stock/${target}`))) as Snap;
    const cur = (stockSnap.exists ? ((stockSnap.data() as { items?: Record<string, { currentStock?: number }> }).items ?? {}) : {}) as Record<
      string,
      { currentStock?: number }
    >;

    const diffs: Record<string, number> = {};
    for (const pid of new Set([...Object.keys(base), ...Object.keys(cur)])) {
      const want = typeof base[pid] === 'number' && base[pid] > 0 ? base[pid] : 0;
      const have = typeof cur[pid]?.currentStock === 'number' ? (cur[pid].currentStock as number) : 0;
      if (want !== have) diffs[pid] = want - have;
    }
    const ids = Object.keys(diffs);
    if (!ids.length) throw new OpError('failed-precondition', 'Este técnico ya tiene exactamente su stock base.');
    if (ids.length > 400) throw new OpError('failed-precondition', 'Demasiados productos distintos para un solo reset.');

    const prodSnaps = (await tx.getAll(...ids.map((pid) => d.db.doc(`catalog/${pid}`)))) as Snap[];
    const applied: Record<string, number> = {};
    ids.forEach((pid, k) => {
      if (!prodSnaps[k].exists) return; // producto borrado del catálogo: se ignora
      const p = readProduct(prodSnaps[k]);
      applied[pid] = diffs[pid];
      tx.set(
        d.db.collection('transactions').doc(),
        txDoc({ ts, type: 'restock', kind: 'reset', user: { id: target, name: worker.name }, product: { id: pid, ...p }, quantity: diffs[pid], note: 'Reset stock base' }),
      );
    });
    const n = Object.keys(applied).length;
    if (!n) throw new OpError('failed-precondition', 'No hay productos que ajustar.');
    tx.set(d.db.doc(`stock/${target}`), stockPatch(d, target, applied, ts, false), { merge: true });
    return n;
  });
  return { ok: true, changed };
}

/** Todas las operaciones, por nombre (cada una es una Cloud Function con el mismo nombre). */
export const OPS = {
  registerConsumption,
  registerExtra,
  registerTransfer,
  registerWeekly,
  adminDeliver,
  adjustStock,
  returnToWarehouse,
  resetToBase,
  createUser,
  updateUser,
  setPassword,
  deleteUser,
} as const;

export type OpName = keyof typeof OPS;
