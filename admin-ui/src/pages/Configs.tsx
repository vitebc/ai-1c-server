import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, FolderOpen } from 'lucide-react';
import { api } from '../api/client';
import FileBrowser from '../components/FileBrowser';
import type { ConfigProfile } from '../types';
import { t } from '../i18n';
import {
  PageHeader, Card, CardBody, CardTitle, Btn, IconBtn, Badge,
  TableShell, Th, Td, Row, Field, TextInput, Select, Modal, Alert,
} from '../components/ui';

export default function Configs() {
  const [items, setItems] = useState<ConfigProfile[]>([]);
  const [edit, setEdit] = useState<ConfigProfile | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => { load(); }, []);
  function load() { api.getConfigProfiles().then(setItems).catch(() => {}); }

  const mains = items.filter(i => !i.parent_id);
  const parentName = (id: string | null) => mains.find(m => m.id === id)?.name || '?';

  return (
    <div>
      <PageHeader
        title={t.configs.title}
        hint={`${items.length}`}
        right={<Btn variant="primary" onClick={() => { setEdit(null); setShowForm(true); }}><Plus size={15} /> {t.configs.add}</Btn>}
      />
      {showForm && <ConfigForm item={edit} mains={mains} onClose={() => setShowForm(false)} onSaved={load} />}
      <SearchSettings />
      <TableShell
        colSpan={6}
        empty={items.length === 0 ? { text: t.configs.noProfiles } : null}
        head={<><Th>{t.configs.name}</Th><Th>{t.configs.path}</Th><Th>{t.configs.parent}</Th><Th>{t.configs.active}</Th><Th>{t.configs.lastIndexed}</Th><Th right>{t.common.actions}</Th></>}
      >
        {items.map(item => (
          <Row key={item.id}>
            <Td>
              <span className="font-medium text-slate-800 dark:text-slate-100">
                {item.parent_id && <span className="text-slate-400 mr-1">↳</span>}{item.name}
              </span>
              {item.parent_id && <Badge tone="blue"><span className="ml-0.5">extension</span></Badge>}
            </Td>
            <Td><span className="font-mono text-xs text-slate-600 dark:text-slate-300">{item.path}</span></Td>
            <Td><span className="text-xs text-slate-600 dark:text-slate-300">{item.parent_id ? parentName(item.parent_id) : '—'}</span></Td>
            <Td>
              <Badge tone={item.active ? 'green' : 'red'}>
                {item.active ? t.common.active : t.common.inactive}
              </Badge>
            </Td>
            <Td><span className="text-xs text-slate-500 dark:text-slate-400">{item.last_indexed || '-'}</span></Td>
            <Td className="text-right whitespace-nowrap">
              <IconBtn title={t.common.edit} onClick={() => { setEdit(item); setShowForm(true); }}><Pencil size={15} /></IconBtn>
              <IconBtn title={t.common.delete} onClick={() => { if (confirm(t.configs.deleteConfirm)) api.deleteConfigProfile(item.id).then(load); }} className="hover:!text-red-600"><Trash2 size={15} /></IconBtn>
            </Td>
          </Row>
        ))}
      </TableShell>
      <p className="text-xs text-slate-500 dark:text-slate-400 mt-3">
        Каждый основной профиль получает авто-строку <span className="font-mono">search-&lt;имя&gt;</span> MCP
        (окружение пересоздаётся из профилей при каждом изменении). Расширения привязываются к основному профилю.
        Активен = строка включена = индексируется.
      </p>
    </div>
  );
}

function ConfigForm({ item, mains, onClose, onSaved }: { item?: ConfigProfile | null; mains: ConfigProfile[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(item?.name || '');
  const [path, setPath] = useState(item?.path || '');
  const [active, setActive] = useState(item?.active ?? false);
  const [parentId, setParentId] = useState<string>(item?.parent_id || '');
  const [browse, setBrowse] = useState(false);
  const [error, setError] = useState('');

  // Основная с расширениями не может стать расширением (сервер тоже проверяет).
  const candidates = mains.filter(m => !item || m.id !== item.id);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const payload: Record<string, unknown> = { name, path, active };
    if (parentId) payload.parent_id = parentId;
    else if (item?.parent_id) payload.parent_id = null; // открепить → основная
    try {
      if (item) await api.updateConfigProfile(item.id, payload as never);
      else await api.createConfigProfile(payload as never);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
    }
  }

  return (
    <Modal title={item ? t.configs.editTitle : t.configs.newTitle} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <Field label={t.configs.name}>
          <TextInput value={name} onChange={e => setName(e.target.value)} required />
        </Field>
        <Field label={t.configs.path}>
          <div className="flex gap-2">
            <TextInput value={path} onChange={e => setPath(e.target.value)} required mono
              placeholder="/data/1c-src/erp" className="flex-1" />
            <Btn variant="outline" type="button" onClick={() => setBrowse(true)} className="shrink-0">
              <FolderOpen size={15} /> {t.mcp.browse}
            </Btn>
          </div>
        </Field>
        <Field label={t.configs.parentLabel}>
          <Select value={parentId} onChange={e => setParentId(e.target.value)}>
            <option value="">{t.configs.mainConfig}</option>
            {candidates.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-[13px] text-slate-700 dark:text-slate-300 cursor-pointer">
          <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} className="rounded accent-blue-600" />
          {t.configs.active}
        </label>
        {error && <Alert tone="red">{error}</Alert>}
        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="ghost" type="button" onClick={onClose}>{t.common.cancel}</Btn>
          <Btn variant="primary" type="submit">{item ? t.common.save : t.common.create}</Btn>
        </div>
      </form>
      {browse && (
        <FileBrowser
          dirsOnly
          title="Выберите папку конфигурации"
          initialPath={path || undefined}
          onPick={p => { setPath(p); setBrowse(false); }}
          onClose={() => setBrowse(false)}
        />
      )}
    </Modal>
  );
}

function SearchSettings() {
  const [binary, setBinary] = useState('');
  const [indexDir, setIndexDir] = useState('');
  const [saved, setSaved] = useState(false);
  const [canEdit, setCanEdit] = useState(true);
  const [browse, setBrowse] = useState<'binary' | 'index' | null>(null);

  useEffect(() => {
    api.getMe().then(me => setCanEdit(me.sections.includes('settings'))).catch(() => {});
    api.getSettings().then(list => {
      setBinary(list.find(s => s.key === 'search_binary')?.value || '');
      setIndexDir(list.find(s => s.key === 'search_index_dir')?.value || '');
    }).catch(() => {});
  }, []);

  async function save() {
    if (binary.trim()) await api.putSetting('search_binary', binary.trim());
    if (indexDir.trim()) await api.putSetting('search_index_dir', indexDir.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <Card className="mb-4">
      <CardBody>
        <CardTitle>{t.configs.searchTemplate}</CardTitle>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
          {t.configs.searchHint}
          {!canEdit && ' (только чтение)'}
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="flex gap-2">
            <TextInput value={binary} onChange={e => setBinary(e.target.value)} disabled={!canEdit}
              placeholder="/path/to/mcp-1c-search" mono className="flex-1" />
            <Btn variant="outline" onClick={() => setBrowse('binary')} disabled={!canEdit} className="shrink-0">
              <FolderOpen size={15} /> {t.mcp.browse}
            </Btn>
          </div>
          <div className="flex gap-2">
            <TextInput value={indexDir} onChange={e => setIndexDir(e.target.value)} disabled={!canEdit}
              placeholder={t.configs.indexDirPh} mono className="flex-1" />
            <Btn variant="outline" onClick={() => setBrowse('index')} disabled={!canEdit} className="shrink-0">
              <FolderOpen size={15} /> {t.mcp.browse}
            </Btn>
            <Btn variant="primary" onClick={save} disabled={!canEdit} className="shrink-0">
              {saved ? 'Сохранено ✓' : t.common.save}
            </Btn>
          </div>
        </div>
        {browse && (
          <FileBrowser
            dirsOnly={browse === 'index'}
            title={browse === 'index' ? 'Select index folder' : 'Select search binary'}
            initialPath={(browse === 'index' ? indexDir : binary) || undefined}
            onPick={p => { if (browse === 'index') setIndexDir(p); else setBinary(p); setBrowse(null); }}
            onClose={() => setBrowse(null)}
          />
        )}
      </CardBody>
    </Card>
  );
}
