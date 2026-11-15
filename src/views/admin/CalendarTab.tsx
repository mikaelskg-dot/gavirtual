import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { addDoc, collection, deleteDoc, doc, query, setDoc, updateDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { useData, useQuery } from '../../data/DataContext';
import {
  DIAS_SEMANA, MESES, MESES_CORTO, TIPO_LABEL, VACACIONES_ANUALES, ZONAS, addDays, clipToYear, dateAt, dayIndex, daysInMonth, daysInYear, festivoMap, fmtShort,
  guardCounts, holidaysFor, isDate, isWeekend, monthStartIdx, provinciaDe, runs, todayMadrid, toDay, vacationByWeek, vacationDaysUsed,
  type CalEvento, type CalFestivo, type EstadoVac, type EventoTipo, type Provincia, type Zona,
} from '../../lib/calendar';
import type { UserDoc } from '../../types';
import { Empty, Field, Modal, Pill, useAction, useConfirm, useToast } from '../../ui';

const NAME_W = 176;
const DETAIL_W = 26;
const MAX_W = 48; // ancho máximo de un día al hacer zoom (px)
const COMPACT_BELOW = 18; // por debajo de este ancho no caben los números de día ni los tiradores
const COL_EVENTOS = 'calendario_eventos';
const COL_FESTIVOS = 'calendario_festivos';

type Run = { start: number; len: number };
type Mode = 'select' | 'move' | 'rl' | 'rr' | 'click';
interface Drag {
  mode: Mode;
  userId: string;
  evId?: string;
  start: number;
  cur: number;
  orig?: { inicio: string; fin: string };
}
interface Preview {
  evId: string;
  inicio: string;
  fin: string;
}
type FormState = null | { ev?: CalEvento; userId: string; inicio: string; fin: string };

const clamp = (n: number, a: number, b: number): number => Math.min(b, Math.max(a, n));

/** Fechas resultantes de mover o cambiar la duración de un evento según lo arrastrado. */
function previewOf(d: Drag): { inicio: string; fin: string } | null {
  if (!d.orig || d.mode === 'select' || d.mode === 'click') return null;
  const delta = d.cur - d.start;
  const { inicio, fin } = d.orig;
  if (d.mode === 'move') return { inicio: addDays(inicio, delta), fin: addDays(fin, delta) };
  if (d.mode === 'rl') {
    const ni = addDays(inicio, delta);
    return { inicio: toDay(ni) > toDay(fin) ? fin : ni, fin };
  }
  const nf = addDays(fin, delta);
  return { inicio, fin: toDay(nf) < toDay(inicio) ? inicio : nf };
}

const evTitle = (e: Pick<CalEvento, 'tipo' | 'estado' | 'inicio' | 'fin'>): string => {
  const n = toDay(e.fin) - toDay(e.inicio) + 1;
  const what = e.tipo === 'vacaciones' ? `Vacaciones ${e.estado === 'fija' ? 'fijas' : 'flexibles'}` : TIPO_LABEL[e.tipo];
  return `${what} · ${fmtShort(e.inicio, true)} – ${fmtShort(e.fin, true)} (${n} ${n === 1 ? 'día' : 'días'})`;
};

/* ------------------------------------------------------------------ */
/* Cabecera: meses y días                                              */
/* ------------------------------------------------------------------ */

const Header = memo(function Header({ year, dayW, compact, hols, todayIdx }: { year: number; dayW: number; compact: boolean; hols: Map<string, CalFestivo[]>; todayIdx: number }) {
  const n = daysInYear(year);
  const days = useMemo(() => Array.from({ length: n }, (_, i) => dateAt(i, year)), [n, year]);
  return (
    <div className="calhead">
      <div className="calrow">
        <div className="calname calcorner">{year}</div>
        <div className="caldays" style={{ width: n * dayW, height: 24 }}>
          {MESES.map((m, i) => (
            <div key={m} className="calmonth" style={{ left: monthStartIdx(year, i) * dayW, width: daysInMonth(year, i) * dayW }}>
              {compact ? MESES_CORTO[i] : m}
            </div>
          ))}
        </div>
      </div>
      {compact ? null : (
        <div className="calrow">
          <div className="calname" />
          <div className="caldays" style={{ width: n * dayW, height: 34 }}>
            {days.map((d, i) => {
              const hs = hols.get(d);
              const wd = (((toDay(d) + 3) % 7) + 7) % 7;
              return (
                <div
                  key={d}
                  className={`calday${isWeekend(d) ? ' we' : ''}${hs ? ' hol' : ''}${i === todayIdx ? ' today' : ''}`}
                  style={{ left: i * dayW, width: dayW }}
                  title={hs ? hs.map((h) => `${h.nombre} (${h.ambito === 'nacional' ? 'nacional' : h.provincia})`).join('; ') : undefined}
                >
                  <b>{Number(d.slice(8))}</b>
                  <i>{DIAS_SEMANA[wd]}</i>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Desplegables de abajo: vacaciones por mes y guardias por persona    */
/* ------------------------------------------------------------------ */

const WK_W = 40; // ancho de cada semana en la tabla y en la gráfica (px)
const WK_LABEL_W = 150;

const VacationYear = memo(function VacationYear({
  year, users, events, estado,
}: {
  year: number; users: UserDoc[]; events: CalEvento[]; estado: '' | EstadoVac;
}) {
  const weeks = useMemo(() => vacationByWeek(events, users.map((u) => ({ id: u.id, name: u.name })), year, estado), [events, users, year, estado]);
  const zonaOf = useMemo(() => new Map(users.map((u) => [u.id, u.zona ?? ''])), [users]);
  const groups = useMemo(() => {
    const list: { key: string; label: string; size: number; match: (id: string) => boolean }[] = ZONAS.map((z) => ({
      key: z, label: z, size: users.filter((u) => u.zona === z).length, match: (id: string) => zonaOf.get(id) === z,
    })).filter((g) => g.size > 0);
    const sin = users.filter((u) => !u.zona).length;
    if (sin > 0) list.push({ key: 'sin', label: 'Sin zona', size: sin, match: (id) => !zonaOf.get(id) });
    return list;
  }, [users, zonaOf]);
  const months = useMemo(() => {
    const out: { m: number; from: number; len: number }[] = [];
    weeks.forEach((w, i) => {
      const last = out[out.length - 1];
      if (last && last.m === w.month) last.len++;
      else out.push({ m: w.month, from: i, len: 1 });
    });
    return out;
  }, [weeks]);
  const total = users.length;
  const rangeTxt = (w: { from: number; to: number }): string => `${fmtShort(dateAt(w.from, year))} – ${fmtShort(dateAt(w.to, year))}`;
  const tip = (label: string, w: (typeof weeks)[number], list: { name: string; days: number }[], size: number): string => {
    const sorted = [...list].sort((x, y) => x.name.localeCompare(y.name, 'es', { sensitivity: 'base' }));
    return `${label} · semana ${w.week} (${rangeTxt(w)}): ${list.length} de ${size}${sorted.length ? '\n' + sorted.map((x) => `· ${x.name} (${x.days} ${x.days === 1 ? 'día' : 'días'})`).join('\n') : ''}`;
  };
  const shade = (count: number, size: number): string | undefined =>
    count > 0 && size > 0 ? `color-mix(in srgb, var(--accent) ${Math.round(Math.min(100, (count / size) * 220))}%, transparent)` : undefined;

  /* gráfica: personas fuera por semana (total) */
  const totals = weeks.map((w) => w.people.length);
  const maxV = Math.max(1, ...totals);
  const H = 190;
  const PT = 24; // espacio arriba para las cifras
  const PB = 30; // espacio abajo para los meses
  const plotH = H - PT - PB;
  const yOf = (v: number): number => PT + plotH - (v / maxV) * plotH;
  const xOf = (i: number): number => WK_LABEL_W + i * WK_W + WK_W / 2;
  const svgW = WK_LABEL_W + weeks.length * WK_W;
  const ticks = Array.from(new Set([0, Math.round(maxV / 2), maxV]));
  const line = totals.map((v, i) => `${i === 0 ? 'M' : 'L'}${xOf(i)},${yOf(v)}`).join(' ');

  return (
    <details className="caldet">
      <summary>Vacaciones de {year}: personas fuera por semana</summary>
      <div className="body">
        {total === 0 ? (
          <p className="sub">No hay personas con los filtros actuales.</p>
        ) : (
          <>
            <table className="caltbl wktbl" style={{ width: svgW, minWidth: svgW }}>
              <colgroup>
                <col style={{ width: WK_LABEL_W }} />
                {weeks.map((w) => (
                  <col key={w.from} style={{ width: WK_W }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th scope="col" rowSpan={2} className="l">Zona</th>
                  {months.map((m) => (
                    <th scope="colgroup" colSpan={m.len} key={m.m} className="mth">{MESES[m.m]}</th>
                  ))}
                </tr>
                <tr>
                  {weeks.map((w, i) => (
                    <th scope="col" key={w.from} className={`wk${months.some((m) => m.from === i && i > 0) ? ' ms' : ''}`} title={`Semana ${w.week}: ${rangeTxt(w)}`}>
                      S{w.week}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.key}>
                    <th scope="row" className="l">{g.label} <span className="sub">({g.size})</span></th>
                    {weeks.map((w, i) => {
                      const sel = w.people.filter((x) => g.match(x.id));
                      return (
                        <td key={w.from} className={`num${months.some((m) => m.from === i && i > 0) ? ' ms' : ''}`} title={tip(g.label, w, sel, g.size)} style={{ background: shade(sel.length, g.size) }}>
                          {sel.length || '·'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr className="tot">
                  <th scope="row" className="l">Total <span className="sub">({total})</span></th>
                  {weeks.map((w, i) => (
                    <td key={w.from} className={`num${months.some((m) => m.from === i && i > 0) ? ' ms' : ''}`} title={tip('Total', w, w.people, total)} style={{ background: shade(w.people.length, total) }}>
                      {w.people.length || '·'}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>

            <svg className="wkchart" width={svgW} height={H} viewBox={`0 0 ${svgW} ${H}`} role="img" aria-label={`Personas fuera de vacaciones por semana en ${year}`}>
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={WK_LABEL_W} x2={svgW} y1={yOf(t)} y2={yOf(t)} className="wkgrid" />
                  <text x={WK_LABEL_W - 10} y={yOf(t) + 4} textAnchor="end" className="wkaxis">{t}</text>
                </g>
              ))}
              {months.map((m) => (
                <g key={m.m}>
                  {m.from > 0 ? <line x1={WK_LABEL_W + m.from * WK_W} x2={WK_LABEL_W + m.from * WK_W} y1={PT - 8} y2={H - PB} className="wkgrid wkmonth" /> : null}
                  <text x={WK_LABEL_W + (m.from + m.len / 2) * WK_W} y={H - 10} textAnchor="middle" className="wkaxis">{MESES_CORTO[m.m]}</text>
                </g>
              ))}
              <text x={WK_LABEL_W - 10} y={14} textAnchor="end" className="wkaxis">Personas</text>
              <path d={line} className="wkline" />
              {weeks.map((w, i) => (
                <g key={w.from}>
                  <circle cx={xOf(i)} cy={yOf(totals[i])} r={totals[i] > 0 ? 5 : 3.5} className={totals[i] > 0 ? 'wkdot on' : 'wkdot'}>
                    <title>{tip('Total', w, w.people, total)}</title>
                  </circle>
                  {totals[i] > 0 ? <text x={xOf(i)} y={yOf(totals[i]) - 10} textAnchor="middle" className="wkval">{totals[i]}</text> : null}
                </g>
              ))}
            </svg>

            <p className="sub" style={{ marginTop: 8 }}>
              Personas distintas con al menos un día de vacaciones esa semana (lunes a domingo; cada semana va en el mes de su jueves). Pon el ratón sobre un número o un punto para ver quiénes son. Sigue los filtros de zona, nombre y fijas/flexibles. Desliza hacia el lado para ver todo el año.
            </p>
          </>
        )}
      </div>
    </details>
  );
});

type GuardSort = 'name' | 'done' | 'upcoming' | 'total' | 'days';

const GuardSummary = memo(function GuardSummary({
  year, users, events, today,
}: {
  year: number; users: UserDoc[]; events: CalEvento[]; today: string;
}) {
  const [sort, setSort] = useState<GuardSort>('name');
  const [desc, setDesc] = useState(false);
  const counts = useMemo(() => guardCounts(events, users.map((u) => u.id), year, today), [events, users, year, today]);
  const list = useMemo(() => {
    const val = (u: UserDoc): number => {
      const c = counts.get(u.id);
      if (!c) return 0;
      return sort === 'done' ? c.done : sort === 'upcoming' ? c.upcoming : sort === 'total' ? c.done + c.upcoming : sort === 'days' ? c.days : 0;
    };
    const arr = [...users].sort((a, b) => (sort === 'name' ? 0 : val(a) - val(b)) || a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
    return desc ? arr.reverse() : arr;
  }, [users, counts, sort, desc]);
  const head = (key: GuardSort, label: string) => (
    <th scope="col" aria-sort={sort === key ? (desc ? 'descending' : 'ascending') : 'none'} className={key === 'name' ? undefined : 'r'}>
      <button type="button" className="thbtn" onClick={() => (sort === key ? setDesc(!desc) : (setSort(key), setDesc(key !== 'name')))}>
        {label}
        {sort === key ? (desc ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  );
  const sum = (f: (c: { done: number; upcoming: number; days: number }) => number): number => list.reduce((t, u) => t + f(counts.get(u.id) ?? { done: 0, upcoming: 0, days: 0 }), 0);
  return (
    <details className="caldet">
      <summary>Guardias de {year} por persona</summary>
      <div className="body">
        {list.length === 0 ? (
          <p className="sub">No hay personas con los filtros actuales.</p>
        ) : (
          <>
            <table className="caltbl guardtbl">
              <thead>
                <tr>
                  {head('name', 'Técnico')}
                  <th scope="col">Zona</th>
                  {head('done', 'Hechas')}
                  {head('upcoming', 'Programadas')}
                  {head('total', 'Total')}
                  {head('days', 'Días')}
                </tr>
              </thead>
              <tbody>
                {list.map((u) => {
                  const c = counts.get(u.id) ?? { done: 0, upcoming: 0, days: 0 };
                  return (
                    <tr key={u.id}>
                      <th scope="row">{u.name}</th>
                      <td>{u.zona || '—'}</td>
                      <td className="r">{c.done}</td>
                      <td className="r">{c.upcoming}</td>
                      <td className="r"><b>{c.done + c.upcoming}</b></td>
                      <td className="r">{c.days}</td>
                    </tr>
                  );
                })}
                <tr className="tot">
                  <th scope="row">Total</th>
                  <td />
                  <td className="r">{sum((c) => c.done)}</td>
                  <td className="r">{sum((c) => c.upcoming)}</td>
                  <td className="r"><b>{sum((c) => c.done + c.upcoming)}</b></td>
                  <td className="r">{sum((c) => c.days)}</td>
                </tr>
              </tbody>
            </table>
            <p className="sub" style={{ marginTop: 8 }}>
              «Hechas»: guardias ya terminadas. «Programadas»: en curso o futuras. «Días»: días de guardia dentro de {year}. Pulsa una cabecera para ordenar. Sigue los filtros de zona y nombre.
            </p>
          </>
        )}
      </div>
    </details>
  );
});

/* ------------------------------------------------------------------ */
/* Una fila por persona                                                */
/* ------------------------------------------------------------------ */

const PersonRow = memo(function PersonRow({
  user, year, dayW, compact, bars, used, weekend, holidays, todayIdx, preview, sel,
}: {
  user: UserDoc; year: number; dayW: number; compact: boolean; bars: CalEvento[]; used: number; weekend: Run[]; holidays: Run[]; todayIdx: number;
  preview: Preview | null; sel: [number, number] | null;
}) {
  const n = daysInYear(year);
  return (
    <div className="calrow person">
      <div className="calname" title={user.name}>
        <span className="pn">{user.name}</span>
        <span className={`calused${used > VACACIONES_ANUALES ? ' over' : ''}`} title="Días naturales de vacaciones usados este año (los festivos cuentan)">
          {used}/{VACACIONES_ANUALES}
        </span>
      </div>
      <div className="caldays" data-days="1" data-user={user.id} style={{ width: n * dayW, height: 34 }}>
        {weekend.map((r) => (
          <div key={`w${r.start}`} className="calshade we" style={{ left: r.start * dayW, width: r.len * dayW }} />
        ))}
        {holidays.map((r) => (
          <div key={`h${r.start}`} className="calshade hol" style={{ left: r.start * dayW, width: r.len * dayW }} />
        ))}
        {MESES.map((_, i) => (i === 0 ? null : <div key={i} className="calmline" style={{ left: monthStartIdx(year, i) * dayW }} />))}
        {todayIdx >= 0 ? <div className="caltodayline" style={{ left: todayIdx * dayW + dayW / 2 }} /> : null}
        {bars.map((e) => {
          const pv = preview && preview.evId === e.id ? preview : null;
          const ev = pv ? { ...e, inicio: pv.inicio, fin: pv.fin } : e;
          const c = clipToYear(ev, year);
          if (!c) return null;
          const cls = e.tipo === 'guardia' ? 'calbar guard' : e.tipo === 'baja' ? 'calbar baja' : `calbar vac ${e.estado === 'fija' ? 'fija' : 'flex'}`;
          const label = e.tipo === 'guardia' ? '' : e.tipo === 'baja' ? 'Baja' : e.estado === 'fija' ? 'Fijas' : 'Flexibles';
          return (
            <div
              key={e.id}
              className={`${cls}${pv ? ' dragging' : ''}`}
              data-ev={e.id}
              style={{ left: c[0] * dayW, width: (c[1] - c[0] + 1) * dayW }}
              title={`${evTitle(ev)}${e.nota ? ` · ${e.nota}` : ''}`}
            >
              {compact ? null : <span>{label}</span>}
              {!compact && dayIndex(ev.inicio, year) >= 0 ? <i className="calh l" data-h="l" /> : null}
              {!compact && dayIndex(ev.fin, year) < n ? <i className="calh r" data-h="r" /> : null}
            </div>
          );
        })}
        {sel ? <div className="calsel" style={{ left: sel[0] * dayW, width: (sel[1] - sel[0] + 1) * dayW }} /> : null}
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Pestaña                                                             */
/* ------------------------------------------------------------------ */

export function CalendarTab() {
  const data = useData();
  const toast = useToast();
  const todayStr = useMemo(() => todayMadrid(), []);
  const [year, setYear] = useState<number>(Number(todayStr.slice(0, 4)));
  const [dw, setDw] = useState(0); // ancho de día elegido con el zoom; 0 = el año entero ajustado a la pantalla
  const [fZonas, setFZonas] = useState<Zona[]>([]); // vacío = todas
  const [fTipo, setFTipo] = useState<'' | EventoTipo>('');
  const [fEstado, setFEstado] = useState<'' | EstadoVac>('');
  const [q, setQ] = useState('');
  const [form, setForm] = useState<FormState>(null);
  const [festivosOpen, setFestivosOpen] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [avail, setAvail] = useState(1200);

  const evQ = useQuery<CalEvento>(() => query(collection(db, COL_EVENTOS)), []);
  const feQ = useQuery<CalFestivo>(() => query(collection(db, COL_FESTIVOS)), []);
  const events = evQ.data;
  const festivos = feQ.data;

  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const rowElRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((es) => setAvail(es[0].contentRect.width));
    ro.observe(el);
    setAvail(el.clientWidth || 1200);
    return () => ro.disconnect();
  }, []);

  const n = daysInYear(year);
  const fitW = Math.max(2, (avail - NAME_W - 2) / n);
  const dayW = Math.min(MAX_W, Math.max(fitW, dw));
  const compact = dayW < COMPACT_BELOW;
  const zoomed = dayW > fitW + 0.5;
  const todayIdx = todayStr.startsWith(String(year)) ? dayIndex(todayStr, year) : -1;

  /* personas */
  const workers = data.workers;
  const rows = useMemo(() => {
    const order = (u: UserDoc): number => (u.zona ? ZONAS.indexOf(u.zona as Zona) : 99);
    const needle = q.trim().toLowerCase();
    return workers
      .filter((u) => (fZonas.length === 0 || fZonas.includes(u.zona as Zona)) && (!needle || u.name.toLowerCase().includes(needle) || u.employeeCode.toLowerCase().includes(needle)))
      .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  }, [workers, fZonas, q]);
  const withoutZona = workers.filter((u) => !u.zona).length;

  /* cálculos del año */
  const used = useMemo(() => new Map(workers.map((u) => [u.id, vacationDaysUsed(events, u.id, year)])), [events, workers, year]);

  /* festivos y sombreado */
  const hmap = useMemo(() => festivoMap(festivos), [festivos]);
  const weekend = useMemo(() => {
    const flags = Array.from({ length: n }, (_, i) => isWeekend(dateAt(i, year)));
    return runs(flags).filter((r) => r.value);
  }, [n, year]);
  const holidaysBy = useMemo(() => {
    const mk = (prov: Provincia | null): Run[] => runs(Array.from({ length: n }, (_, i) => holidaysFor(hmap, dateAt(i, year), prov).length > 0)).filter((r) => r.value);
    return { Sevilla: mk('Sevilla'), Huelva: mk('Huelva'), none: mk(null) };
  }, [hmap, n, year]);

  /* eventos visibles según los filtros de tipo y estado */
  const visibleEvents = useMemo(() => {
    const m = new Map<string, CalEvento[]>();
    for (const e of events) {
      if (fTipo && e.tipo !== fTipo) continue;
      if (fEstado && e.tipo === 'vacaciones' && e.estado !== fEstado) continue;
      if (fEstado && fTipo === 'vacaciones' && e.tipo !== 'vacaciones') continue;
      m.set(e.userId, [...(m.get(e.userId) ?? []), e]);
    }
    return m;
  }, [events, fTipo, fEstado]);

  /* ---------- arrastre ---------- */
  const latest = useRef({ events, year, dayW, n, compact });
  latest.current = { events, year, dayW, n, compact };

  const idxOf = (clientX: number, rowEl: HTMLElement): number => clamp(Math.floor((clientX - rowEl.getBoundingClientRect().left) / latest.current.dayW), 0, latest.current.n - 1);

  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    const rowEl = t.closest<HTMLElement>('[data-days]');
    if (!rowEl || !rowEl.dataset.user) return;
    const idx = idxOf(e.clientX, rowEl);
    const bar = e.shiftKey ? null : t.closest<HTMLElement>('[data-ev]'); // con Mayús se crea un evento nuevo aunque ya haya otro debajo
    let d: Drag;
    if (bar) {
      const ev = events.find((x) => x.id === bar.dataset.ev);
      if (!ev) return;
      const h = t.closest<HTMLElement>('[data-h]')?.dataset.h;
      const mode: Mode = compact ? 'click' : h === 'l' ? 'rl' : h === 'r' ? 'rr' : 'move';
      d = { mode, userId: rowEl.dataset.user, evId: ev.id, start: idx, cur: idx, orig: { inicio: ev.inicio, fin: ev.fin } };
    } else {
      d = { mode: 'select', userId: rowEl.dataset.user, start: idx, cur: idx };
    }
    rowElRef.current = rowEl;
    dragRef.current = d;
    setDrag(d);
    e.preventDefault();
  };

  const finish = useCallback(
    (cancel: boolean) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d || cancel) return;
      const { events: evs, year: y } = latest.current;
      if (d.mode === 'select') {
        const a = Math.min(d.start, d.cur);
        const b = Math.max(d.start, d.cur);
        setForm({ userId: d.userId, inicio: dateAt(a, y), fin: dateAt(b, y) });
        return;
      }
      const ev = evs.find((x) => x.id === d.evId);
      if (!ev) return;
      const pv = previewOf(d);
      if (!pv || d.start === d.cur) {
        setForm({ ev, userId: ev.userId, inicio: ev.inicio, fin: ev.fin });
        return;
      }
      updateDoc(doc(db, COL_EVENTOS, ev.id), { inicio: pv.inicio, fin: pv.fin }).catch((err: unknown) => toast(err instanceof Error ? err.message : 'No se ha podido mover'));
    },
    [toast],
  );

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent): void => {
      const d = dragRef.current;
      const rowEl = rowElRef.current;
      if (!d || !rowEl) return;
      const idx = idxOf(e.clientX, rowEl);
      if (idx === d.cur) return;
      const next = { ...d, cur: idx };
      dragRef.current = next;
      setDrag(next);
    };
    const up = (): void => finish(false);
    const cancel = (): void => finish(true);
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') finish(true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, finish]);

  const pv = drag ? previewOf(drag) : null;
  const preview: Preview | null = drag && pv && drag.evId && drag.start !== drag.cur ? { evId: drag.evId, ...pv } : null;
  const dragUser = drag?.userId;

  /* ir a un mes / al mes actual */
  const jump = (m: number): void => scrollRef.current?.scrollTo({ left: monthStartIdx(year, m) * dayW, behavior: 'smooth' });

  /* zoom con Ctrl + rueda (o pellizco en el trackpad): progresivo y centrado en el puntero */
  const curW = useRef(dayW);
  curW.current = dayW;
  const fitRef = useRef(fitW);
  fitRef.current = fitW;
  const pending = useRef<{ idx: number; offset: number } | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return; // la rueda sola sigue moviendo la página
      e.preventDefault();
      const w0 = curW.current;
      const w1 = Math.min(MAX_W, Math.max(fitRef.current, w0 * Math.exp(-e.deltaY * 0.002)));
      if (Math.abs(w1 - w0) < 0.01) return;
      const rect = el.getBoundingClientRect();
      const offset = e.clientX - rect.left; // posición del puntero dentro de la caja
      pending.current = { idx: (el.scrollLeft + offset - NAME_W) / w0, offset };
      curW.current = w1;
      setDw(w1 <= fitRef.current + 0.01 ? 0 : w1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const p = pending.current;
    if (!el || !p) return;
    pending.current = null;
    el.scrollLeft = Math.max(0, p.idx * dayW + NAME_W - p.offset);
  }, [dayW]);

  const goDetail = (): void => {
    const m = todayStr.startsWith(String(year)) ? Number(todayStr.slice(5, 7)) - 1 : 0;
    pending.current = { idx: monthStartIdx(year, m), offset: NAME_W };
    setDw(DETAIL_W);
  };

  const loading = !evQ.loaded || !feQ.loaded;
  const errors = [evQ.error, feQ.error].filter(Boolean);
  const emptyHint = rows.length === 0;

  return (
    <section className="card calwide">
      <div className="card-head">
        <div>
          <h2>Calendario</h2>
          <span className="sub">Arrastra sobre la fila de una persona para añadir un evento (con Mayús pulsada, también encima de otro). Clic en un evento para editarlo o borrarlo.</span>
        </div>
        <div className="calbtns">
          <div className="seg" role="group" aria-label="Año">
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
          <div className="seg" role="group" aria-label="Zoom">
            <button type="button" aria-pressed={!zoomed} onClick={() => setDw(0)}>
              Año completo
            </button>
            <button type="button" aria-pressed={zoomed} onClick={goDetail}>
              Detalle
            </button>
          </div>
          <button type="button" className="btn" onClick={() => setFestivosOpen(true)}>
            Festivos
          </button>
        </div>
      </div>

      {errors.length ? (
        <p className="err" role="alert">
          No se ha podido cargar el calendario: {errors.join(', ')}. ¿Has desplegado las reglas de Firestore y entras como administrador?
        </p>
      ) : null}

      <div className="calfilters">
        <div className="field" style={{ margin: 0 }}>
          <span className="lbl">Zona (puedes marcar varias)</span>
          <div className="chips" role="group" aria-label="Zona">
            <button type="button" className="chip" aria-pressed={fZonas.length === 0} onClick={() => setFZonas([])}>
              Todas
            </button>
            {ZONAS.map((z) => (
              <button
                type="button"
                key={z}
                className="chip"
                aria-pressed={fZonas.includes(z)}
                onClick={() => setFZonas(fZonas.includes(z) ? fZonas.filter((x) => x !== z) : [...fZonas, z])}
              >
                {z}
              </button>
            ))}
          </div>
        </div>
        <label>
          <span className="lbl">Tipo de evento</span>
          <select value={fTipo} onChange={(e) => setFTipo(e.target.value === 'vacaciones' || e.target.value === 'guardia' || e.target.value === 'baja' ? e.target.value : '')}>
            <option value="">Todos</option>
            <option value="vacaciones">Vacaciones</option>
            <option value="guardia">Guardia</option>
            <option value="baja">Baja</option>
          </select>
        </label>
        <label>
          <span className="lbl">Vacaciones</span>
          <select value={fEstado} onChange={(e) => setFEstado(e.target.value === 'fija' || e.target.value === 'flexible' ? e.target.value : '')}>
            <option value="">Fijas y flexibles</option>
            <option value="fija">Solo fijas</option>
            <option value="flexible">Solo flexibles</option>
          </select>
        </label>
        <label className="grow">
          <span className="lbl">Buscar por nombre</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nombre o código" />
        </label>
      </div>

      <div className="callegend" aria-label="Leyenda">
        <span className="li"><i className="calbar vac fija" /> Vacaciones fijas (sólido)</span>
        <span className="li"><i className="calbar vac flex" /> Vacaciones flexibles (rayado)</span>
        <span className="li"><i className="calbar baja" /> Baja</span>
        <span className="li"><i className="calbar guard" /> Guardia</span>
        <span className="li"><i className="calshade we" /> Fin de semana</span>
        <span className="li"><i className="calshade hol" /> Festivo</span>
      </div>

      {withoutZona > 0 ? (
        <div className="note" style={{ marginBottom: 10 }}>
          {withoutZona} {withoutZona === 1 ? 'técnico no tiene' : 'técnicos no tienen'} zona asignada: solo les afectan los festivos nacionales. Asígnala en Equipo.
        </div>
      ) : null}

      {zoomed ? (
        <div className="chips caljump" role="group" aria-label="Saltar a un mes">
          {MESES_CORTO.map((m, i) => (
            <button type="button" key={m} className="chip" onClick={() => jump(i)}>
              {m}
            </button>
          ))}
        </div>
      ) : null}

      {loading ? <div className="empty">Cargando calendario…</div> : null}
      {!loading && workers.length === 0 ? <Empty>Todavía no hay técnicos. Créalos en Equipo.</Empty> : null}

      <div className="calscroll" ref={scrollRef} style={{ display: loading || workers.length === 0 ? 'none' : undefined }}>
        <div className="calgrid" style={{ width: NAME_W + n * dayW }} onPointerDown={onDown} data-testid="calgrid">
          <Header year={year} dayW={dayW} compact={compact} hols={hmap} todayIdx={todayIdx} />
          {rows.map((u) => {
            const prov = provinciaDe(u.zona);
            const sel: [number, number] | null = drag && drag.mode === 'select' && dragUser === u.id ? [Math.min(drag.start, drag.cur), Math.max(drag.start, drag.cur)] : null;
            return (
              <PersonRow
                key={u.id}
                user={u}
                year={year}
                dayW={dayW}
                compact={compact}
                bars={visibleEvents.get(u.id) ?? EMPTY}
                used={used.get(u.id) ?? 0}
                weekend={weekend}
                holidays={prov ? holidaysBy[prov] : holidaysBy.none}
                todayIdx={todayIdx}
                preview={dragUser === u.id ? preview : null}
                sel={sel}
              />
            );
          })}
        </div>
      </div>
      {!loading && workers.length > 0 && emptyHint ? <Empty>Ninguna persona coincide con los filtros.</Empty> : null}
      <p className="sub" style={{ marginTop: 8 }}>
        Zoom: mantén <b>Ctrl</b> y usa la rueda del ratón sobre el calendario (o los botones «Año completo» / «Detalle»).
        {compact ? ' Para mover o cambiar la duración de un evento arrastrándolo, acerca más el calendario.' : ''}
      </p>

      {!loading && workers.length > 0 ? (
        <>
          <VacationYear year={year} users={rows} events={events} estado={fEstado} />
          <GuardSummary year={year} users={rows} events={events} today={todayStr} />
        </>
      ) : null}

      {form ? <EventModal key={form.ev?.id ?? `${form.userId}${form.inicio}${form.fin}`} form={form} user={workers.find((u) => u.id === form.userId)} onClose={() => setForm(null)} /> : null}
      {festivosOpen ? <FestivosModal year={year} festivos={festivos} onClose={() => setFestivosOpen(false)} /> : null}
    </section>
  );
}

const EMPTY: CalEvento[] = [];

/* ------------------------------------------------------------------ */
/* Formulario de evento                                                */
/* ------------------------------------------------------------------ */

function EventModal({ form, user, onClose }: { form: NonNullable<FormState>; user?: UserDoc; onClose: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { busy, error, setError, run } = useAction();
  const ev = form.ev;
  const [tipo, setTipo] = useState<EventoTipo>(ev?.tipo ?? 'vacaciones');
  const [estado, setEstado] = useState<'' | EstadoVac>(ev?.estado ?? '');
  const [inicio, setInicio] = useState(form.inicio);
  const [fin, setFin] = useState(form.fin);
  const [nota, setNota] = useState(ev?.nota ?? '');

  const save = (): void => {
    if (!isDate(inicio) || !isDate(fin)) return setError('Indica las dos fechas.');
    if (toDay(fin) < toDay(inicio)) return setError('La fecha final no puede ser anterior a la inicial.');
    if (tipo === 'vacaciones' && !estado) return setError('Elige si las vacaciones son fijas o flexibles.');
    const payload: Record<string, unknown> = { userId: form.userId, tipo, inicio, fin };
    if (tipo === 'vacaciones') payload.estado = estado;
    if (tipo !== 'baja' && nota.trim()) payload.nota = nota.trim().slice(0, 200);
    void run(async () => {
      if (ev) await setDoc(doc(db, COL_EVENTOS, ev.id), payload);
      else await addDoc(collection(db, COL_EVENTOS), payload);
      toast(ev ? 'Evento guardado' : 'Evento creado');
      onClose();
    });
  };

  const remove = async (): Promise<void> => {
    if (!ev) return;
    const ok = await confirm({ title: 'Borrar evento', message: `${evTitle(ev)}${user ? ` de ${user.name}` : ''}.`, confirmLabel: 'Borrar', danger: true });
    if (!ok) return;
    void run(async () => {
      await deleteDoc(doc(db, COL_EVENTOS, ev.id));
      toast('Evento borrado');
      onClose();
    });
  };

  return (
    <Modal
      title={`${ev ? 'Editar' : 'Nuevo'} evento${user ? ` · ${user.name}` : ''}`}
      onClose={onClose}
      footer={
        <>
          {ev ? (
            <button type="button" className="btn danger" onClick={() => void remove()} disabled={busy}>
              Borrar
            </button>
          ) : null}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar'}
          </button>
        </>
      }
    >
      <div className="formgrid">
        <Field label="Tipo" htmlFor="ce-tipo">
          <select id="ce-tipo" value={tipo} onChange={(e) => setTipo(e.target.value === 'guardia' ? 'guardia' : e.target.value === 'baja' ? 'baja' : 'vacaciones')}>
            <option value="vacaciones">Vacaciones</option>
            <option value="guardia">Guardia</option>
            <option value="baja">Baja</option>
          </select>
        </Field>
        {tipo === 'vacaciones' ? (
          <div className="field">
            <span className="lbl">Estado de las vacaciones</span>
            <div className="seg" role="group" aria-label="Estado de las vacaciones">
              <button type="button" aria-pressed={estado === 'fija'} onClick={() => setEstado('fija')}>
                Fijas
              </button>
              <button type="button" aria-pressed={estado === 'flexible'} onClick={() => setEstado('flexible')}>
                Flexibles
              </button>
            </div>
            <span className="sub">Fijas: las pidió sí o sí. Flexibles: se pueden mover.</span>
          </div>
        ) : null}
        <Field label="Desde" htmlFor="ce-ini">
          <input id="ce-ini" type="date" value={inicio} onChange={(e) => setInicio(e.target.value)} />
        </Field>
        <Field label="Hasta (incluido)" htmlFor="ce-fin">
          <input id="ce-fin" type="date" value={fin} onChange={(e) => setFin(e.target.value)} />
        </Field>
        {tipo === 'baja' ? (
          <p className="sub">En las bajas solo se guardan las fechas, sin motivo ni datos médicos.</p>
        ) : (
          <Field label="Nota (opcional)" htmlFor="ce-nota">
            <input id="ce-nota" value={nota} maxLength={200} onChange={(e) => setNota(e.target.value)} autoComplete="off" />
          </Field>
        )}
      </div>
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Festivos                                                            */
/* ------------------------------------------------------------------ */

function FestivosModal({ year, festivos, onClose }: { year: number; festivos: CalFestivo[]; onClose: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { busy, error, setError, run } = useAction();
  const [fecha, setFecha] = useState(`${year}-01-01`);
  const [ambito, setAmbito] = useState<'nacional' | 'provincial'>('nacional');
  const [provincia, setProvincia] = useState<Provincia>('Sevilla');
  const [nombre, setNombre] = useState('');

  const list = useMemo(() => festivos.filter((f) => f.fecha.startsWith(`${year}-`)).sort((a, b) => a.fecha.localeCompare(b.fecha) || a.nombre.localeCompare(b.nombre, 'es')), [festivos, year]);

  const add = (): void => {
    if (!isDate(fecha)) return setError('Indica la fecha.');
    if (!nombre.trim()) return setError('Escribe el nombre del festivo.');
    void run(async () => {
      await addDoc(collection(db, COL_FESTIVOS), { fecha, ambito, provincia: ambito === 'nacional' ? null : provincia, nombre: nombre.trim().slice(0, 80) });
      setNombre('');
      toast('Festivo añadido');
    });
  };

  const remove = async (f: CalFestivo): Promise<void> => {
    const ok = await confirm({ title: 'Borrar festivo', message: `${f.nombre} (${fmtShort(f.fecha, true)}).`, confirmLabel: 'Borrar', danger: true });
    if (!ok) return;
    void run(async () => {
      await deleteDoc(doc(db, COL_FESTIVOS, f.id));
      toast('Festivo borrado');
    });
  };

  return (
    <Modal
      title="Festivos"
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
      <p className="sub">Los festivos provinciales solo afectan a las personas de esa provincia (Sevilla Este y Oeste son Sevilla).</p>
      <div className="formgrid" style={{ marginTop: 10 }}>
        <Field label="Fecha" htmlFor="fe-fecha">
          <input id="fe-fecha" type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
        </Field>
        <Field label="Ámbito" htmlFor="fe-ambito">
          <select id="fe-ambito" value={ambito} onChange={(e) => setAmbito(e.target.value === 'provincial' ? 'provincial' : 'nacional')}>
            <option value="nacional">Nacional</option>
            <option value="provincial">Provincial</option>
          </select>
        </Field>
        {ambito === 'provincial' ? (
          <Field label="Provincia" htmlFor="fe-prov">
            <select id="fe-prov" value={provincia} onChange={(e) => setProvincia(e.target.value === 'Huelva' ? 'Huelva' : 'Sevilla')}>
              <option value="Sevilla">Sevilla</option>
              <option value="Huelva">Huelva</option>
            </select>
          </Field>
        ) : null}
        <Field label="Nombre" htmlFor="fe-nombre">
          <input id="fe-nombre" value={nombre} maxLength={80} onChange={(e) => setNombre(e.target.value)} autoComplete="off" />
        </Field>
        <div>
          <button type="button" className="btn primary" onClick={add} disabled={busy}>
            Añadir festivo
          </button>
        </div>
      </div>
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}

      <div style={{ marginTop: 16 }}>
        {list.length === 0 ? (
          <Empty>No hay festivos en {year}.</Empty>
        ) : (
          list.map((f) => (
            <div className="crow" key={f.id}>
              <div className="pn">
                <div className="pname">{f.nombre}</div>
                <div className="pcode">{fmtShort(f.fecha, true)}</div>
              </div>
              <Pill tone={f.ambito === 'nacional' ? 'info' : 'warn'}>{f.ambito === 'nacional' ? 'Nacional' : f.provincia}</Pill>
              <button type="button" className="btn sm danger" onClick={() => void remove(f)} disabled={busy}>
                Borrar
              </button>
            </div>
          ))
        )}
      </div>

    </Modal>
  );
}
