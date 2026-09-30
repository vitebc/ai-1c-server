import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import type { ModelProvider } from '../types';
import { t } from '../i18n';
import { errText } from '../errors';
import { PageHeader, TableShell, Th, Td, Row, Badge, IconBtn, Btn, Modal, Field, TextInput, Alert, Confirm } from '../components/ui';

export default function ModelProviders() {
  const [items, setItems] = useState<ModelProvider[]>([]);
  const [edit, setEdit] = useState<ModelProvider | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [del, setDel] = useState<ModelProvider | null>(null);

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
      {del && (
        <Confirm title={t.models.deleteConfirm} message={`Провайдер «${del.name}» будет удалён.`} danger confirmLabel={t.common.deleteConfirmLabel}
          onClose={() => setDel(null)}
          onConfirm={() => { api.deleteModelProvider(del.id).then(load); setDel(null); }} />
      )}
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
              <IconBtn title={t.common.delete} onClick={() => setDel(item)} className="hover:!text-red-600"><Trash2 size={15} /></IconBtn>
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
    enabled: item?.enabled ?? true,
    is_default: item?.is_default ?? false,
  });
  const [selModels, setSelModels] = useState<string[]>(item?.models || []);
  const [fetched, setFetched] = useState<string[]>(item?.models || []);
  const [custom, setCustom] = useState('');
  const [probing, setProbing] = useState(false);
  const [probeMsg, setProbeMsg] = useState('');
  const [error, setError] = useState('');

  // Live probe: fetch the model list shortly after the address/key stops changing.
  useEffect(() => {
    const url = form.base_url.trim();
    if (!/^https?:\/\//.test(url)) {
      setProbeMsg('');
      return;
    }
    setProbing(true);
    const h = setTimeout(async () => {
      try {
        const r = (item && !form.api_key)
          ? await api.probeModelProvider(item.id)
          : await api.probeModelProviderUrl({ base_url: url, api_key: form.api_key || undefined });
        if (r.ok) {
          setFetched(r.models);
          setProbeMsg(t.models.probeOk(r.models.length));
        } else {
          setProbeMsg(t.models.probeFail(r.error || 'HTTP error'));
        }
      } catch (err) {
        setProbeMsg(t.models.probeFail(errText(err, 'неизвестная ошибка')));
      } finally {
        setProbing(false);
      }
    }, 800);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.base_url, form.api_key]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const payload = {
      name: form.name.trim(),
      base_url: form.base_url.trim(),
      ...(form.api_key ? { api_key: form.api_key } : {}),
      models: selModels,
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

  const toggleModel = (m: string) =>
    setSelModels(selModels.includes(m) ? selModels.filter(x => x !== m) : [...selModels, m]);

  function addCustom() {
    const v = custom.trim();
    if (v && !selModels.includes(v)) setSelModels([...selModels, v]);
    setCustom('');
  }

  // Fetched list union selected (custom values survive even if absent upstream).
  const options = [...fetched];
  for (const m of selModels) if (!options.includes(m)) options.push(m);

  const set = (k: 'name' | 'base_url' | 'api_key') => (v: string) => setForm(f => ({ ...f, [k]: v }));

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
        <Field label={`${t.models.models} (${selModels.length})`}>
          {probing && <p className="text-[11px] text-slate-400 mb-1">{t.models.probing}</p>}
          {options.length > 0 ? (
            <div className="border border-slate-300 dark:border-slate-700 rounded-lg p-2 max-h-40 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-1 bg-slate-50 dark:bg-slate-950">
              {options.map(m => (
                <label key={m} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 px-1 py-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer" title={fetched.includes(m) ? t.models.fromServer : t.models.customValue}>
                  <input type="checkbox" checked={selModels.includes(m)} onChange={() => toggleModel(m)} className="rounded accent-blue-600" />
                  <span className="font-mono truncate">{m}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-400">{probing ? t.models.probing : t.models.noModelsYet}</p>
          )}
          <div className="flex gap-2 mt-2">
            <TextInput value={custom} onChange={e => setCustom(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }}
              placeholder={t.models.customModel} mono className="flex-1" />
            <Btn variant="outline" type="button" onClick={addCustom}>{t.common.add}</Btn>
          </div>
        </Field>
        {probeMsg && !probing && <p className="text-xs text-slate-500">{probeMsg}</p>}
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
