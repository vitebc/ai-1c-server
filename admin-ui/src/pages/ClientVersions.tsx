import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import type { ClientVersion } from '../types';
import { t } from '../i18n';
import { PageHeader, TableShell, Th, Td, Row, Badge, IconBtn, Btn, Modal, Field, TextInput, TextArea, Alert } from '../components/ui';

export default function ClientVersions() {
  const [items, setItems] = useState<ClientVersion[]>([]);
  const [edit, setEdit] = useState<ClientVersion | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => { load(); }, []);
  function load() { api.getClientVersions().then(setItems).catch(() => {}); }

  return (
    <div>
      <PageHeader
        title={t.versions.title}
        hint={`${items.length}`}
        right={<Btn variant="primary" onClick={() => { setEdit(null); setShowForm(true); }}><Plus size={15} /> {t.versions.add}</Btn>}
      />
      {showForm && <VersionForm item={edit} onClose={() => setShowForm(false)} onSaved={load} />}
      <TableShell
        colSpan={5}
        empty={items.length === 0 ? { text: t.versions.noVersions } : null}
        head={<><Th>{t.versions.version}</Th><Th>{t.versions.platform}</Th><Th>{t.common.status}</Th><Th>{t.versions.created}</Th><Th right>{t.common.actions}</Th></>}
      >
        {items.map(item => (
          <Row key={item.id}>
            <Td><span className="font-medium font-mono text-[13px] text-slate-800 dark:text-slate-100">{item.version}</span></Td>
            <Td><span className="text-slate-600 dark:text-slate-300">{item.platform}</span></Td>
            <Td>
              <Badge tone={item.required ? 'red' : 'neutral'}>
                {item.required ? t.versions.requiredBadge : t.versions.optionalBadge}
              </Badge>
            </Td>
            <Td><span className="text-xs text-slate-500">{item.created_at}</span></Td>
            <Td className="text-right whitespace-nowrap">
              <IconBtn title={t.common.edit} onClick={() => { setEdit(item); setShowForm(true); }}><Pencil size={15} /></IconBtn>
              <IconBtn title={t.common.delete} onClick={() => { if (confirm(t.versions.deleteConfirm)) api.deleteClientVersion(item.id).then(load); }} className="hover:!text-red-600"><Trash2 size={15} /></IconBtn>
            </Td>
          </Row>
        ))}
      </TableShell>
    </div>
  );
}

function VersionForm({ item, onClose, onSaved }: { item?: ClientVersion | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    version: item?.version || '',
    platform: item?.platform || 'windows',
    url: item?.url || '',
    checksum: item?.checksum || '',
    changelog: item?.changelog || '',
    required: item?.required ?? false,
  });
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      if (item) await api.updateClientVersion(item.id, { ...form, changelog: form.changelog || null });
      else await api.createClientVersion(form as any);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
    }
  }

  const set = (k: keyof typeof form) => (v: string) => setForm(f => ({ ...f, [k]: v }));

  return (
    <Modal title={item ? t.versions.editTitle : t.versions.newTitle} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t.versions.version}><TextInput value={form.version} onChange={e => set('version')(e.target.value)} required mono /></Field>
          <Field label={t.versions.platform}><TextInput value={form.platform} onChange={e => set('platform')(e.target.value)} required /></Field>
        </div>
        <Field label={t.versions.url}><TextInput value={form.url} onChange={e => set('url')(e.target.value)} required mono /></Field>
        <Field label={t.versions.checksum}><TextInput value={form.checksum} onChange={e => set('checksum')(e.target.value)} required mono /></Field>
        <Field label={t.versions.changelog}><TextArea value={form.changelog} onChange={e => set('changelog')(e.target.value)} rows={3} /></Field>
        <label className="flex items-center gap-2 text-[13px] text-slate-700 dark:text-slate-300 cursor-pointer">
          <input type="checkbox" checked={form.required} onChange={e => setForm(f => ({ ...f, required: e.target.checked }))} className="rounded accent-indigo-600" />
          {t.versions.required}
        </label>
        {error && <Alert tone="red">{error}</Alert>}
        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="ghost" type="button" onClick={onClose}>{t.common.cancel}</Btn>
          <Btn variant="primary" type="submit">{item ? t.common.save : t.common.create}</Btn>
        </div>
      </form>
    </Modal>
  );
}
