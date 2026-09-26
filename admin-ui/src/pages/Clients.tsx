import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Client } from '../types';
import { t } from '../i18n';
import { PageHeader, TableShell, Th, Td, Row } from '../components/ui';

export default function Clients() {
  const [items, setItems] = useState<Client[]>([]);

  useEffect(() => { api.getClients().then(setItems).catch(() => {}); }, []);

  return (
    <div>
      <PageHeader title={t.clients.title} hint={`${items.length}`} />
      <TableShell
        colSpan={4}
        empty={items.length === 0 ? { text: t.clients.noClients } : null}
        head={<><Th>{t.clients.id}</Th><Th>{t.clients.name}</Th><Th>{t.clients.version}</Th><Th>{t.clients.lastSeen}</Th></>}
      >
        {items.map(item => (
          <Row key={item.id}>
            <Td><span className="font-mono text-xs text-slate-500 dark:text-slate-400">{item.id}</span></Td>
            <Td><span className="font-medium text-slate-800 dark:text-slate-100">{item.name || '—'}</span></Td>
            <Td><span className="text-slate-600 dark:text-slate-300">{item.version || '—'}</span></Td>
            <Td><span className="text-xs text-slate-500">{item.last_seen || '—'}</span></Td>
          </Row>
        ))}
      </TableShell>
    </div>
  );
}
