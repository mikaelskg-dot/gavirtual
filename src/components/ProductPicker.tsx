import { useMemo, useState, type ReactNode } from 'react';
import type { Product } from '../types';
import { byPriority, groupByFolder, matchesProduct } from '../lib/catalog';
import { uds } from '../lib/format';
import { Empty, Stepper } from '../ui';

interface Props {
  products: Product[];
  qty: Record<string, number>;
  onChange: (productId: string, quantity: number) => void;
  /** tope por producto (por ejemplo, el stock disponible); sin tope si devuelve undefined */
  max?: (productId: string) => number | undefined;
  /** texto extra bajo el código del producto */
  hint?: (p: Product) => ReactNode;
  emptyText?: string;
  /** Carpetas plegadas por defecto y apartado superior con los productos habituales (registrar consumo). */
  compact?: boolean;
}

/** Lista de productos por carpetas con buscador y selector de cantidad. */
export function ProductPicker({ products, qty, onChange, max, hint, emptyText, compact }: Props) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const matching = useMemo(() => products.filter((p) => matchesProduct(p, q)), [products, q]);
  const groups = useMemo(() => groupByFolder(matching), [matching]);
  const top = useMemo(() => (compact ? byPriority(matching) : []), [compact, matching]);
  const searching = q.trim().length > 0;

  const toggle = (name: string): void =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  const row = (p: Product, keyPrefix = '') => (
    <div className="crow" key={keyPrefix + p.id}>
      <div className="pn">
        <div className="pname">{p.name}</div>
        <div className="pcode">
          {p.code}
          {hint ? hint(p) : null}
        </div>
      </div>
      <Stepper value={qty[p.id] ?? 0} max={max?.(p.id)} onChange={(n) => onChange(p.id, n)} label={p.name} />
    </div>
  );

  return (
    <div className="picker">
      <div className="field">
        <label htmlFor="picker-q" className="sr">
          Buscar producto
        </label>
        <input id="picker-q" type="search" className="search" placeholder="Buscar por código o nombre" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      </div>
      {matching.length === 0 ? (
        <Empty>{q ? 'Ningún producto coincide con la búsqueda.' : (emptyText ?? 'No hay productos disponibles.')}</Empty>
      ) : (
        <>
          {top.map((g) => {
            const key = `__${g.priority}`;
            const isOpen = searching || open.has(key);
            const picked = g.items.reduce((a, p) => a + (qty[p.id] ?? 0), 0);
            return (
              <div className="cartfolder topfolder" key={key}>
                <button type="button" className="cfbtn" aria-expanded={isOpen} onClick={() => toggle(key)}>
                  <span className="chev" aria-hidden="true">
                    ›
                  </span>
                  <span className="cfname prio">{g.priority === 'muy-habitual' ? 'Muy habituales' : 'Habituales'}</span>
                  <span className="cfcount">{g.items.length}</span>
                  {picked > 0 ? <span className="cfpicked">{uds(picked)}</span> : null}
                </button>
                {isOpen ? <div className="cfbody">{g.items.map((p) => row(p, 'top-'))}</div> : null}
              </div>
            );
          })}
          {groups.map((g) => {
            if (!compact) {
              return (
                <div className="cartcat" key={g.name}>
                  <h3>{g.name}</h3>
                  {g.items.map((p) => row(p))}
                </div>
              );
            }
            const isOpen = searching || open.has(g.name);
            const picked = g.items.reduce((a, p) => a + (qty[p.id] ?? 0), 0);
            return (
              <div className="cartfolder" key={g.name}>
                <button type="button" className="cfbtn" aria-expanded={isOpen} onClick={() => toggle(g.name)}>
                  <span className="chev" aria-hidden="true">
                    ›
                  </span>
                  <span className="cfname">{g.name}</span>
                  <span className="cfcount">{g.items.length}</span>
                  {picked > 0 ? <span className="cfpicked">{uds(picked)}</span> : null}
                </button>
                {isOpen ? <div className="cfbody">{g.items.map((p) => row(p))}</div> : null}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
