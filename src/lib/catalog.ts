import type { Folder, Pack, Product } from '../types';
import { byText } from './format';

export interface FolderGroup {
  name: string;
  items: Product[];
}

/** Nombres de carpeta: las que existen como documento y cualquiera que use algún producto. */
export function folderNames(folders: Folder[], products: Product[]): string[] {
  const set = new Set(folders.map((f) => f.name));
  for (const p of products) if (p.category) set.add(p.category);
  return [...set].sort(byText);
}

/** Productos agrupados por carpeta (solo carpetas con productos), ordenados por nombre de carpeta y código. */
export function groupByFolder(products: Product[]): FolderGroup[] {
  const map = new Map<string, Product[]>();
  for (const p of products) {
    const k = p.category || 'Sin carpeta';
    const l = map.get(k);
    if (l) l.push(p);
    else map.set(k, [p]);
  }
  return [...map]
    .sort((a, b) => byText(a[0], b[0]))
    .map(([name, items]) => ({ name, items: items.slice().sort((a, b) => byText(a.code, b.code)) }));
}

export const matchesProduct = (p: Product, q: string): boolean => {
  const s = q.trim().toLowerCase();
  return !s || `${p.code} ${p.name}`.toLowerCase().includes(s);
};

export const PRIORITY_LABEL = { 'muy-habitual': 'Muy habitual', habitual: 'Habitual' } as const;

/** Orden dentro de un grupo de prioridad: primero los que tienen posición (de menor a mayor), luego el resto por código. */
export const sortPriorityGroup = (items: Product[]): Product[] =>
  items.slice().sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || byText(a.code, b.code));

/** Productos con prioridad: primero los muy habituales y luego los habituales, cada grupo en el orden que fija el administrador. */
export function byPriority(products: Product[]): { priority: 'muy-habitual' | 'habitual'; items: Product[] }[] {
  const pick = (k: 'muy-habitual' | 'habitual') => ({ priority: k, items: sortPriorityGroup(products.filter((p) => p.priority === k)) });
  return [pick('muy-habitual'), pick('habitual')].filter((g) => g.items.length > 0);
}

/** Packs en el orden que fija el administrador; los que aún no tienen posición van al final, por nombre. */
export const sortPacks = (packs: Pack[]): Pack[] => packs.slice().sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || byText(a.name, b.name));
