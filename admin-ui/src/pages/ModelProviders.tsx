import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Radio } from 'lucide-react';
import { api } from '../api/client';
import type { ModelProvider } from '../types';
import { t } from '../i18n';
import { errText } from '../errors';
import { PageHeader, TableShell, Th, Td, Row, Badge, IconBtn, Btn, Modal, Field, TextInput, Alert } from '../components/ui';

export default function ModelProviders() {
  const [items, setItems] = useState<ModelProvider[]>([]);
  const [edit, setEdit] = useState<ModelProvider | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => { load(); }, []);
  function load() { api.getModelProviders().then(setItems).catch(() => {}); }

  return (
    <div>
      <PageHeader
        title={t.models.title}
        hint={`${items.length}`}
        right={<Btn variant="primary" onClick={() => { setEdit(null); setShowForm(true); }}><Plus size={15} /> {t.models.add}</Btn>}
      />
      {showForm && <ProviderForm item={edit} onClose={() => setShowForm(false)} onSaved={load} />}
      <TableShell
        colSpan={5}
        empty={items.length === 0 ? { text: t.models.noProviders } : null}
        head={<><Th>{t.models.name}</Th><Th>{t.models.baseUrl}</Th><Th>{t.models.models}</Th><Th>{t.common.status}</Th><Th right>{t.common.actions}</Th></>}
      >
        {items.map(item => (
          <Row key={item.id}>
            <Td>
              <span className="font-medium font-mono text-[13px] text-slate-800 dark:text-slate-100">{item.name}</span>
              {item.is_default && <span className="ml-2"><Badge tone="green">{t.models.defaultBadge}</Badge></span>}
            </Td>
            <Td><span className="font-mono text-xs text-slate-600 dark:text-slate-300 max-w-[280px] truncate block" title={item.base_url}>{item.base_url}</span></Td>
            <Td><span className="font-mono text-[11px] text-slate-500 max-w-[260px] truncate block" title={item.models.join(', ')}>{item.models.join(', ') || '—'}</span></Td>
            <Td>
              <Badge tone={item.enabled ? 'green' : 'neutral'}>
                {item.enabled ? t.common.enabled : t.common.disabled}
              </Badge>
            </Td>
            <Td className="text-right whitespace-nowrap">
              <IconBtn title={t.common.edit} onClick={() => { setEdit(item); setShowForm(true); }}><Pencil size={15} /></IconBtn>
              <IconBtn title={t.common.delete} onClick={() => { if (confirm(t.models.deleteConfirm)) api.deleteModelProvider(item.id).then(load); }} className="hover:!text-red-600"><Trash2 size={15} /></IconBtn>
            </Td>
          </Row>
        ))}
      </TableShell>
    </div>
  );
}

function ProviderForm({ item, onClose, onSaved }: { item?: ModelProvider | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: item?.name || '',
    base_url: item?.base_url || '',
    api_key: '',
    models: (item?.models || []).join(', '),
    enabled: item?.enabled ?? true,
    is_default: item?.is_default ?? false,
  });
  const [probing, setProbing] = useState(false);
  const [probeMsg, setProbeMsg] = useState('');
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const payload = {
      name: form.name.trim(),
      base_url: form.base_url.trim(),
      ...(form.api_key ? { api_key: form.api_key } : {}),
      models: form.models.split(',').map(s => s.trim()).filter(Boolean),
      enabled: form.enabled,
      is_default: form.is_default,
    };
    try {
      if (item) await api.updateModelProvider(item.id, payload);
      else await api.createModelProvider(payload);
      onSaved();
      onClose();
    } catch (err) {
      setError(errText(err, 'Ошибка сохранения'));
    }
  }

  async function handleProbe() {
    if (!item) return;
    setProbing(true);
    setProbeMsg('');
    try {
      const r = await api.probeModelProvider(item.id);
      if (r.ok) {
        setProbeMsg(t.models.probeOk(r.models.length));
        if (r.models.length) setForm(f => ({ ...f, models: r.models.join(', ') }));
      } else {
        setProbeMsg(t.models.probeFail(r.error || 'HTTP error'));
      }
    } catch (err) {
      setProbeMsg(t.models.probeFail(errText(err, 'неизвестная ошибка')));
    } finally {
      setProbing(false);
    }
  }

  const set = (k: 'name' | 'base_url' | 'api_key' | 'models') => (v: string) => setForm(f => ({ ...f, [k]: v }));

  return (
    <Modal title={item ? t.models.editTitle : t.models.newTitle} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t.models.name}><TextInput value={form.name} onChange={e => set('name')(e.target.value)} required mono /></Field>
          <Field label={t.models.baseUrl}><TextInput value={form.base_url} onChange={e => set('base_url')(e.target.value)} required mono placeholder="http://localhost:8080/v1" /></Field>
        </div>
        <Field label={item?.api_key_set ? t.models.apiKeyKeep : t.models.apiKey}>
          <TextInput type="password" value={form.api_key} onChange={e => set('api_key')(e.target.value)}
            placeholder={item?.api_key_set ? '••••••••' : ''} autoComplete="new-password" />
        </Field>
        <Field label={t.models.models}>
          <div className="flex gap-2">
            <TextInput value={form.models} onChange={e => set('models')(e.target.value)} mono
              placeholder="qwen3-8b, qwen3-27b" className="flex-1" />
            {item && (
              <Btn variant="outline" type="button" onClick={handleProbe} disabled={probing} title={t.models.probeHint}>
                <Radio size={14} /> {probing ? '…' : t.models.probe}
              </Btn>
            )}
          </div>
        </Field>
        {probeMsg && <p className="text-xs text-slate-500">{probeMsg}</p>}
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-[13px] text-slate-700 dark:text-slate-300 cursor-pointer">
            <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} className="rounded accent-blue-600" />
            {t.models.enabled}
          </label>
          <label className="flex items-center gap-2 text-[13px] text-slate-700 dark:text-slate-300 cursor-pointer">
            <input type="checkbox" checked={form.is_default} onChange={e => setForm(f => ({ ...f, is_default: e.target.checked }))} className="rounded accent-blue-600" />
            {t.models.isDefault}
          </label>
        </div>
        {error && <Alert tone="red">{error}</Alert>}
        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="ghost" type="button" onClick={onClose}>{t.common.cancel}</Btn>
          <Btn variant="primary" type="submit">{item ? t.common.save : t.common.create}</Btn>
        </div>
      </form>
    </Modal>
  );
}
