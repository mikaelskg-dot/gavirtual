import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/* ------------------------------------------------------------------ */
/* Piezas pequeñas                                                     */
/* ------------------------------------------------------------------ */

export function Pill({ tone, children }: { tone?: 'good' | 'warn' | 'crit' | 'info'; children: ReactNode }) {
  return <span className={tone ? `pill ${tone}` : 'pill'}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}

/** Selector de cantidad: botones − / + y campo numérico editable (para teclear 40 sin pulsar 40 veces). */
export function Stepper({ value, max, onChange, label }: { value: number; max?: number; onChange: (n: number) => void; label: string }) {
  const clamp = (n: number): number => Math.max(0, Math.min(max ?? 100_000, Number.isFinite(n) ? Math.trunc(n) : 0));
  return (
    <div className="step">
      <button type="button" onClick={() => onChange(clamp(value - 1))} disabled={value <= 0} aria-label={`Quitar una unidad de ${label}`}>
        −
      </button>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        max={max}
        value={value}
        aria-label={`Cantidad de ${label}`}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => onChange(clamp(e.currentTarget.value === '' ? 0 : Number(e.currentTarget.value)))}
      />
      <button type="button" onClick={() => onChange(clamp(value + 1))} disabled={max !== undefined && value >= max} aria-label={`Añadir una unidad de ${label}`}>
        +
      </button>
    </div>
  );
}

/** Bloque desplegable compacto (cerrado por defecto). */
export function Collapse({ title, badge, defaultOpen = false, children }: { title: ReactNode; badge?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="coll">
      <button type="button" className="collbtn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="chev" aria-hidden="true">
          ›
        </span>
        <span className="collname">{title}</span>
        {badge}
      </button>
      {open ? <div className="collbody">{children}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Ventana modal                                                       */
/* ------------------------------------------------------------------ */

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input:not([type=checkbox]):not([type=number]), select, textarea')?.focus();
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div className="overlay" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={ref}>
        <div className="modal-head">
          <h2 id="modal-title">{title}</h2>
          <button type="button" className="btn sm" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/** Ventana informativa con un solo botón. */
export function InfoModal({ title, intro, items, onClose }: { title: string; intro?: string; items: string[]; onClose: () => void }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <button type="button" className="btn primary" onClick={onClose}>
          Entendido
        </button>
      }
    >
      {intro ? <p className="sub">{intro}</p> : null}
      {items.map((t, i) => (
        <div className="crow" key={i}>
          <div className="pn">{t}</div>
        </div>
      ))}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Avisos y confirmaciones                                             */
/* ------------------------------------------------------------------ */

const ToastCtx = createContext<(msg: string) => void>(() => undefined);
export const useToast = (): ((msg: string) => void) => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: string }[]>([]);
  const seq = useRef(0);
  const push = useCallback((msg: string) => {
    const id = ++seq.current;
    setItems((s) => [...s, { id, msg }]);
    setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), 3600);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-root" aria-live="polite">
        {items.map((t) => (
          <div className="toast" key={t.id}>
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);
export const useConfirm = (): ((o: ConfirmOptions) => Promise<boolean>) => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ opts: ConfirmOptions; resolve: (v: boolean) => void } | null>(null);
  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ opts, resolve })), []);
  const done = (v: boolean): void => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {state ? (
        <Modal
          title={state.opts.title}
          onClose={() => done(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => done(false)}>
                Cancelar
              </button>
              <button type="button" className={state.opts.danger ? 'btn danger solid' : 'btn primary'} onClick={() => done(true)}>
                {state.opts.confirmLabel ?? 'Confirmar'}
              </button>
            </>
          }
        >
          <p>{state.opts.message}</p>
        </Modal>
      ) : null}
    </ConfirmCtx.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* Acciones asíncronas con estado "ocupado" y error                    */
/* ------------------------------------------------------------------ */

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(async (fn: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError('');
    try {
      await fn();
      return true;
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}
