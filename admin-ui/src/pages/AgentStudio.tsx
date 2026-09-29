import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, Play, Pause, Square, RotateCcw, RefreshCw, Server, AlertTriangle, FolderOpen } from 'lucide-react';
import { api } from '../api/client';
import FileBrowser from '../components/FileBrowser';
import type { AgentItem, SkillFileItem, PatternItem, AgentOverview, AgentBackendStatus, EnvEntry, Me, McpServer } from '../types';
import { t } from '../i18n';
import { errText } from '../errors';
import { PageHeader, Card, CardBody, Btn, IconBtn, Badge, TableShell, Th, Td, Row, Field, TextInput, TextArea, Select, Modal as UiModal, Alert, Segmented } from '../components/ui';

type Tab = 'agents' | 'skills' | 'patterns' | 'backend' | 'env';

const TAB_SECTION: Record<Tab, string> = {
  agents: 'agent-agents',
  skills: 'agent-skills',
  patterns: 'agent-patterns',
  backend: 'agent-backend',
  env: 'env',
};

export default function AgentStudio({ me }: { me: Me | null }) {
  const [tab, setTab] = useState<Tab>('agents');
  const [ov, setOv] = useState<AgentOverview | null>(null);
  const [tools, setTools] = useState<{ name: string; description: string }[]>([]);
  const [toolsMode, setToolsMode] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [browseRoot, setBrowseRoot] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const [o, live] = await Promise.all([api.getAgentOverview(), api.getLiveTools().catch(() => null)]);
      setOv(o);
      if (live?.reachable && live.data) {
        setTools(live.data.tools.map(x => ({ name: x.name, description: x.description || '' })));
        setToolsMode(live.data.mode);
      } else {
        const list = await api.getAgentTools();
        setTools(list.map(name => ({ name, description: '' })));
        setToolsMode(null);
      }
    } catch (e) {
      setError(errText(e, 'Ошибка загрузки'));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function pickRoot(path: string) {
    if (!confirm(t.studio.rootConfirm(path))) return;
    setBrowseRoot(false);
    try {
      await api.putSetting('agent_project_root', path);
      await load();
    } catch (e) {
      setError(errText(e, 'Не удалось сменить корень'));
    }
  }
  const allTabs: { key: Tab; label: string }[] = [
    { key: 'agents', label: t.studio.agents },
    { key: 'skills', label: t.studio.agentSkills },
    { key: 'patterns', label: t.studio.patterns },
    { key: 'backend', label: t.studio.backend },
    { key: 'env', label: t.studio.env },
  ];
  const tabs = allTabs.filter(x => !me || me.sections.includes(TAB_SECTION[x.key]));

  useEffect(() => {
    if (me && !me.sections.includes(TAB_SECTION[tab])) {
      const first = (['agents', 'skills', 'patterns', 'backend', 'env'] as Tab[])
        .find(x => me.sections.includes(TAB_SECTION[x]));
      if (first) setTab(first);
    }
  }, [me, tab]);

  return (
    <div>
      <PageHeader
        title={t.studio.title}
        hint={ov ? `${ov.root}${!ov.root_exists ? ` ${t.studio.rootMissing}` : ''}` : undefined}
        right={<>
          <Btn variant="outline" onClick={() => setBrowseRoot(true)}><FolderOpen size={15} /> {t.studio.rootChange}</Btn>
          <Btn variant="outline" onClick={load}><RefreshCw size={15} /> {t.common.reload}</Btn>
        </>}
      />

      {error && <div className="mb-3"><Alert tone="red">{error}</Alert></div>}

      <div className="mb-4">
        <Segmented value={tab} onChange={setTab} options={tabs} />
      </div>

      {tab === 'agents' && ov && <AgentsTab ov={ov} tools={tools} toolsMode={toolsMode} skills={ov.skills.map(s => ({ name: s.name, description: s.description }))} onChanged={load} />}
      {tab === 'skills' && ov && <SkillsTab ov={ov} tools={tools} toolsMode={toolsMode} onChanged={load} />}
      {tab === 'patterns' && ov && <PatternsTab ov={ov} onChanged={load} />}
      {tab === 'backend' && <BackendTab />}
      {tab === 'env' && <EnvTab />}
      {browseRoot && (
        <FileBrowser
          dirsOnly
          title="Выберите корень агентского проекта (содержит backend/ + docker-compose.yml)"
          initialPath={ov?.root || undefined}
          onPick={pickRoot}
          onClose={() => setBrowseRoot(false)}
        />
      )}
    </div>
  );
}

// ─── shared bits ───

function Err({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <span className="ml-1.5 inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-red-50 text-red-600 border border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-900" title={text}>
      <AlertTriangle size={12} /> битый
    </span>
  );
}

function toolServer(toolName: string): string | null {
  const i = toolName.indexOf('__');
  return i > 0 ? toolName.slice(0, i) : null;
}

function toolPrefix(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9_.-]/g, '_') || 'server';
  return s.slice(0, 32);
}

function ToolsCheck({ all, selected, onChange, mode, mcpFilter, cols = 2, fill = false }: {
  all: { name: string; description: string }[]; selected: string[]; onChange: (v: string[]) => void; mode: string | null;
  mcpFilter?: string[] | null;
  cols?: 1 | 2;
  fill?: boolean;
}) {
  const toggle = (x: string) =>
    onChange(selected.includes(x) ? selected.filter(v => v !== x) : [...selected, x]);
  const [q, setQ] = useState('');
  const extra = selected.filter(s => !all.some(x => x.name === s)).map(name => ({ name, description: '(нет в live-реестре)' }));
  const list = [...all, ...extra];
  const visible = (name: string) => {
    if (!mcpFilter) return true;
    const srv = toolServer(name);
    if (srv === null) return true;
    return mcpFilter.some(s => s === srv || toolPrefix(s) === srv);
  };
  const query = q.trim().toLowerCase();
  const shown = list.filter(x => visible(x.name)
    && (!query || x.name.toLowerCase().includes(query) || (x.description || '').toLowerCase().includes(query)));
  const hiddenSelected = selected.filter(s => !shown.some(x => x.name === s));
  // Group by server tag for per-server "select all".
  const groups = new Map<string | null, typeof shown>();
  for (const x of shown) {
    const srv = toolServer(x.name);
    const arr = groups.get(srv);
    if (arr) arr.push(x);
    else groups.set(srv, [x]);
  }
  const ordered = [...groups.entries()].sort((a, b) =>
    ((a[0] === null) ? 0 : 1) - ((b[0] === null) ? 0 : 1)
    || (a[0] || '').localeCompare(b[0] || ''));
  const toggleGroup = (items: typeof shown) => {
    const names = items.map(x => x.name);
    const allOn = names.every(n => selected.includes(n));
    onChange(allOn ? selected.filter(n => !names.includes(n)) : [...selected, ...names.filter(n => !selected.includes(n))]);
  };
  return (
    <div className={fill ? 'flex flex-col h-full min-h-0' : ''}>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-[13px] font-medium text-slate-700 dark:text-slate-300">{t.studio.toolsLabel}</label>
        <Badge tone={mode ? 'green' : 'neutral'}>{mode ? `${t.studio.live} · ${mode} · ${all.length}` : `${t.studio.offline} · ${all.length}`}</Badge>
      </div>
      {mcpFilter && (
        <p className="text-[11px] text-slate-500 mb-1">
          Фильтр по MCP: {mcpFilter.length ? mcpFilter.join(', ') : 'default'}
          {hiddenSelected.length > 0 && (
            <span className="text-amber-600 dark:text-amber-400"> · выбрано скрытых: {hiddenSelected.length} (сохранятся)</span>
          )}
        </p>
      )}
      <input value={q} onChange={e => setQ(e.target.value)} placeholder={`${t.common.search} — имя или описание`}
        className="w-full mb-1 px-2 py-1 text-xs border border-slate-300 rounded-lg bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" />
      <div className={`border border-slate-300 dark:border-slate-700 rounded-lg p-2 overflow-y-auto bg-slate-50 dark:bg-slate-950 ${fill ? 'flex-1 min-h-0' : 'max-h-80'}`}>
        {ordered.map(([srv, items]) => {
          const names = items.map(x => x.name);
          const allOn = names.length > 0 && names.every(n => selected.includes(n));
          const someOn = !allOn && names.some(n => selected.includes(n));
          return (
            <div key={srv || 'builtin'} className="mb-1">
              <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300 px-1 py-1 rounded hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer">
                <input type="checkbox" checked={allOn} ref={el => { if (el) el.indeterminate = someOn; }} onChange={() => toggleGroup(items)} className="rounded accent-blue-600" />
                <span className="font-mono">{srv || t.studio.builtIn}</span>
                <span className="text-[10px] text-slate-400 font-normal">
                  {names.filter(n => selected.includes(n)).length}/{names.length}
                </span>
              </label>
              <div className={`grid grid-cols-1 gap-1 ${cols === 2 ? 'sm:grid-cols-2' : ''}`}>
                {items.map(x => (
                  <label key={x.name} title={x.description} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 px-1 py-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer">
                    <input type="checkbox" checked={selected.includes(x.name)} onChange={() => toggle(x.name)} className="rounded accent-blue-600" />
                    <span className="font-mono truncate">{srv ? x.name.slice(srv.length + 2) : x.name}</span>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
        {shown.length === 0 && <span className="text-xs text-slate-400">{query ? 'Ничего не найдено' : 'Нет инструментов для выбранных MCP-серверов'}</span>}
      </div>
    </div>
  );
}

function BodyField({ value, onChange, rows }: { value: string; onChange: (v: string) => void; rows?: number }) {
  return (
    <Field label="Тело (markdown, после второго ---)">
      <TextArea value={value} onChange={e => onChange(e.target.value)} rows={rows || 10} spellCheck={false} mono />
    </Field>
  );
}

function TextField({ label, value, onChange, mono, placeholder }: { label: string; value: string; onChange: (v: string) => void; mono?: boolean; placeholder?: string }) {
  return (
    <Field label={label}>
      <TextInput value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} mono={mono} />
    </Field>
  );
}

function McpSelect({ selected, onChange }: { selected: string[]; onChange: (v: string[]) => void }) {
  // Names come from the lightweight options endpoint (any agent file-area
  // section); full rows (transports) only when mcp-servers is allowed.
  const [names, setNames] = useState<{ name: string; running: boolean }[] | null>(null);
  const [transports, setTransports] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [opts, full] = await Promise.all([
          api.getAgentMcpOptions(),
          api.getMcpServers().catch((): McpServer[] | null => null),
        ]);
        if (!alive) return;
        setNames(opts.servers);
        if (full) {
          const m: Record<string, string> = {};
          full.forEach(s => { m[s.name] = s.transport; });
          setTransports(m);
        }
      } catch {
        if (alive) setNames(null);
      }
    })();
    return () => { alive = false; };
  }, []);

  const toggle = (name: string) =>
    onChange(selected.includes(name) ? selected.filter(x => x !== name) : [...selected, name]);

  if (names === null) {
    return <TextField label="MCP-серверы (через запятую, пусто = default)" value={selected.join(', ')}
      onChange={v => onChange(v.split(',').map(s => s.trim()).filter(Boolean))} mono />;
  }
  const sorted = [...names].sort((a, b) =>
    ((b.running) ? 1 : 0) - ((a.running) ? 1 : 0)
    || a.name.localeCompare(b.name));
  const extra = selected.filter(s => s !== 'default' && !sorted.some(r => r.name === s));
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-[13px] font-medium text-slate-700 dark:text-slate-300">{t.studio.mcpServers}</label>
        <Badge tone="neutral">{selected.length || 'default'}</Badge>
      </div>
      <div className="border border-slate-300 dark:border-slate-700 rounded-lg p-2 max-h-40 overflow-y-auto grid grid-cols-1 gap-1 bg-slate-50 dark:bg-slate-950">
        <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 px-1 py-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer" title="Default бэкенда">
          <input type="checkbox" checked={selected.includes('default')} onChange={() => toggle('default')} className="rounded accent-blue-600" />
          <span className="font-mono">default</span>
        </label>
        {sorted.map(s => (
          <label key={s.name} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 px-1 py-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer" title={`${s.name}${transports[s.name] ? ` (${transports[s.name]})` : ''}`}>
            <input type="checkbox" checked={selected.includes(s.name)} onChange={() => toggle(s.name)} className="rounded accent-blue-600 shrink-0" />
            <span className="font-mono break-all">{s.name}</span>
            {s.running && <span className="text-[10px] text-emerald-500 shrink-0">●</span>}
          </label>
        ))}
        {extra.map(name => (
          <label key={name} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 px-1 py-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer" title="Сохранённое значение, такой строки нет">
            <input type="checkbox" checked={selected.includes(name)} onChange={() => toggle(name)} className="rounded accent-blue-600 shrink-0" />
            <span className="font-mono break-all">{name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function FormModal({ title, onClose, onSubmit, error, children, wide, xwide, fill }: {
  title: string; onClose: () => void; onSubmit: (e: React.FormEvent) => void; error: string; children: React.ReactNode; wide?: boolean; xwide?: boolean; fill?: boolean;
}) {
  return (
    <UiModal title={title} onClose={onClose} wide={wide} xwide={xwide} fill={fill}>
      <form onSubmit={onSubmit} className={`space-y-3 ${fill ? 'flex-1 min-h-0 flex flex-col' : ''}`}>
        {children}
        {error && <Alert tone="red">{error}</Alert>}
        <div className={`flex justify-end gap-2 pt-1 ${fill ? 'shrink-0' : ''}`}>
          <Btn variant="ghost" type="button" onClick={onClose}>{t.common.cancel}</Btn>
          <Btn variant="primary" type="submit">{t.common.save}</Btn>
        </div>
      </form>
    </UiModal>
  );
}

// ─── Agents tab ───

function AgentsTab({ ov, tools, toolsMode, skills, onChanged }: { ov: AgentOverview; tools: { name: string; description: string }[]; toolsMode: string | null; skills: { name: string; description: string }[]; onChanged: () => void }) {
  const [edit, setEdit] = useState<AgentItem | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [formError, setFormError] = useState('');

  async function remove(a: AgentItem) {
    if (!confirm(`Удалить агента «${a.name}»? Папка backend/agents/${a.name}/ будет удалена.`)) return;
    if (!confirm(`Подтвердите: точно удалить агента «${a.name}»?`)) return;
    await api.deleteAgent(a.name);
    onChanged();
  }

  return (
    <div>
      <div className="flex justify-end mb-3">
        <Btn variant="primary" onClick={() => { setEdit(null); setFormError(''); setShowNew(true); }}>
          <Plus size={15} /> {t.studio.newAgent}
        </Btn>
      </div>
      {(showNew || edit) && (
        <AgentForm
          item={edit}
          tools={tools}
          toolsMode={toolsMode}
          skills={skills}
          error={formError}
          onClose={() => { setShowNew(false); setEdit(null); }}
          onSaved={onChanged}
          onError={setFormError}
        />
      )}
      <TableShell
        colSpan={5}
        empty={ov.agents.length === 0 ? { text: t.studio.noAgents } : null}
        head={<><Th>Имя</Th><Th>Заголовок / Описание</Th><Th>Инструменты</Th><Th>Скиллы</Th><Th right>{t.common.actions}</Th></>}
      >
        {ov.agents.map(a => (
          <Row key={a.name}>
            <Td><span className="font-mono text-xs font-medium text-slate-800 dark:text-slate-100">{a.name}</span><Err text={a.error} /></Td>
            <Td className="max-w-[260px]">
              <span className="font-medium text-[13px] text-slate-800 dark:text-slate-100">{a.title || '—'}</span>
              {a.description && <span className="block truncate text-xs text-slate-500" title={a.description}>{a.description}</span>}
              {a.model && <span className="block font-mono text-[11px] text-slate-400">model: {a.model}</span>}
              {a.provider && <span className="block font-mono text-[11px] text-slate-400">provider: {a.provider}</span>}
            </Td>
            <Td><span className="font-mono text-[11px] text-slate-500 max-w-[220px] truncate block" title={a.tools.join(', ')}>{a.tools.join(', ') || '—'}</span></Td>
            <Td><span className="font-mono text-[11px] text-slate-500 max-w-[160px] truncate block" title={a.skills.join(', ')}>{a.skills.join(', ') || '—'}</span></Td>
            <Td className="text-right whitespace-nowrap">
              <IconBtn title={t.common.edit} onClick={() => { setEdit(a); setFormError(''); setShowNew(false); }}><Pencil size={15} /></IconBtn>
              <IconBtn title={t.common.delete} onClick={() => remove(a)} className="hover:!text-red-600"><Trash2 size={15} /></IconBtn>
            </Td>
          </Row>
        ))}
      </TableShell>
    </div>
  );
}

function AgentForm({ item, tools, toolsMode, skills, error, onClose, onSaved, onError }: {
  item: AgentItem | null; tools: { name: string; description: string }[]; toolsMode: string | null; skills: { name: string; description: string }[];
  error: string; onClose: () => void; onSaved: () => void; onError: (e: string) => void;
}) {
  const [name, setName] = useState(item?.name || '');
  const [title, setTitle] = useState(item?.title || '');
  const [description, setDescription] = useState(item?.description || '');
  const [selTools, setSelTools] = useState<string[]>(item?.tools || []);
  const [selSkills, setSelSkills] = useState<string[]>(item?.skills || []);
  const [skillQ, setSkillQ] = useState('');
  const skillQuery = skillQ.trim().toLowerCase();
  // Selected-but-removed skills stay visible so they aren't lost on save.
  const visibleSkills = [...skills, ...selSkills.filter(s => !skills.some(x => x.name === s)).map(name => ({ name, description: '' }))]
    .filter(s => !skillQuery || s.name.toLowerCase().includes(skillQuery) || (s.description || '').toLowerCase().includes(skillQuery));
  const [allSkills, setAllSkills] = useState(item ? item.skills.includes('*') : false);
  const [selMcp, setSelMcp] = useState<string[]>(() => {
    const v: unknown = item?.mcp;
    if (Array.isArray(v)) return v.filter(x => typeof x === 'string');
    if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
    return ['default'];
  });
  const [model, setModel] = useState(item?.model || '');
  const [provider, setProvider] = useState(item?.provider || '');
  const [ftab, setFtab] = useState<'main' | 'tools' | 'skills'>('main');
  const [body, setBody] = useState(item?.body || '');
  const [providers, setProviders] = useState<{ name: string; default_model: string | null; models: string[]; is_default: boolean }[]>([]);

  useEffect(() => {
    api.getModelProviderOptions().then(r => setProviders(r.providers)).catch(() => {});
  }, []);

  function pickProvider(name: string) {
    const prev = providers.find(p => p.name === provider);
    const next = providers.find(p => p.name === name);
    setProvider(name);
    // Autofill the model only when the field is empty or still holds the
    // previous provider's default — never clobber a custom value.
    if (next?.default_model && (model === '' || (prev && model === (prev.default_model || '')))) {
      setModel(next.default_model);
    }
    if (!name) {
      const d = providers.find(p => p.is_default);
      if (model === '' || (prev && model === (prev.default_model || ''))) {
        setModel(d?.default_model || '');
      }
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    onError('');
    const payload = {
      name: name.trim(), title, description,
      tools: selTools, skills: allSkills ? ['*'] : selSkills,
      mcp: selMcp, model, provider, body,
    };
    try {
      if (item) await api.updateAgent(item.name, payload);
      else await api.createAgent(payload);
      onSaved();
      onClose();
    } catch (err) {
      onError(errText(err, 'Ошибка сохранения'));
    }
  }

  return (
    <FormModal title={item ? `Редактировать агента ${item.name}` : t.studio.newAgent} onClose={onClose} onSubmit={submit} error={error} wide>
      <Segmented value={ftab} onChange={setFtab} options={[
        { key: 'main', label: t.studio.tabMain },
        { key: 'tools', label: `${t.studio.tabTools} (${selTools.length})` },
        { key: 'skills', label: `${t.studio.tabSkills} (${allSkills ? '*' : selSkills.length})` },
      ]} />
      <div className="min-h-[480px]">
      {ftab === 'main' && (
      <div className="space-y-3 mt-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextField label="Имя (папка, ^[a-z0-9-]+$)" value={name} onChange={setName} mono />
        <TextField label="Заголовок (выпадашка в 1С)" value={title} onChange={setTitle} />
      </div>
      <TextField label={t.skills.description} value={description} onChange={setDescription} />
      <Field label="Промпт (markdown, после второго ---)">
        <TextArea value={body} onChange={e => setBody(e.target.value)} rows={16} spellCheck={false} mono />
      </Field>
      <p className="text-[11px] text-slate-400">Сохраняется в backend/agents/&lt;имя&gt;/AGENT.md. Переименование = перемещение папки. Бэкенд подхватывает без рестарта.</p>
      </div>
      )}
      {ftab === 'tools' && (
      <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
      <McpSelect selected={selMcp} onChange={setSelMcp} />
      <ToolsCheck all={tools} selected={selTools} onChange={setSelTools} mode={toolsMode} mcpFilter={selMcp} />
      </div>
      )}
      {ftab === 'skills' && (
      <div className="space-y-3 mt-3">
      <div>
        <label className="block text-[13px] font-medium text-slate-700 dark:text-slate-300 mb-1">Скиллы</label>
        <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 mb-1 cursor-pointer">
          <input type="checkbox" checked={allSkills} onChange={e => setAllSkills(e.target.checked)} className="rounded accent-blue-600" />
          Все скиллы (*)
        </label>
        {!allSkills && (
          <>
            <input value={skillQ} onChange={e => setSkillQ(e.target.value)} placeholder={`${t.common.search} — имя или описание`}
              className="w-full mb-1 px-2 py-1 text-xs border border-slate-300 rounded-lg bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" />
            <div className="border border-slate-300 dark:border-slate-700 rounded-lg p-2 max-h-28 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-1 bg-slate-50 dark:bg-slate-950">
              {visibleSkills.map(s => (
                <label key={s.name} title={s.description} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 px-1 py-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer">
                  <input type="checkbox" checked={selSkills.includes(s.name)}
                    onChange={() => setSelSkills(selSkills.includes(s.name) ? selSkills.filter(x => x !== s.name) : [...selSkills, s.name])}
                    className="rounded accent-blue-600" />
                  <span className="min-w-0">
                    <span className="font-mono block truncate">{s.name}</span>
                    {s.description && <span className="block truncate text-[11px] text-slate-400">{s.description}</span>}
                  </span>
                </label>
              ))}
              {visibleSkills.length === 0 && <span className="text-xs text-slate-400">{skillQ.trim() ? 'Ничего не найдено' : 'Скиллов пока нет'}</span>}
            </div>
          </>
        )}
      </div>
      <div>
          <label className="block text-[13px] font-medium text-slate-700 dark:text-slate-300 mb-1">{t.studio.provider}</label>
          <select value={providers.some(p => p.name === provider) ? provider : ''} onChange={e => pickProvider(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100">
            <option value="">{t.studio.providerAuto}</option>
            {providers.map(p => (
              <option key={p.name} value={p.name}>{p.name}{p.is_default ? ' (default)' : ''}</option>
            ))}
            {provider && !providers.some(p => p.name === provider) && (
              <option value={provider}>{provider}</option>
            )}
          </select>
        </div>
      <div>
        <label className="block text-[13px] font-medium text-slate-700 dark:text-slate-300 mb-1">{t.studio.modelLabel}</label>
        <input value={model} onChange={e => setModel(e.target.value)} list="agent-model-list" spellCheck={false}
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white text-slate-800 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" />
        <datalist id="agent-model-list">
          {(providers.find(p => p.name === provider)?.models || []).map(m => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>
      </div>
      )}
      </div>
    </FormModal>
  );
}

// ─── Agent skills tab ───

function SkillsTab({ ov, tools, toolsMode, onChanged }: { ov: AgentOverview; tools: { name: string; description: string }[]; toolsMode: string | null; onChanged: () => void }) {
  const [edit, setEdit] = useState<SkillFileItem | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [formError, setFormError] = useState('');
  // Live names from the backend (refreshed with every overview reload,
  // i.e. right after save/delete).
  const [liveNames, setLiveNames] = useState<string[] | null>(null);

  useEffect(() => {
    let alive = true;
    api.getLiveSkills()
      .then(r => { if (alive) setLiveNames(r.reachable && r.data ? r.data.skills.map(s => s.name) : null); })
      .catch(() => { if (alive) setLiveNames(null); });
    return () => { alive = false; };
  }, [ov]);

  async function remove(s: SkillFileItem) {
    if (!confirm(`Удалить скилл «${s.name}»? Папка backend/skills/${s.name}/ будет удалена.`)) return;
    if (!confirm(`Подтвердите: точно удалить скилл «${s.name}»?`)) return;
    await api.deleteAgentSkill(s.name);
    onChanged();
  }

  return (
    <div>
      <div className="flex justify-end mb-3">
        <Btn variant="primary" onClick={() => { setEdit(null); setFormError(''); setShowNew(true); }}>
          <Plus size={15} /> {t.studio.newSkill}
        </Btn>
      </div>
      {(showNew || edit) && (
        <SkillForm item={edit} tools={tools} toolsMode={toolsMode} error={formError}
          onClose={() => { setShowNew(false); setEdit(null); }} onSaved={onChanged} onError={setFormError} />
      )}
      <TableShell
        colSpan={4}
        empty={ov.skills.length === 0 ? { text: t.studio.noSkills } : null}
        head={<><Th>Имя</Th><Th>Описание</Th><Th>Инструменты</Th><Th right>{t.common.actions}</Th></>}
      >
        {ov.skills.map(s => (
          <Row key={s.name}>
            <Td>
              <span className="font-mono text-xs font-medium text-slate-800 dark:text-slate-100">{s.name}</span>
              {liveNames !== null && (
                liveNames.includes(s.name)
                  ? <span className="ml-1.5 inline-block w-2 h-2 rounded-full bg-emerald-500 align-middle" title="Бэкенд видит скилл (live)" />
                  : <span className="ml-1.5 inline-block w-2 h-2 rounded-full bg-amber-500 align-middle" title="Бэкенда доступен, но скилла в live-списке нет" />
              )}
              <Err text={s.error} />
            </Td>
            <Td><span className="text-xs text-slate-500 max-w-[320px] truncate block" title={s.description}>{s.description || '—'}</span></Td>
            <Td><span className="font-mono text-[11px] text-slate-500 max-w-[220px] truncate block" title={s.tools.join(', ')}>{s.tools.join(', ') || '—'}</span></Td>
            <Td className="text-right whitespace-nowrap">
              <IconBtn title={t.common.edit} onClick={() => { setEdit(s); setFormError(''); setShowNew(false); }}><Pencil size={15} /></IconBtn>
              <IconBtn title={t.common.delete} onClick={() => remove(s)} className="hover:!text-red-600"><Trash2 size={15} /></IconBtn>
            </Td>
          </Row>
        ))}
      </TableShell>
      <p className="text-[11px] text-slate-400 mt-2">Скиллы рантайма агентов (backend/skills/*/SKILL.md) — не путать со Скиллами сервера в сайдбаре.</p>
    </div>
  );
}

const SKILL_BODY_EXAMPLE = `# Название сценария

Сценарий «типичный вопрос пользователя» — одной строкой, что делает скилл.

1. Первый шаг: какой тул вызвать, как искать, на что обратить внимание.
2. Второй шаг: какой тул, фильтры, сортировка, лимиты под вопрос.
3. Уточнения («оставь», «убери», «покажи детали») — работай со строками прошлого ответа из истории, новый широкий поиск не начинай. Не хватает поля — добери одним точечным вызовом.

Пример:
- Вопрос: «покажи пять последних ...»
- Действия: \`тул1({...})\` → \`тул2\` с фильтром ..., сортировка ..., лимит 5.
`;

function SkillForm({ item, tools, toolsMode, error, onClose, onSaved, onError }: {
  item: SkillFileItem | null; tools: { name: string; description: string }[]; toolsMode: string | null;
  error: string; onClose: () => void; onSaved: () => void; onError: (e: string) => void;
}) {
  const [name, setName] = useState(item?.name || '');
  const [description, setDescription] = useState(item?.description || '');
  const [selTools, setSelTools] = useState<string[]>(item?.tools || []);
  const [body, setBody] = useState(item?.body || '');
  const [hintOpen, setHintOpen] = useState(false);

  function insertExample() {
    if (body.trim() && !confirm('В теле уже есть текст. Заменить его примером?')) return;
    setBody(SKILL_BODY_EXAMPLE);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    onError('');
    const payload = { name: name.trim(), description, tools: selTools, body };
    try {
      if (item) await api.updateAgentSkill(item.name, payload);
      else await api.createAgentSkill(payload);
      onSaved();
      onClose();
    } catch (err) {
      onError(errText(err, 'Ошибка сохранения'));
    }
  }

  return (
    <FormModal title={item ? `Редактировать скилл ${item.name}` : t.studio.newSkill} onClose={onClose} onSubmit={submit} error={error} xwide fill>
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4 flex-1 min-h-0 overflow-y-auto lg:overflow-hidden">
        <div className="space-y-3 min-w-0 flex flex-col min-h-0">
          <TextField label="Имя (папка, ^[a-z0-9-]+$)" value={name} onChange={setName} mono />
          <TextField label="Описание (автомэтчинг)" value={description} onChange={setDescription} />
          <div className="rounded-lg border border-slate-200 dark:border-slate-800">
            <button type="button" onClick={() => setHintOpen(v => !v)}
              className="w-full flex items-center justify-between px-3 py-2 text-[13px] font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50 rounded-lg cursor-pointer">
              Как писать промпт скилла
              <span className="text-slate-400">{hintOpen ? '▲' : '▼'}</span>
            </button>
            {hintOpen && (
              <div className="px-3 pb-3 text-xs text-slate-600 dark:text-slate-300 space-y-2">
                <ul className="list-disc pl-4 space-y-1">
                  <li>Один скилл = один сценарий, не свалка.</li>
                  <li>Каждый шаг — конкретный тул и параметры вызова.</li>
                  <li>Блок «Уточнения» обязателен, иначе на каждое «оставь» агент делает полный репоиск.</li>
                  <li>Пример «Вопрос → Действия» — по нему видно, правильно ли агент понял.</li>
                  <li>Описание выше — глаголы пользователя («покажи», «найди»): по нему идёт автомэтчинг.</li>
                </ul>
                <button type="button" onClick={insertExample}
                  className="px-3 py-1.5 text-xs text-blue-600 border border-blue-300 rounded-lg hover:bg-blue-50 dark:text-blue-400 dark:border-blue-900 dark:hover:bg-blue-950 cursor-pointer">
                  Вставить пример
                </button>
              </div>
            )}
          </div>
          <div className="flex-1 min-h-0">
            <Field label="Промпт (markdown, после второго ---)" className="h-full flex flex-col">
              <TextArea value={body} onChange={e => setBody(e.target.value)} rows={20} spellCheck={false} mono className="flex-1 min-h-[300px] resize-y" />
            </Field>
          </div>
          <p className="text-[11px] text-slate-400">Сохраняется в backend/skills/&lt;имя&gt;/SKILL.md. Переименование = перемещение папки. Бэкенд подхватывает без рестарта.</p>
        </div>
        <div className="min-w-0 flex flex-col min-h-0">
          <ToolsCheck all={tools} selected={selTools} onChange={setSelTools} mode={toolsMode} cols={1} fill />
        </div>
      </div>
    </FormModal>
  );
}

// ─── Patterns tab ───

function PatternsTab({ ov, onChanged }: { ov: AgentOverview; onChanged: () => void }) {
  const [edit, setEdit] = useState<PatternItem | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [formError, setFormError] = useState('');

  async function remove(p: PatternItem) {
    if (!confirm(`Удалить паттерн «${p.name}»? Файл backend/patterns/${p.name}.md будет удалён.`)) return;
    if (!confirm(`Подтвердите: точно удалить паттерн «${p.name}»?`)) return;
    await api.deletePattern(p.name);
    onChanged();
  }

  return (
    <div>
      <div className="flex justify-end mb-3">
        <Btn variant="primary" onClick={() => { setEdit(null); setFormError(''); setShowNew(true); }}>
          <Plus size={15} /> {t.studio.newPattern}
        </Btn>
      </div>
      {(showNew || edit) && (
        <PatternForm item={edit} error={formError}
          onClose={() => { setShowNew(false); setEdit(null); }} onSaved={onChanged} onError={setFormError} />
      )}
      <TableShell
        colSpan={3}
        empty={ov.patterns.length === 0 ? { text: t.studio.noPatterns } : null}
        head={<><Th>Имя</Th><Th>Описание</Th><Th right>{t.common.actions}</Th></>}
      >
        {ov.patterns.map(p => (
          <Row key={p.name}>
            <Td><span className="font-mono text-xs font-medium text-slate-800 dark:text-slate-100">{p.name}</span><Err text={p.error} /></Td>
            <Td><span className="text-xs text-slate-500 max-w-[420px] truncate block" title={p.description}>{p.description || '—'}</span></Td>
            <Td className="text-right whitespace-nowrap">
              <IconBtn title={t.common.edit} onClick={() => { setEdit(p); setFormError(''); setShowNew(false); }}><Pencil size={15} /></IconBtn>
              <IconBtn title={t.common.delete} onClick={() => remove(p)} className="hover:!text-red-600"><Trash2 size={15} /></IconBtn>
            </Td>
          </Row>
        ))}
      </TableShell>
    </div>
  );
}

function PatternForm({ item, error, onClose, onSaved, onError }: {
  item: PatternItem | null;
  error: string; onClose: () => void; onSaved: () => void; onError: (e: string) => void;
}) {
  const [name, setName] = useState(item?.name || '');
  const [description, setDescription] = useState(item?.description || '');
  const [body, setBody] = useState(item?.body || '');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    onError('');
    const payload = { name: name.trim(), description, body };
    try {
      if (item) await api.updatePattern(item.name, payload);
      else await api.createPattern(payload);
      onSaved();
      onClose();
    } catch (err) {
      onError(errText(err, 'Ошибка сохранения'));
    }
  }

  return (
    <FormModal title={item ? `Редактировать паттерн ${item.name}` : t.studio.newPattern} onClose={onClose} onSubmit={submit} error={error} wide>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextField label="Имя (файл, ^[a-z0-9-]+$)" value={name} onChange={setName} mono />
        <TextField label={t.skills.description} value={description} onChange={setDescription} />
      </div>
      <BodyField value={body} onChange={setBody} rows={14} />
    </FormModal>
  );
}

// ─── Backend tab ───

function BackendTab() {
  const [st, setSt] = useState<AgentBackendStatus | null>(null);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState('');
  const [logService, setLogService] = useState('backend');
  const [logTail, setLogTail] = useState(200);
  const [logTs, setLogTs] = useState(false);
  const [logLive, setLogLive] = useState(true);
  const [logGrep, setLogGrep] = useState('');
  const logEndRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<{ agents: string[]; skills: string[]; errors: string[]; reachable: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.getAgentBackendStatus();
      setSt(s);
      const [la, ls] = await Promise.all([api.getLiveAgents(), api.getLiveSkills()]);
      setLive({
        reachable: la.reachable && ls.reachable,
        agents: la.data?.agents.map(a => a.name) || [],
        skills: ls.data?.skills.map(s => s.name) || [],
        errors: [...(la.data?.errors || []), ...(ls.data?.errors || [])],
      });
    } catch { /* бэкенд лежит — статус покажет */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function run(fn: () => Promise<{ ok: boolean; output: string }>, confirmMsg?: string) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBusy(true);
    setOutput('');
    try {
      const r = await fn();
      setOutput(r.output);
      await load();
    } catch (e) {
      setOutput(errText(e, 'Ошибка'));
    } finally {
      setBusy(false);
    }
  }

  const loadLogs = useCallback(async () => {
    try {
      const r = await api.getAgentBackendLogs(logService || undefined, logTail, logTs, logGrep || undefined);
      setLog(r.log);
    } catch (e) {
      setLog(errText(e, 'Ошибка'));
    }
  }, [logService, logTail, logTs, logGrep]);

  useEffect(() => { loadLogs(); }, [loadLogs]);
  useEffect(() => {
    if (!logLive) return;
    const timer = setInterval(loadLogs, 3000);
    return () => clearInterval(timer);
  }, [logLive, loadLogs]);
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [log]);

  const toggleProfile = (p: string) =>
    setProfiles(profiles.includes(p) ? profiles.filter(x => x !== p) : [...profiles, p]);

  return (
    <div className="space-y-4">
      <Card><CardBody>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold flex items-center gap-2 text-slate-800 dark:text-slate-200">
            <Server size={17} /> {t.studio.backendTitle}
            {!st?.compose_available && <span className="text-xs text-red-500 font-normal">{t.studio.noCompose}</span>}
          </h3>
          <IconBtn title={t.common.refresh} onClick={load}><RefreshCw size={15} /></IconBtn>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mb-3">
          {(st?.services || []).map(s => (
            <div key={s.name} className="border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 bg-slate-50 dark:bg-slate-950">
              <p className="font-mono text-xs font-medium text-slate-800 dark:text-slate-100">{s.name}</p>
              <p className="text-[11px] text-slate-500">{s.state}{s.health ? ` (${s.health})` : ''}</p>
            </div>
          ))}
          {(st?.services.length || 0) === 0 && <p className="text-xs text-slate-400">Нет контейнеров (или compose недоступен)</p>}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
            <input type="checkbox" checked={profiles.includes('rag')} onChange={() => toggleProfile('rag')} className="rounded accent-blue-600" /> rag (tei)
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
            <input type="checkbox" checked={profiles.includes('onec')} onChange={() => toggleProfile('onec')} className="rounded accent-blue-600" /> onec (mcp-proxy)
          </label>
          <span className="flex-1" />
          <Btn variant="primary" disabled={busy} onClick={() => run(() => api.agentBackendUp([], profiles))} className="!bg-emerald-600 hover:!bg-emerald-500 dark:!bg-emerald-600">
            <Play size={13} /> {t.studio.start}
          </Btn>
          <Btn variant="outline" disabled={busy} onClick={() => run(() => api.agentBackendStop([]), 'Остановить все контейнеры агент-бэкенда? (данные сохранятся)')}>
            <Square size={13} /> {t.studio.stopAll}
          </Btn>
          <Btn variant="outline" disabled={busy} onClick={() => run(() => api.agentBackendRestart(['backend']), 'Перезапустить контейнер бэкенда? Текущие chat-запросы упадут.')}>
            <RotateCcw size={13} /> {t.studio.restartBackend}
          </Btn>
        </div>
        {output && <pre className="mt-3 text-[11px] font-mono text-emerald-700 bg-slate-100 border border-slate-200 rounded-lg p-3 max-h-48 overflow-y-auto whitespace-pre-wrap dark:text-emerald-300 dark:bg-slate-950 dark:border-slate-800">{output}</pre>}
      </CardBody></Card>

      <Card><CardBody>
        <h3 className="text-sm font-semibold mb-2 text-slate-800 dark:text-slate-200">Backend API ({st?.backend_url})</h3>
        <p className="text-xs text-slate-500 mb-2">
          Доступен: {st?.backend_reachable ? <span className="text-emerald-500 font-medium">да</span> : <span className="text-red-500 font-medium">нет</span>}
          {live && (
            <span className="ml-3">
              live-агенты: <span className="font-mono">{live.agents.join(', ') || '—'}</span>
              {' '}· live-скиллы: <span className="font-mono">{live.skills.length}</span>
            </span>
          )}
        </p>
        {live && live.errors.length > 0 && (
          <Alert tone="red">Бэкенд сообщает о битых файлах: {live.errors.join('; ')}</Alert>
        )}
      </CardBody></Card>

      <Card><CardBody>
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200">Логи</h3>
          <Select value={logService} onChange={e => setLogService(e.target.value)} className="!w-auto !py-1 !text-xs">
            <option value="">все сервисы</option>
            <option value="backend">backend</option>
            <option value="postgres">postgres</option>
            <option value="tei">tei</option>
            <option value="mcp-proxy">mcp-proxy</option>
          </Select>
          <Select value={logTail} onChange={e => setLogTail(Number(e.target.value))} title="Сколько строк" className="!w-auto !py-1 !text-xs">
            {[100, 200, 500, 1000].map(n => <option key={n} value={n}>хвост {n}</option>)}
          </Select>
          <label className="flex items-center gap-1 text-xs text-slate-500 cursor-pointer" title="docker --timestamps">
            <input type="checkbox" checked={logTs} onChange={e => setLogTs(e.target.checked)} className="rounded accent-blue-600" /> ts
          </label>
          <TextInput value={logGrep} onChange={e => setLogGrep(e.target.value)} placeholder="grep…" title="Фильтр без учёта регистра" className="!w-40 !py-1 !text-xs" />
          <Btn variant="outline" onClick={() => setLogGrep(v => v === 'agent1c.loop' ? '' : 'agent1c.loop')} title="Быстрый фильтр: agent1c.loop" className="!py-1 !text-xs !font-mono">
            agent1c.loop
          </Btn>
          <Btn variant="outline" onClick={() => setLogLive(v => !v)} title={logLive ? 'Приостановить' : 'Продолжить'} className="!py-1 !text-xs">
            {logLive ? <Pause size={12} /> : <Play size={12} />} {logLive ? t.logs.live : t.logs.paused}
          </Btn>
          <Btn variant="outline" onClick={loadLogs} className="!py-1 !text-xs">
            <RefreshCw size={12} /> {t.common.refresh}
          </Btn>
        </div>
        <div className="relative">
          <pre className="text-[11px] font-mono text-emerald-700 bg-slate-100 border border-slate-200 rounded-lg p-3 max-h-[60vh] overflow-y-auto whitespace-pre-wrap dark:text-emerald-300 dark:bg-slate-950 dark:border-slate-800">{log || 'Логов нет'}</pre>
          <div ref={logEndRef} />
        </div>
      </CardBody></Card>
    </div>
  );
}

// ─── Env tab ───

function EnvTab() {
  const [entries, setEntries] = useState<EnvEntry[]>([]);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      setEntries(await api.getAgentEnv());
    } catch (e) {
      setMsg(errText(e, 'Ошибка загрузки'));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save(key: string) {
    const value = editing[key] ?? '';
    if (!confirm(`Записать ${key} в .env проекта? Потребуется рестарт бэкенда.`)) return;
    setMsg('');
    try {
      await api.putAgentEnv(key, value);
      setMsg(`${key} сохранён — перезапустите контейнер бэкенда.`);
      setEditing(prev => { const n = { ...prev }; delete n[key]; return n; });
      setRevealed(prev => ({ ...prev, [key]: false }));
      await load();
    } catch (e) {
      setMsg(errText(e, 'Ошибка сохранения'));
    }
  }

  return (
    <div>
      <p className="text-xs text-slate-500 mb-3">
        Проектный <span className="font-mono">.env</span> (только разрешённые ключи). Секреты скрыты — введите новое значение для замены, пустой редактор сохраняет текущее.
      </p>
      {msg && <div className="mb-3"><Alert tone="blue">{msg}</Alert></div>}
      <TableShell
        colSpan={3}
        empty={entries.length === 0 ? { text: 'Переменных нет' } : null}
        head={<><Th>Ключ</Th><Th>Значение</Th><Th right>Действие</Th></>}
      >
        {entries.map(e => {
          const isEditing = editing[e.key] !== undefined;
          const showSecret = revealed[e.key];
          return (
            <Row key={e.key}>
              <Td>
                <span className="font-mono text-xs text-slate-800 dark:text-slate-100">{e.key}</span>
                {!e.present && <Badge tone="neutral"><span className="text-[10px]">отсутствует</span></Badge>}
              </Td>
              <Td>
                {isEditing ? (
                  <TextInput type={e.masked && !showSecret ? 'password' : 'text'}
                    value={editing[e.key]} autoFocus
                    onChange={ev => setEditing(prev => ({ ...prev, [e.key]: ev.target.value }))}
                    placeholder={e.masked ? '(пусто — оставить)' : e.value || ''}
                    mono className="!py-1 !text-xs" />
                ) : (
                  <span className="font-mono text-xs text-slate-500">
                    {e.masked ? (e.present ? '***' : '—') : (e.value || '—')}
                  </span>
                )}
              </Td>
              <Td className="text-right whitespace-nowrap">
                {isEditing ? (
                  <>
                    <Btn variant="primary" onClick={() => save(e.key)} className="!py-1 !text-xs mr-1">{t.common.save}</Btn>
                    <Btn variant="ghost" onClick={() => setEditing(prev => { const n = { ...prev }; delete n[e.key]; return n; })} className="!py-1 !text-xs">{t.common.cancel}</Btn>
                  </>
                ) : (
                  <>
                    {e.masked && e.present && (
                      <Btn variant="ghost" onClick={() => setEditing(prev => ({ ...prev, [e.key]: '' }))} className="!py-1 !text-xs mr-1">Заменить</Btn>
                    )}
                    <IconBtn title={t.common.edit} onClick={() => setEditing(prev => ({ ...prev, [e.key]: e.masked ? '' : (e.value || '') }))}><Pencil size={14} /></IconBtn>
                  </>
                )}
              </Td>
            </Row>
          );
        })}
      </TableShell>
    </div>
  );
}
