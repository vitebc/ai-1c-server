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

// ─── Search-мапа v2 (сервер → базы; '*' — прочие; '!база' — блок) ───

type SearchMapServer = { name: string; bases: string[] };
type SearchMapsState = {
  source: string;
  format: 'v1' | 'v2';
  servers: SearchMapServer[];
  wildcard: string[] | null;
  blocks: string[];
  warnings?: string[];
};

const BASE_RE = /^[a-z0-9_-]+$/;

function SearchMapsSection({ onChanged }: { onChanged: () => void }) {
  const [maps, setMaps] = useState<SearchMapsState | null>(null);
  const [baseNames, setBaseNames] = useState<string[]>([]);
  const [serverOptions, setServerOptions] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [editWild, setEditWild] = useState<string[] | null>(null);
  const [editRow, setEditRow] = useState<{ name: string; bases: string[] } | null>(null);
  const [newName, setNewName] = useState('');
  const [newBases, setNewBases] = useState<string[]>([]);
  const [blockAdd, setBlockAdd] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [delKey, setDelKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMaps(await api.getSearchMaps());
    } catch (e) {
      setErr(errText(e, 'Ошибка загрузки мапы'));
    }
    try {
      const r = await api.getAgentBases();
      setBaseNames((r.bases || []).map(b => b.name.toLowerCase()));
    } catch { /* без списка баз — только упомянутые в мапе */ }
    try {
      const all = await api.getMcpServers();
      setServerOptions(all.filter(s => s.name.startsWith('search-')).map(s => s.name).sort());
    } catch { /* пустой список опций — покажем подсказку */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const servers = maps?.servers ?? [];
  const blocks = maps?.blocks ?? [];
  const wildcard = maps?.wildcard ?? null;

  // Пул баз для чипов: bases.conf ∪ всё, что уже упомянуто в мапе.
  const basePool = Array.from(new Set([...baseNames, ...servers.flatMap(s => s.bases)])).sort();

  const toggleIn = (list: string[], x: string) =>
    list.includes(x) ? list.filter(y => y !== x) : [...list, x];

  function BaseChips({ selected, onChange }: { selected: string[]; onChange: (bases: string[]) => void }) {
    const [addVal, setAddVal] = useState('');
    const all = [...new Set([...basePool, ...selected])].sort((a, b) => {
      const ka = selected.includes(a) ? 0 : 1;
      const kb = selected.includes(b) ? 0 : 1;
      return ka - kb || a.localeCompare(b);
    });
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t.studio.searchMapBases}>
          {all.map(b => {
            const on = selected.includes(b);
            return (
              <button
                key={b}
                type="button"
                aria-pressed={on}
                title={b}
                onClick={() => onChange(toggleIn(selected, b))}
                className={on
                  ? 'rounded-full px-2.5 py-1 text-xs font-medium border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-900'
                  : 'rounded-full px-2.5 py-1 text-xs font-medium border border-slate-300 text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800'}
              >
                {b}
              </button>
            );
          })}
        </div>
        <div className="flex gap-1.5">
          <TextInput
            value={addVal}
            onChange={e => setAddVal(e.target.value)}
            placeholder={t.studio.searchMapBasePlaceholder}
            mono
            className="w-[220px] text-xs"
          />
          <Btn
            variant="outline"
            onClick={() => {
              const b = addVal.trim().toLowerCase();
              if (!b) return;
              if (!BASE_RE.test(b)) { setErr(`Некорректное имя базы: ${b}`); return; }
              if (!selected.includes(b)) onChange([...selected, b]);
              setAddVal('');
            }}
          >
            <Plus size={14} /> {t.common.add}
          </Btn>
        </div>
      </div>
    );
  }

  // Точный ответ на вопрос «что видит база X» (поиск по базе).
  const q = query.trim().toLowerCase();
  const seen = q
    ? blocks.includes(q)
      ? { tone: 'red' as const, text: t.studio.searchMapSeesBlocked }
      : servers.some(s => s.bases.includes(q))
        ? { tone: 'green' as const, text: t.studio.searchMapSeesHits(servers.filter(s => s.bases.includes(q)).length) }
        : wildcard
          ? wildcard.length
            ? { tone: 'blue' as const, text: t.studio.searchMapSeesWildcard(wildcard.length) }
            : { tone: 'red' as const, text: t.studio.searchMapSeesWildcardBlock }
          : { tone: 'neutral' as const, text: t.studio.searchMapSeesOpen }
    : null;

  const showRow = (key: string, bases: string[]) =>
    !q || key.includes(q) || bases.some(b => b.includes(q));

  async function doSaveKey(key: string, bases: string[]) {
    try {
      await api.putSearchMapKey(key, bases);
      setEditWild(null);
      setEditRow(null);
      setNewName('');
      setNewBases([]);
      setMsg(t.studio.searchMapSaved);
      await load();
      onChanged();
    } catch (e) {
      setErr(errText(e, 'Ошибка сохранения'));
    }
  }

  async function doConvert() {
    try {
      const r = await api.convertSearchMaps();
      setMsg(r.already ? 'Файл уже в v2.' : t.studio.searchMapConverted);
      await load();
      onChanged();
    } catch (e) {
      setErr(errText(e, 'Ошибка конвертации'));
    }
  }

  async function doDeleteKey(key: string) {
    try {
      await api.deleteSearchMap(key);
      setDelKey(null);
      setMsg(t.studio.searchMapDeleted);
      await load();
      onChanged();
    } catch (e) {
      setErr(errText(e, 'Ошибка'));
    }
  }

  async function doAddBlock() {
    const b = blockAdd.trim().toLowerCase();
    if (!b) return;
    if (!BASE_RE.test(b)) { setErr(`Некорректное имя базы: ${b}`); return; }
    await doSaveKey(`!${b}`, []);
    setBlockAdd('');
  }

  // Покрытие: базы bases.conf, не упомянутые в строках серверов (и не в блок-строках).
  const inRows = new Set([...servers.flatMap(s => s.bases), ...blocks]);
  const uncovered = baseNames.filter(b => !inRows.has(b));

  return (
    <div>
      <p className="text-xs text-slate-500 mb-3">{t.studio.searchMapsHint}</p>
      {maps?.source === 'absent' && (
        <div className="mb-3"><Alert tone="amber">{t.studio.searchMapsAbsent}</Alert></div>
      )}
      {maps?.format === 'v1' && (
        <div className="mb-3">
          <Alert tone="amber">{t.studio.searchMapsV1}</Alert>
          <div className="mt-2 flex flex-col sm:flex-row sm:items-center gap-2">
            <Btn variant="outline" onClick={doConvert}>{t.studio.searchMapConvert}</Btn>
            <span className="text-xs text-slate-500">{t.studio.searchMapConvertHint}</span>
          </div>
        </div>
      )}
      {(maps?.warnings || []).map((w, i) => (
        <div key={i} className="mb-3"><Alert tone="amber">{w}</Alert></div>
      ))}
      {msg && <div className="mb-3"><Alert tone="blue">{msg}</Alert></div>}
      {err && <div className="mb-3"><Alert tone="red">{err}</Alert></div>}

      <div className="mb-3 flex flex-col sm:flex-row sm:items-center gap-2">
        <TextInput
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t.studio.searchMapSearchPlaceholder}
          mono
          className="sm:max-w-[300px]"
        />
        {seen && (
          <span className="text-xs text-slate-600 dark:text-slate-300">
            {t.studio.searchMapSeesPrefix(q)}{' '}
            <Badge tone={seen.tone === 'neutral' ? 'blue' : seen.tone}>{seen.text}</Badge>
          </span>
        )}
      </div>

      <TableShell
        colSpan={4}
        empty={servers.length === 0 && wildcard === null && editWild === null
          ? { text: 'Записей нет — все базы без фильтрации' }
          : null}
        head={<>
          <Th>{t.studio.searchMapServer}</Th>
          <Th>{t.studio.searchMapBases}</Th>
          <Th>Статус</Th>
          <Th right>{t.common.actions}</Th>
        </>}
      >
        {(wildcard !== null || editWild !== null) && showRow('*', wildcard || editWild!) && (
          <Row key="*">
            {editWild !== null ? (
              <>
                <Td><span className="font-mono text-xs font-medium text-slate-800 dark:text-slate-100">{t.studio.searchMapWildcardLabel}</span></Td>
                <Td><BaseChips selected={editWild} onChange={setEditWild} /></Td>
                <Td><Badge tone="blue">редактирование</Badge></Td>
                <Td className="text-right whitespace-nowrap">
                  <IconBtn title="Сохранить" onClick={() => doSaveKey('*', editWild)}><Check size={15} /></IconBtn>
                  <IconBtn title="Отмена" onClick={() => setEditWild(null)}><X size={15} /></IconBtn>
                </Td>
              </>
            ) : (
              <>
                <Td>
                  <span className="font-mono text-xs font-medium text-slate-800 dark:text-slate-100">*</span>
                  <span className="ml-2 text-[11px] text-slate-500">{t.studio.searchMapWildcardLabel.slice(3)}</span>
                </Td>
                <Td>
                  <span className="font-mono text-[11px] text-slate-500 break-all">
                    {wildcard!.length ? wildcard!.join(', ') : '—'}
                  </span>
                </Td>
                <Td>
                  {wildcard!.length
                    ? <Badge tone="green">{t.studio.searchMapWildcardServers(wildcard!.length)}</Badge>
                    : <Badge tone="red">{t.studio.searchMapWildcardBlock}</Badge>}
                </Td>
                <Td className="text-right whitespace-nowrap">
                  <IconBtn title="Редактировать базы прочих" onClick={() => setEditWild([...wildcard!])}><Pencil size={14} /></IconBtn>
                  <IconBtn title="Удалить строку *" onClick={() => setDelKey('*')} className="hover:!text-red-600"><Trash2 size={14} /></IconBtn>
                </Td>
              </>
            )}
          </Row>
        )}
        {servers.filter(s => showRow(s.name, s.bases)).map(s =>
          editRow && editRow.name === s.name ? (
            <Row key={s.name}>
              <Td>
                <span className="font-mono text-xs font-medium text-slate-800 dark:text-slate-100">{s.name}</span>
                {!serverOptions.includes(s.name) && (
                  <span className="ml-1 opacity-70 text-[11px]">{t.studio.searchMapNotInRegistry}</span>
                )}
              </Td>
              <Td><BaseChips selected={editRow.bases} onChange={bases => setEditRow({ ...editRow, bases })} /></Td>
              <Td><Badge tone="blue">редактирование</Badge></Td>
              <Td className="text-right whitespace-nowrap">
                <IconBtn title="Сохранить" onClick={() => doSaveKey(editRow.name, editRow.bases)}><Check size={15} /></IconBtn>
                <IconBtn title="Отмена" onClick={() => setEditRow(null)}><X size={15} /></IconBtn>
              </Td>
            </Row>
          ) : (
            <Row key={s.name}>
              <Td>
                <span className="font-mono text-xs font-medium text-slate-800 dark:text-slate-100">{s.name}</span>
                {!serverOptions.includes(s.name) && (
                  <span className="ml-1 opacity-70 text-[11px]">{t.studio.searchMapNotInRegistry}</span>
                )}
              </Td>
              <Td>
                <span className="font-mono text-[11px] text-slate-500 break-all">
                  {s.bases.length ? s.bases.join(', ') : '—'}
                </span>
              </Td>
              <Td>
                {s.bases.length
                  ? <Badge tone="green">{t.studio.searchMapRowCount(s.bases.length)}</Badge>
                  : <Badge tone="amber">{t.studio.searchMapEmptyRow}</Badge>}
              </Td>
              <Td className="text-right whitespace-nowrap">
                <IconBtn title="Редактировать базы" onClick={() => setEditRow({ name: s.name, bases: [...s.bases] })}>
                  <Pencil size={14} />
                </IconBtn>
                <IconBtn title="Удалить строку сервера" onClick={() => setDelKey(s.name)} className="hover:!text-red-600">
                  <Trash2 size={14} />
                </IconBtn>
              </Td>
            </Row>
          )
        )}
      </TableShell>

      {wildcard === null && editWild === null && (
        <div className="mt-2">
          <Btn variant="outline" onClick={() => setEditWild([...basePool.filter(b => !blocks.includes(b))])}>
            <Plus size={14} /> {t.studio.searchMapWildcardAdd}
          </Btn>
        </div>
      )}

      {uncovered.length > 0 && (
        <div className="mt-4 border-t border-slate-200 dark:border-slate-800 pt-3">
          <p className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">{t.studio.searchMapCoverage}</p>
          <div className="flex flex-wrap gap-1.5 items-center">
            {uncovered.map(b => (
              <Badge key={b} tone={wildcard ? 'blue' : 'amber'}>
                <span className="font-mono">{b}</span>
                <span className="ml-1 opacity-80">{wildcard ? t.studio.searchMapUncoveredWildcard : t.studio.searchMapUncoveredOpen}</span>
              </Badge>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 border-t border-slate-200 dark:border-slate-800 pt-3">
        <p className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">{t.studio.searchMapBlocks}</p>
        <p className="text-xs text-slate-500 mb-2">{t.studio.searchMapBlockAddHint}</p>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {blocks.map(b => (
              <span
                key={b}
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium border border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
              >
                <span className="font-mono">{b}</span>
                <button
                  type="button"
                  aria-label={t.studio.searchMapBlockRemove}
                  title={t.studio.searchMapBlockRemove}
                  onClick={() => setDelKey(`!${b}`)}
                  className="opacity-70 hover:opacity-100 cursor-pointer"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            {blocks.length === 0 && <span className="text-xs text-slate-400">—</span>}
          </div>
          <div className="flex gap-1.5">
            <TextInput
              value={blockAdd}
              onChange={e => setBlockAdd(e.target.value)}
              placeholder={t.studio.searchMapBasePlaceholder}
              mono
              className="w-[220px] text-xs"
            />
            <Btn variant="danger-outline" onClick={doAddBlock}><Plus size={14} /> {t.common.add}</Btn>
          </div>
        </div>
      </div>

      <div className="mt-4 border-t border-slate-200 dark:border-slate-800 pt-3">
        <p className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">{t.studio.addSearchMap}</p>
        <p className="text-xs text-slate-500 mb-2">{t.studio.searchMapAddHint}</p>
        {serverOptions.length === 0 ? (
          <span className="text-xs text-slate-500">{t.studio.searchMapRegistryEmpty}</span>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-col sm:flex-row gap-2">
              <select
                value={newName}
                onChange={e => setNewName(e.target.value)}
                aria-label={t.studio.searchMapServer}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-[13px] text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 sm:max-w-[260px] font-mono"
              >
                <option value="" disabled>— {t.studio.searchMapServer} —</option>
                {serverOptions.map(s => (
                  <option key={s} value={s}>
                    {servers.some(r => r.name === s) ? `${s} ⟳` : s}
                  </option>
                ))}
              </select>
              <Btn variant="primary" disabled={!newName} onClick={() => doSaveKey(newName, newBases)}>
                <Plus size={14} /> {t.common.add}
              </Btn>
            </div>
            <BaseChips selected={newBases} onChange={setNewBases} />
          </div>
        )}
      </div>

      {delKey && (
        <Confirm
          title={delKey.startsWith('!') ? t.studio.searchMapBlockDeleteConfirm(delKey.slice(1)) : t.studio.searchMapDeleteConfirm(delKey)}
          confirmLabel="Удалить"
          danger
          onClose={() => setDelKey(null)}
          onConfirm={() => doDeleteKey(delKey)}
        />
      )}
    </div>
  );
}
