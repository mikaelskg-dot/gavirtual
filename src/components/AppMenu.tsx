import { useEffect, useMemo, useRef, useState } from 'react';
import { collection, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { useQuery } from '../data/DataContext';
import {
  clipToYear, eventsOfYear, fmtShort, isoWeekOfDate, toDay, todayMadrid, vacationDaysUsed, VACACIONES_ANUALES,
  type CalEvento, type EventoTipo,
} from '../lib/calendar';
import type { UserDoc } from '../types';
import { Collapse, Empty, Modal, Pill } from '../ui';

type Panel = null | 'vacaciones' | 'guardia';
type Theme = 'light' | 'dark';

const THEME_KEY = 'stock-tema';
const savedTheme = (): Theme | null => {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null; // sin almacenamiento (modo privado...): se usa el tema del dispositivo
  }
};
const currentTheme = (): Theme => savedTheme() ?? (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const applyTheme = (t: Theme): void => document.documentElement.setAttribute('data-theme', t);

// Al cargar la aplicación, si el usuario eligió un tema se aplica enseguida (también en la pantalla de acceso).
if (typeof document !== 'undefined' && savedTheme()) applyTheme(currentTheme());

/** Engranaje de la barra superior: contraseña, vacaciones y guardias (solo técnicos) y salir. */
export function AppMenu({ me, onPassword, onLogout }: { me: UserDoc; onPassword: () => void; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const box = useRef<HTMLDivElement>(null);
  const isWorker = me.role === 'worker';

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent | TouchEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('touchstart', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('touchstart', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const toggleTheme = (): void => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* sin almacenamiento: el cambio vale solo para esta sesión */
    }
    applyTheme(next);
    setTheme(next);
  };

  const pick = (fn: () => void): void => {
    setOpen(false);
    fn();
  };

  return (
    <div className="appmenu" ref={box}>
      <button type="button" className="btn sm gearbtn" aria-label="Ajustes" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      {open ? (
        <div className="menu" role="menu">
          <button type="button" role="menuitem" onClick={() => pick(onPassword)}>
            Contraseña
          </button>
          {isWorker ? (
            <>
              <button type="button" role="menuitem" onClick={() => pick(() => setPanel('vacaciones'))}>
                Vacaciones
              </button>
              <button type="button" role="menuitem" onClick={() => pick(() => setPanel('guardia'))}>
                Guardias
              </button>
            </>
          ) : null}
          <button type="button" role="menuitem" onClick={() => pick(toggleTheme)}>
            {theme === 'dark' ? 'Modo claro' : 'Modo oscuro'}
          </button>
          <button type="button" role="menuitem" className="out" onClick={() => pick(onLogout)}>
            Salir
          </button>
        </div>
      ) : null}
      {panel ? <MyCalendar kind={panel} me={me} onClose={() => setPanel(null)} /> : null}
    </div>
  );
}

const days = (e: Pick<CalEvento, 'inicio' | 'fin'>): number => toDay(e.fin) - toDay(e.inicio) + 1;
const range = (e: Pick<CalEvento, 'inicio' | 'fin'>): string => (e.inicio === e.fin ? fmtShort(e.inicio, true) : `${fmtShort(e.inicio, e.inicio.slice(0, 4) !== e.fin.slice(0, 4))} – ${fmtShort(e.fin, true)}`);

/** Solo lectura: las vacaciones o las guardias del propio técnico (nunca las de otros, ni bajas, ni notas). */
function MyCalendar({ kind, me, onClose }: { kind: Exclude<Panel, null>; me: UserDoc; onClose: () => void }) {
  const tipo: EventoTipo = kind;
  const today = useMemo(() => todayMadrid(), []);
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  // La consulta lleva los dos filtros (userId y tipo) porque las reglas solo dejan leer lo propio y de ese tipo.
  const q = useQuery<CalEvento>(() => query(collection(db, 'calendario_eventos'), where('userId', '==', me.id), where('tipo', '==', tipo)), [me.id, tipo]);
  const list = useMemo(() => eventsOfYear(q.data, tipo, year), [q.data, tipo, year]);
  const upcoming = list.filter((e) => e.fin >= today);
  const past = list.filter((e) => e.fin < today);
  const used = useMemo(() => vacationDaysUsed(q.data, me.id, year), [q.data, me.id, year]);
  const guardDays = list.reduce((a, e) => {
    const c = clipToYear(e, year);
    return a + (c ? c[1] - c[0] + 1 : 0);
  }, 0);

  const row = (e: CalEvento) => {
    const now = e.inicio <= today && today <= e.fin;
    const w1 = isoWeekOfDate(e.inicio);
    const w2 = isoWeekOfDate(e.fin);
    return (
      <div className="crow" key={e.id}>
        <div className="pn">
          <div className="pname">{range(e)}</div>
          <div className="pcode">
            {days(e)} {days(e) === 1 ? 'día' : 'días'}
            {kind === 'guardia' ? ` · ${w1 === w2 ? `Semana ${w1}` : `Semanas ${w1}–${w2}`}` : ''}
          </div>
        </div>
        {now ? <Pill tone="info">Ahora</Pill> : null}
      </div>
    );
  };

  return (
    <Modal
      title={kind === 'vacaciones' ? 'Mis vacaciones' : 'Mis guardias'}
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          <button type="button" className="btn primary" onClick={onClose}>
            Cerrar
          </button>
        </>
      }
    >
      <div className="seg" role="group" aria-label="Año" style={{ marginBottom: 12 }}>
        <button type="button" onClick={() => setYear(year - 1)} aria-label="Año anterior">
          ‹
        </button>
        <button type="button" aria-pressed="true" style={{ cursor: 'default' }}>
          {year}
        </button>
        <button type="button" onClick={() => setYear(year + 1)} aria-label="Año siguiente">
          ›
        </button>
      </div>
      {q.error ? (
        <p className="err" role="alert">
          No se ha podido cargar: {q.error}
        </p>
      ) : !q.loaded ? (
        <div className="empty">Cargando…</div>
      ) : (
        <>
          <p className="sub" style={{ marginBottom: 10 }}>
            {kind === 'vacaciones'
              ? `${used} de ${VACACIONES_ANUALES} días naturales usados en ${year} (los festivos cuentan).`
              : `${guardDays} ${guardDays === 1 ? 'día' : 'días'} de guardia en ${year}.`}{' '}
            Solo informativo.
          </p>
          {upcoming.length === 0 && past.length === 0 ? <Empty>{kind === 'vacaciones' ? `No tienes vacaciones registradas en ${year}.` : `No tienes guardias registradas en ${year}.`}</Empty> : null}
          {upcoming.length ? (
            <>
              <h3 className="sub" style={{ margin: '4px 0' }}>Próximas</h3>
              {upcoming.map(row)}
            </>
          ) : past.length ? (
            <Empty>No tienes más {kind === 'vacaciones' ? 'vacaciones' : 'guardias'} próximas en {year}.</Empty>
          ) : null}
          {past.length ? (
            <div style={{ marginTop: 8 }}>
              <Collapse title="Pasadas" badge={<Pill>{past.length}</Pill>}>
                {past.map(row)}
              </Collapse>
            </div>
          ) : null}
        </>
      )}
    </Modal>
  );
}
