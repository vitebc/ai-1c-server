import { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Database, Power, Check, X } from 'lucide-react';
import { api } from '../api/client';
import { t } from '../i18n';
import { errText } from '../errors';
import { PageHeader, Btn, IconBtn, Badge, TableShell, Th, Td, Row, TextInput, Alert, Segmented, Confirm } from '../components/ui';

export default function Bases1c() {
  const [sub, setSub] = useState<'bases' | 'searchmaps'>('bases');

  return (
    <div>
      <PageHeader
        title={t.nav.bases1c}
        hint={t.studio.basesHint}
        right={
          <Segmented
            value={sub}
            onChange={setSub}
            options={[
              { key: 'bases', label: t.studio.basesTab },
              { key: 'searchmaps', label: t.studio.searchMapsTab },
            ]}
          />
        }
      />
      {sub === 'bases' && <BasesSection onChanged={() => {}} />}
      {sub === 'searchmaps' && <SearchMapsSection onChanged={() => {}} />}
    </div>
  );
}

// ─── Базы 1С (backend/bases.conf, hot-reload) ───

function BasesSection({ onChanged }: { onChanged: () => void }) {
  const [bases, setBases] = useState<{ name: string; url: string }[]>([]);
  const [source, setSource] = useState<'bases.conf' | 'env'>('bases.conf');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [delBase, setDelBase] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ name: string; url: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.getAgentBases();
      setBases(r.bases || []);
      setSource(r.source === 'env' ? 'env' : 'bases.conf');
    } catch (e) {
      setErr(errText(e, 'Ошибка загрузки'));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function doAdd() {
    setMsg(''); setErr('');
    const name = newName.trim().toLowerCase();
    const url = newUrl.trim();
    if (!name || !url) { setErr('Заполните имя и URL'); return; }
    try {
      await api.putAgentBase(name, url);
      setNewName(''); setNewUrl('');
      setMsg(`База ${name} сохранена — бэкенд подхватит в течение 2 с.`);
      await load();
      onChanged();
    } catch (e) {
      setErr(errText(e, 'Ошибка сохранения'));
    }
  }

  async function doSaveEdit() {
    if (!editing) return;
    setMsg(''); setErr('');
    const name = editing.name.trim().toLowerCase();
    const url = editing.url.trim();
    if (!name || !url) { setErr('Заполните имя и URL'); return; }
    try {
      await api.putAgentBase(name, url);
      setEditing(null);
      setMsg(`База ${name} сохранена — бэкенд подхватит в течение 2 с.`);
      await load();
      onChanged();
    } catch (e) {
      setErr(errText(e, 'Ошибка сохранения'));
    }
  }

  async function doDelete(name: string) {
    setMsg(''); setErr('');
    try {
      await api.deleteAgentBase(name);
      setDelBase(null);
      setMsg(`База ${name} выключена — бэкенд подхватит в течение 2 с.`);
      await load();
      onChanged();
    } catch (e) {
      setErr(errText(e, 'Ошибка'));
    }
  }

  const editable = source === 'bases.conf';

  return (
    <div>
      {source === 'env' && (
        <div className="mb-3"><Alert tone="amber">{t.studio.baseSourceEnv}</Alert></div>
      )}
      {msg && <div className="mb-3"><Alert tone="blue">{msg}</Alert></div>}
      {err && <div className="mb-3"><Alert tone="red">{err}</Alert></div>}

      <TableShell
        colSpan={4}
        empty={bases.length === 0 ? { text: 'Баз нет' } : null}
        head={<><Th>{t.studio.baseName}</Th><Th>{t.studio.baseUrl}</Th><Th>Статус</Th><Th right>{t.common.actions}</Th></>}
      >
        {bases.map(b => (
          editing && editing.name === b.name ? (
            <Row key={b.name}>
              <Td><TextInput value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} mono className="text-xs" /></Td>
              <Td><TextInput value={editing.url} onChange={e => setEditing({ ...editing, url: e.target.value })} mono className="text-[11px]" /></Td>
              <Td><Badge tone="blue">редактирование</Badge></Td>
              <Td className="text-right whitespace-nowrap">
                <IconBtn title="Сохранить" onClick={doSaveEdit}><Check size={15} /></IconBtn>
                <IconBtn title="Отмена" onClick={() => setEditing(null)}><X size={15} /></IconBtn>
              </Td>
            </Row>
          ) : (
            <Row key={b.name}>
              <Td><span className="font-mono text-xs font-medium text-slate-800 dark:text-slate-100">{b.name}</span></Td>
              <Td><span className="font-mono text-[11px] text-slate-500 break-all">{b.url}</span></Td>
              <Td><Badge tone="green"><Database size={11} className="mr-1 inline" />{t.studio.baseEnabled}</Badge></Td>
              <Td className="text-right whitespace-nowrap">
                {editable && (
                  <>
                    <IconBtn title="Редактировать" onClick={() => setEditing({ name: b.name, url: b.url })}>
                      <Pencil size={14} />
                    </IconBtn>
                    <IconBtn title="Выключить базу" onClick={() => setDelBase(b.name)} className="hover:!text-red-600">
                      <Power size={15} />
                    </IconBtn>
                  </>
                )}
              </Td>
            </Row>
          )
        ))}
      </TableShell>

      {editable && (
        <div className="mt-4 border-t border-slate-200 dark:border-slate-800 pt-3">
          <p className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-2">{t.studio.addBase}</p>
          <div className="flex flex-col sm:flex-row gap-2">
            <TextInput value={newName} onChange={e => setNewName(e.target.value)} placeholder="имя (НРег)" mono className="sm:max-w-[200px]" />
            <TextInput value={newUrl} onChange={e => setNewUrl(e.target.value)} placeholder="http://host/base" mono className="flex-1" />
            <Btn variant="primary" onClick={doAdd}><Plus size={14} /> {t.common.add}</Btn>
          </div>
        </div>
      )}

      {delBase && (
        <Confirm title={t.studio.baseDeleteConfirm(delBase)} confirmLabel="Выключить" danger
          onClose={() => setDelBase(null)}
          onConfirm={() => doDelete(delBase)} />
      )}
    </div>
  );
}

// ─── Search-мапа (база → разрешённые search-серверы) ───

type SearchMapEntry = { name: string; servers: string[] };

function SearchMapsSection({ onChanged }: { onChanged: () => void }) {
  const [maps, setMaps] = useState<SearchMapEntry[]>([]);
  const [source, setSource] = useState<string>('file');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [baseNames, setBaseNames] = useState<string[]>([]);
  const [serverOptions, setServerOptions] = useState<string[]>([]);
  const [editing, setEditing] = useState<{ name: string; servers: string[] } | null>(null);
  const [newName, setNewName] = useState('');
  const [newServers, setNewServers] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [delBase, setDelBase] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.getSearchMaps();
      setMaps(r.bases || []);
      setSource(r.source || 'file');
      setWarnings(r.warnings || []);
    } catch (e) {
      setErr(errText(e, 'Ошибка загрузки мапы'));
    }
    try {
      const r = await api.getAgentBases();
      setBaseNames((r.bases || []).map(b => b.name.toLowerCase()));
    } catch { /* без списка баз таблица строится по мапе */ }
    try {
      const all = await api.getMcpServers();
      setServerOptions(all.filter(s => s.name.startsWith('search-')).map(s => s.name).sort());
    } catch { /* пустой список опций — покажем подсказку */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleServer = (list: string[], s: string) =>
    list.includes(s) ? list.filter(x => x !== s) : [...list, s];

  function ServerChips({ selected, onToggle }: { selected: string[]; onToggle: (s: string) => void }) {
    const all = [...new Set([...serverOptions, ...selected])].sort((a, b) => {
      const ka = selected.includes(a) ? 0 : 1;
      const kb = selected.includes(b) ? 0 : 1;
      return ka - kb || a.localeCompare(b);
    });
    if (all.length === 0) {
      return <span className="text-xs text-slate-500">{t.studio.searchMapRegistryEmpty}</span>;
    }
    return (
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t.studio.searchMapServers}>
        {all.map(s => {
          const on = selected.includes(s);
          const missing = !serverOptions.includes(s);
          return (
            <button
              key={s}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(s)}
              className={on
                ? 'rounded-full px-2.5 py-1 text-xs font-medium border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-900'
                : 'rounded-full px-2.5 py-1 text-xs font-medium border border-slate-300 text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800'}
            >
              {s}
              {missing && <span className="ml-1 opacity-70">{t.studio.searchMapNotInRegistry}</span>}
            </button>
          );
        })}
      </div>
    );
  }

  // Объединение имён: запись мапы может быть для базы, которой больше нет в bases.conf.
  const names = Array.from(new Set([...maps.map(m => m.name), ...baseNames])).sort();
  const mapFor = (n: string) => maps.find(m => m.name === n) || null;

  function statusBadge(entry: SearchMapEntry | null) {
    if (!entry) {
      return <Badge tone="neutral">{t.studio.searchMapUnfiltered}</Badge>;
    }
    if (entry.servers.length === 0) {
      return <Badge tone="red">{t.studio.searchMapBlocked}</Badge>;
    }
    return <Badge tone="green">{t.studio.searchMapAllowed(entry.servers.length)}</Badge>;
  }

  async function doSave(entry: { name: string; servers: string[] }) {
    try {
      await api.putSearchMapBase(entry.name, entry.servers);
      setEditing(null);
      setMsg(t.studio.searchMapSaved);
      await load();
      onChanged();
    } catch (e) {
      setErr(errText(e, 'Ошибка сохранения'));
    }
  }

  async function doAdd() {
    const name = newName.trim().toLowerCase();
    if (!name) { setErr('Укажите имя базы'); return; }
    try {
      await api.putSearchMapBase(name, newServers);
      setNewName(''); setNewServers([]);
      setMsg(t.studio.searchMapSaved);
      await load();
      onChanged();
    } catch (e) {
      setErr(errText(e, 'Ошибка сохранения'));
    }
  }

  async function doDelete(name: string) {
    try {
      await api.deleteSearchMap(name);
      setDelBase(null);
      setMsg(t.studio.searchMapDeleted);
      await load();
      onChanged();
    } catch (e) {
      setErr(errText(e, 'Ошибка'));
    }
  }

  return (
    <div>
      <p className="text-xs text-slate-500 mb-3">{t.studio.searchMapsHint}</p>
      {source === 'absent' && (
        <div className="mb-3"><Alert tone="amber">{t.studio.searchMapsAbsent}</Alert></div>
      )}
      {warnings.map((w, i) => (
        <div key={i} className="mb-3"><Alert tone="amber">{w}</Alert></div>
      ))}
      {msg && <div className="mb-3"><Alert tone="blue">{msg}</Alert></div>}
      {err && <div className="mb-3"><Alert tone="red">{err}</Alert></div>}

      <TableShell
        colSpan={4}
        empty={names.length === 0 ? { text: 'Записей нет — все базы без фильтрации' } : null}
        head={<>
          <Th>{t.studio.baseName}</Th>
          <Th>{t.studio.searchMapServers}</Th>
          <Th>Статус</Th>
          <Th right>{t.common.actions}</Th>
        </>}
      >
        {names.map(n => {
          const entry = mapFor(n);
          return editing && editing.name === n ? (
            <Row key={n}>
              <Td><span className="font-mono text-xs font-medium text-slate-800 dark:text-slate-100">{n}</span></Td>
              <Td><ServerChips
                selected={editing.servers}
                onToggle={s => setEditing(e => e && { ...e, servers: toggleServer(e.servers, s) })}
              /></Td>
              <Td><Badge tone="blue">редактирование</Badge></Td>
              <Td className="text-right whitespace-nowrap">
                <IconBtn title="Сохранить" onClick={() => doSave(editing)}><Check size={15} /></IconBtn>
                <IconBtn title="Отмена" onClick={() => setEditing(null)}><X size={15} /></IconBtn>
              </Td>
            </Row>
          ) : (
            <Row key={n}>
              <Td><span className="font-mono text-xs font-medium text-slate-800 dark:text-slate-100">{n}</span></Td>
              <Td>
                {entry ? (
                  <span className="font-mono text-[11px] text-slate-500 break-all">
                    {entry.servers.length ? entry.servers.join(', ') : '— (блок)'}
                  </span>
                ) : <span className="text-[11px] text-slate-400">—</span>}
              </Td>
              <Td>{statusBadge(entry)}</Td>
              <Td className="text-right whitespace-nowrap">
                <IconBtn
                  title={entry ? 'Редактировать серверы' : 'Добавить в мапу'}
                  onClick={() => setEditing({ name: n, servers: entry ? [...entry.servers] : [] })}
                >
                  <Pencil size={14} />
                </IconBtn>
                {entry && (
                  <IconBtn title="Удалить из мапу (вернётся «без фильтрации»)" onClick={() => setDelBase(n)} className="hover:!text-red-600">
                    <Trash2 size={14} />
                  </IconBtn>
                )}
              </Td>
            </Row>
          );
        })}
      </TableShell>

      <div className="mt-4 border-t border-slate-200 dark:border-slate-800 pt-3">
        <p className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">{t.studio.addSearchMap}</p>
        <p className="text-xs text-slate-500 mb-2">{t.studio.searchMapAddHint}</p>
        <div className="flex flex-col gap-2">
          <div className="flex flex-col sm:flex-row gap-2">
            <TextInput
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="имя базы (НРег)"
              mono
              className="sm:max-w-[200px]"
            />
            <Btn variant="primary" onClick={doAdd}><Plus size={14} /> {t.common.add}</Btn>
          </div>
          <ServerChips
            selected={newServers}
            onToggle={s => setNewServers(l => toggleServer(l, s))}
          />
        </div>
      </div>

      {delBase && (
        <Confirm title={t.studio.searchMapDeleteConfirm(delBase)} confirmLabel="Удалить" danger
          onClose={() => setDelBase(null)}
          onConfirm={() => doDelete(delBase)} />
      )}
    </div>
  );
}
