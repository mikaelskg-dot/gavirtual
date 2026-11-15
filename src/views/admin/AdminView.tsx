import { useState } from 'react';
import { useData } from '../../data/DataContext';
import { isReq, pendQty } from '../../lib/ledger';
import type { UserDoc } from '../../types';
import { Pill } from '../../ui';
import { CatalogTab } from './CatalogTab';
import { CalendarTab } from './CalendarTab';
import { ConfigTab } from './ConfigTab';
import { DeliveriesTab } from './DeliveriesTab';
import { FleetTab } from './FleetTab';
import { HistoryTab } from './HistoryTab';
import { SpendTab } from './SpendTab';
import { StockTab } from './StockTab';
import { TeamTab } from './TeamTab';

const TABS = [
  { id: 'stock', label: 'Stock' },
  { id: 'history', label: 'Traspasos e historial' },
  { id: 'spend', label: 'Consumo y gastos' },
  { id: 'catalog', label: 'Catálogo' },
  { id: 'team', label: 'Equipo' },
  { id: 'config', label: 'Configuración' },
  { id: 'deliveries', label: 'Gestión de entregas' },
  { id: 'fleet', label: 'Flota' },
] as const;

/** Pestañas exclusivas del administrador. */
const ADMIN_TABS = [{ id: 'calendar', label: 'Calendario' }] as const;

type TabId = (typeof TABS)[number]['id'] | (typeof ADMIN_TABS)[number]['id'];

/** Panel del almacén. */
export function AdminView({ me }: { me: UserDoc }) {
  const data = useData();
  const [tab, setTab] = useState<TabId>('stock');
  const tabs: readonly { id: TabId; label: string }[] = me.role === 'admin' ? [...TABS, ...ADMIN_TABS] : TABS;
  const pending = data.txs.filter((t) => isReq(t) && t.deliveryStatus === 'pending' && pendQty(t) > 0).length;

  return (
    <main>
      <nav className="tabs" role="tablist" aria-label="Secciones de almacén">
        {tabs.map((t) => (
          <button type="button" key={t.id} className="tab" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'deliveries' && pending ? <Pill tone="warn">{pending}</Pill> : null}
          </button>
        ))}
      </nav>
      {tab === 'stock' ? <StockTab /> : null}
      {tab === 'history' ? <HistoryTab /> : null}
      {tab === 'spend' ? <SpendTab /> : null}
      {tab === 'catalog' ? <CatalogTab /> : null}
      {tab === 'team' ? <TeamTab me={me} /> : null}
      {tab === 'config' ? <ConfigTab /> : null}
      {tab === 'deliveries' ? <DeliveriesTab /> : null}
      {tab === 'fleet' ? <FleetTab /> : null}
      {tab === 'calendar' && me.role === 'admin' ? <CalendarTab /> : null}
    </main>
  );
}
