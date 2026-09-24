import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, Play, Pause, Square, RotateCcw, RefreshCw, Server, AlertTriangle, FolderOpen } from 'lucide-react';
import { api } from '../api/client';
import FileBrowser from '../components/FileBrowser';
import type { AgentItem, SkillFileItem, PatternItem, AgentOverview, AgentBackendStatus, EnvEntry, Me, McpServer, ServerStatus } from '../types';

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
        // Live ToolRegistry from the backend — the source of truth.
        setTools(live.data.tools.map(t => ({ name: t.name, description: t.description || '' })));
        setToolsMode(live.data.mode);
      } else {
        // Backend down: fall back to the static known list.
        const t = await api.getAgentTools();
        setTools(t.map(name => ({ name, description: '' })));
        setToolsMode(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function pickRoot(path: string) {
    if (!confirm(`Switch agent project root to:\n${path}\nAll file/backend operations will target this directory.`)) return;
    setBrowseRoot(false);
    try {
      await api.putSetting('agent_project_root', path);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set root');
    }
  }
  const allTabs: { key: Tab; label: string }[] = [
    { key: 'agents', label: 'Agents' },
    { key: 'skills', label: 'Agent Skills' },
    { key: 'patterns', label: 'Patterns' },
    { key: 'backend', label: 'Backend' },
    { key: 'env', label: 'Config (.env)' },
  ];
  const tabs = allTabs.filter((t: { key: Tab; label: string }) =>
    !me || me.sections.includes(TAB_SECTION[t.key]));

  // If the active tab is not permitted (e.g. after role change), jump to the first allowed one.
  useEffect(() => {
    if (me && !me.sections.includes(TAB_SECTION[tab])) {
      const first = (['agents', 'skills', 'patterns', 'backend', 'env'] as Tab[])
        .find(t => me.sections.includes(TAB_SECTION[t]));
      if (first) setTab(first);
    }
  }, [me, tab]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-start gap-2">
          <div>
            <h2 className="text-2xl font-bold text-gray-800">AI Agent Studio</h2>
            <p className="text-xs text-gray-500 font-mono mt-0.5">
              {ov ? ov.root : '…'} {!ov?.root_exists && ov && <span className="text-red-500">— project root not found</span>}
            </p>
          </div>
          <button onClick={() => setBrowseRoot(true)} title="Change project root directory"
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-200 transition-colors mt-1">
            <FolderOpen size={14} /> Root…
          </button>
        </div>
        <button onClick={load} className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-200 transition-colors">
          <RefreshCw size={16} /> Reload
        </button>
      </div>

      {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">{error}</p>}

      <div className="flex gap-2 mb-4 flex-wrap">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-1.5 text-sm rounded-lg transition-colors ${tab === t.key ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 border border-gray-200 hover:bg-gray-200'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'agents' && ov && <AgentsTab ov={ov} tools={tools} toolsMode={toolsMode} skillNames={ov.skills.map(s => s.name)} onChanged={load} />}
      {tab === 'skills' && ov && <SkillsTab ov={ov} tools={tools} toolsMode={toolsMode} onChanged={load} />}
      {tab === 'patterns' && ov && <PatternsTab ov={ov} onChanged={load} />}
      {tab === 'backend' && <BackendTab />}
      {tab === 'env' && <EnvTab />}
      {browseRoot && (
        <FileBrowser
          dirsOnly
          title="Select agent project root (contains backend/ + docker-compose.yml)"
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
    <span className="ml-1.5 inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-red-50 text-red-600 border border-red-200" title={text}>
      <AlertTriangle size={12} /> broken
    </span>
  );
}

/// Mirror of the agent backend naming rules (`onec/aggregated.py` +
/// `api/mod.rs::tool_prefix`): `server__tool` carries the subserver tag,
/// unprefixed names are backend built-ins (default-proxy / local).
function toolServer(toolName: string): string | null {
  const i = toolName.indexOf('__');
  return i > 0 ? toolName.slice(0, i) : null;
}

function toolPrefix(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9_.-]/g, '_') || 'server';
  return s.slice(0, 32);
}

function ToolsCheck({ all, selected, onChange, mode, mcpFilter }: {
  all: { name: string; description: string }[]; selected: string[]; onChange: (v: string[]) => void; mode: string | null;
  /// Selected MCP row names (agent form): prefixed tools are shown only for
  /// these servers. Backend built-ins (no `__`) are always shown.
  /// `null` = no filtering (skill form has no mcp field).
  mcpFilter?: string[] | null;
}) {
  const toggle = (t: string) =>
    onChange(selected.includes(t) ? selected.filter(x => x !== t) : [...selected, t]);
  // Keep already-selected tools visible even if the live registry no longer lists them.
  const extra = selected.filter(s => !all.some(t => t.name === s)).map(name => ({ name, description: '(not in live registry)' }));
  const list = [...all, ...extra];
  const visible = (name: string) => {
    if (!mcpFilter) return true;
    const srv = toolServer(name);
    if (srv === null) return true;
    return mcpFilter.some(s => s === srv || toolPrefix(s) === srv);
  };
  const shown = list.filter(t => visible(t.name));
  const hiddenSelected = selected.filter(s => !shown.some(t => t.name === s));
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-sm font-medium text-gray-700">Tools (subset of ToolRegistry)</label>
        <span className={`text-[11px] px-1.5 py-0.5 rounded ${mode ? 'bg-green-50 text-green-600' : 'bg-gray-200 text-gray-500'}`} title={mode ? 'Live list from backend GET /tools' : 'Backend unreachable — static fallback list'}>
          {mode ? `live · ${mode} · ${all.length}` : `offline · static · ${all.length}`}
        </span>
      </div>
      {mcpFilter && (
        <p className="text-[11px] text-gray-500 mb-1">
          Filtered by MCP: {mcpFilter.length ? mcpFilter.join(', ') : 'default'}
          {hiddenSelected.length > 0 && (
            <span className="text-yellow-600"> · {hiddenSelected.length} selected hidden (kept on save)</span>
          )}
        </p>
      )}
      <div className="border border-gray-300 rounded-lg p-2 max-h-40 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-1 bg-gray-50">
        {shown.map(t => {
          const srv = toolServer(t.name);
          return (
            <label key={t.name} title={t.description} className="flex items-center gap-2 text-xs text-gray-700 px-1 py-0.5 rounded hover:bg-gray-200 cursor-pointer">
              <input type="checkbox" checked={selected.includes(t.name)} onChange={() => toggle(t.name)} className="rounded" />
              <span className="font-mono truncate">{t.name}</span>
              {srv !== null && <span className="text-[10px] text-gray-400 shrink-0">{srv}</span>}
            </label>
          );
        })}
        {shown.length === 0 && <span className="text-xs text-gray-400">No tools for the selected MCP servers</span>}
      </div>
    </div>
  );
}

function BodyField({ value, onChange, rows }: { value: string; onChange: (v: string) => void; rows?: number }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">Body (markdown, after second ---)</label>
      <textarea value={value} onChange={e => onChange(e.target.value)} rows={rows || 10} spellCheck={false}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
    </div>
  );
}

function TextField({ label, value, onChange, mono, placeholder }: { label: string; value: string; onChange: (v: string) => void; mono?: boolean; placeholder?: string }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input type="text" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className={`w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${mono ? 'font-mono' : ''}`} />
    </div>
  );
}

/// MCP server multi-picker for the agent `mcp:` field (same UX as Tools):
/// checkboxes over ai-1c-server rows (running first). Falls back to
/// comma-separated free text when the mcp-servers section is not visible.
function McpSelect({ selected, onChange }: { selected: string[]; onChange: (v: string[]) => void }) {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [live, setLive] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [items, st] = await Promise.all([api.getMcpServers(), api.getStatus().catch(() => [] as ServerStatus[])]);
        if (!alive) return;
        setServers(items);
        const map: Record<string, string> = {};
        st.forEach(x => { map[x.id] = x.status; });
        setLive(map);
      } catch {
        if (alive) setServers(null);
      }
    })();
    return () => { alive = false; };
  }, []);

  const toggle = (name: string) =>
    onChange(selected.includes(name) ? selected.filter(x => x !== name) : [...selected, name]);

  if (servers === null) {
    return <TextField label="MCP servers (comma-separated, empty = default)" value={selected.join(', ')}
      onChange={v => onChange(v.split(',').map(s => s.trim()).filter(Boolean))} mono />;
  }
  const sorted = [...servers].sort((a, b) =>
    ((live[b.id] === 'running') ? 1 : 0) - ((live[a.id] === 'running') ? 1 : 0)
    || a.name.localeCompare(b.name));
  // Keep previously saved custom values visible even if no such row exists.
  const extra = selected.filter(s => s !== 'default' && !sorted.some(r => r.name === s));
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-sm font-medium text-gray-700">MCP servers</label>
        <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-500">{selected.length || 'default'}</span>
      </div>
      <div className="border border-gray-300 rounded-lg p-2 max-h-40 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-1 bg-gray-50">
        <label className="flex items-center gap-2 text-xs text-gray-700 px-1 py-0.5 rounded hover:bg-gray-200 cursor-pointer" title="Backend default">
          <input type="checkbox" checked={selected.includes('default')} onChange={() => toggle('default')} className="rounded" />
          <span className="font-mono">default</span>
        </label>
        {sorted.map(s => (
          <label key={s.id} className="flex items-center gap-2 text-xs text-gray-700 px-1 py-0.5 rounded hover:bg-gray-200 cursor-pointer" title={s.transport}>
            <input type="checkbox" checked={selected.includes(s.name)} onChange={() => toggle(s.name)} className="rounded" />
            <span className="font-mono truncate">{s.name}</span>
            {live[s.id] === 'running' && <span className="text-[10px] text-green-600">●</span>}
          </label>
        ))}
        {extra.map(name => (
          <label key={name} className="flex items-center gap-2 text-xs text-gray-700 px-1 py-0.5 rounded hover:bg-gray-200 cursor-pointer" title="Saved value, no such server row">
            <input type="checkbox" checked={selected.includes(name)} onChange={() => toggle(name)} className="rounded" />
            <span className="font-mono truncate">{name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function Modal({ title, onClose, onSubmit, error, children, wide }: {
  title: string; onClose: () => void; onSubmit: (e: React.FormEvent) => void; error: string; children: React.ReactNode; wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className={`bg-gray-100 rounded-xl shadow-xl w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} mx-4 max-h-[90vh] overflow-y-auto`} onClick={e => e.stopPropagation()}>
        <form onSubmit={onSubmit} className="p-6 space-y-4">
          <h3 className="text-lg font-semibold text-gray-800">{title}</h3>
          {children}
          {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
            <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">Save</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Agents tab ───

function AgentsTab({ ov, tools, toolsMode, skillNames, onChanged }: { ov: AgentOverview; tools: { name: string; description: string }[]; toolsMode: string | null; skillNames: string[]; onChanged: () => void }) {
  const [edit, setEdit] = useState<AgentItem | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [formError, setFormError] = useState('');

  async function remove(a: AgentItem) {
    if (!confirm(`Delete agent "${a.name}"? The folder backend/agents/${a.name}/ will be removed.`)) return;
    if (!confirm(`Type-confirm: really delete agent "${a.name}"?`)) return;
    await api.deleteAgent(a.name);
    onChanged();
  }

  return (
    <div>
      <div className="flex justify-end mb-3">
        <button onClick={() => { setEdit(null); setFormError(''); setShowNew(true); }}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
          <Plus size={16} /> New Agent
        </button>
      </div>
      {(showNew || edit) && (
        <AgentForm
          item={edit}
          tools={tools}
          toolsMode={toolsMode}
          skillNames={skillNames}
          error={formError}
          onClose={() => { setShowNew(false); setEdit(null); }}
          onSaved={onChanged}
          onError={setFormError}
        />
      )}
      <div className="bg-gray-100 rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="text-left px-4 py-3 font-medium text-gray-600">Name</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Title / Description</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Tools</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Skills</th>
              <th className="text-right px-4 py-3 font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody>
            {ov.agents.map(a => (
              <tr key={a.name} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-xs font-medium text-gray-800">{a.name}<Err text={a.error} /></td>
                <td className="px-4 py-3 text-gray-600 text-xs max-w-[260px]">
                  <span className="font-medium text-gray-800">{a.title || '—'}</span>
                  {a.description && <span className="block truncate" title={a.description}>{a.description}</span>}
                  {a.model && <span className="block font-mono text-[11px] text-gray-500">model: {a.model}</span>}
                </td>
                <td className="px-4 py-3 text-gray-600 font-mono text-[11px] max-w-[220px] truncate" title={a.tools.join(', ')}>{a.tools.join(', ') || '—'}</td>
                <td className="px-4 py-3 text-gray-600 font-mono text-[11px] max-w-[160px] truncate" title={a.skills.join(', ')}>{a.skills.join(', ') || '—'}</td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <button onClick={() => { setEdit(a); setFormError(''); setShowNew(false); }} className="p-1.5 text-gray-400 hover:text-blue-600"><Pencil size={16} /></button>
                  <button onClick={() => remove(a)} className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 size={16} /></button>
                </td>
              </tr>
            ))}
            {ov.agents.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">No agents</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AgentForm({ item, tools, toolsMode, skillNames, error, onClose, onSaved, onError }: {
  item: AgentItem | null; tools: { name: string; description: string }[]; toolsMode: string | null; skillNames: string[];
  error: string; onClose: () => void; onSaved: () => void; onError: (e: string) => void;
}) {
  const [name, setName] = useState(item?.name || '');
  const [title, setTitle] = useState(item?.title || '');
  const [description, setDescription] = useState(item?.description || '');
  const [selTools, setSelTools] = useState<string[]>(item?.tools || []);
  const [selSkills, setSelSkills] = useState<string[]>(item?.skills || []);
  const [allSkills, setAllSkills] = useState(item ? item.skills.includes('*') : false);
  // `mcp` arrives as a list; tolerate legacy scalar files/custom values.
  const [selMcp, setSelMcp] = useState<string[]>(() => {
    const v: unknown = item?.mcp;
    if (Array.isArray(v)) return v.filter(x => typeof x === 'string');
    if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
    return ['default'];
  });
  const [model, setModel] = useState(item?.model || '');
  const [body, setBody] = useState(item?.body || '');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    onError('');
    const payload = {
      name: name.trim(), title, description,
      tools: selTools, skills: allSkills ? ['*'] : selSkills,
      mcp: selMcp, model, body,
    };
    try {
      if (item) await api.updateAgent(item.name, payload);
      else await api.createAgent(payload);
      onSaved();
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  return (
    <Modal title={item ? `Edit agent ${item.name}` : 'New agent'} onClose={onClose} onSubmit={submit} error={error} wide>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextField label="Name (folder, ^[a-z0-9-]+$)" value={name} onChange={setName} mono />
        <TextField label="Title (1C dropdown)" value={title} onChange={setTitle} />
      </div>
      <TextField label="Description" value={description} onChange={setDescription} />
      <ToolsCheck all={tools} selected={selTools} onChange={setSelTools} mode={toolsMode} mcpFilter={selMcp} />
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Skills</label>
        <label className="flex items-center gap-2 text-xs text-gray-700 mb-1">
          <input type="checkbox" checked={allSkills} onChange={e => setAllSkills(e.target.checked)} className="rounded" />
          All skills (*)
        </label>
        {!allSkills && (
          <div className="border border-gray-300 rounded-lg p-2 max-h-28 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-1 bg-gray-50">
            {skillNames.map(s => (
              <label key={s} className="flex items-center gap-2 text-xs text-gray-700 px-1 py-0.5 rounded hover:bg-gray-200 cursor-pointer">
                <input type="checkbox" checked={selSkills.includes(s)}
                  onChange={() => setSelSkills(selSkills.includes(s) ? selSkills.filter(x => x !== s) : [...selSkills, s])}
                  className="rounded" />
                <span className="font-mono">{s}</span>
              </label>
            ))}
            {skillNames.length === 0 && <span className="text-xs text-gray-400">No skills yet</span>}
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <McpSelect selected={selMcp} onChange={setSelMcp} />
        <TextField label="Model override (empty = config)" value={model} onChange={setModel} mono />
      </div>
      <BodyField value={body} onChange={setBody} rows={12} />
      <p className="text-[11px] text-gray-500">Saved to backend/agents/&lt;name&gt;/AGENT.md. Rename = folder move. Backend picks it up without restart.</p>
    </Modal>
  );
}

// ─── Agent skills tab ───

function SkillsTab({ ov, tools, toolsMode, onChanged }: { ov: AgentOverview; tools: { name: string; description: string }[]; toolsMode: string | null; onChanged: () => void }) {
  const [edit, setEdit] = useState<SkillFileItem | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [formError, setFormError] = useState('');

  async function remove(s: SkillFileItem) {
    if (!confirm(`Delete skill "${s.name}"? The folder backend/skills/${s.name}/ will be removed.`)) return;
    if (!confirm(`Type-confirm: really delete skill "${s.name}"?`)) return;
    await api.deleteAgentSkill(s.name);
    onChanged();
  }

  return (
    <div>
      <div className="flex justify-end mb-3">
        <button onClick={() => { setEdit(null); setFormError(''); setShowNew(true); }}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
          <Plus size={16} /> New Skill
        </button>
      </div>
      {(showNew || edit) && (
        <SkillForm item={edit} tools={tools} toolsMode={toolsMode} error={formError}
          onClose={() => { setShowNew(false); setEdit(null); }} onSaved={onChanged} onError={setFormError} />
      )}
      <div className="bg-gray-100 rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="text-left px-4 py-3 font-medium text-gray-600">Name</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Description</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Tools</th>
              <th className="text-right px-4 py-3 font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody>
            {ov.skills.map(s => (
              <tr key={s.name} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-xs font-medium text-gray-800">{s.name}<Err text={s.error} /></td>
                <td className="px-4 py-3 text-gray-600 text-xs max-w-[320px] truncate" title={s.description}>{s.description || '—'}</td>
                <td className="px-4 py-3 text-gray-600 font-mono text-[11px] max-w-[220px] truncate" title={s.tools.join(', ')}>{s.tools.join(', ') || '—'}</td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <button onClick={() => { setEdit(s); setFormError(''); setShowNew(false); }} className="p-1.5 text-gray-400 hover:text-blue-600"><Pencil size={16} /></button>
                  <button onClick={() => remove(s)} className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 size={16} /></button>
                </td>
              </tr>
            ))}
            {ov.skills.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">No skills</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-gray-500 mt-2">Agent runtime skills (backend/skills/*/SKILL.md) — not to be confused with ai-1c-server Skills in the sidebar.</p>
    </div>
  );
}

function SkillForm({ item, tools, toolsMode, error, onClose, onSaved, onError }: {
  item: SkillFileItem | null; tools: { name: string; description: string }[]; toolsMode: string | null;
  error: string; onClose: () => void; onSaved: () => void; onError: (e: string) => void;
}) {
  const [name, setName] = useState(item?.name || '');
  const [description, setDescription] = useState(item?.description || '');
  const [selTools, setSelTools] = useState<string[]>(item?.tools || []);
  const [body, setBody] = useState(item?.body || '');

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
      onError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  return (
    <Modal title={item ? `Edit skill ${item.name}` : 'New skill'} onClose={onClose} onSubmit={submit} error={error} wide>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextField label="Name (folder, ^[a-z0-9-]+$)" value={name} onChange={setName} mono />
        <TextField label="Description (auto-match)" value={description} onChange={setDescription} />
      </div>
      <ToolsCheck all={tools} selected={selTools} onChange={setSelTools} mode={toolsMode} />
      <BodyField value={body} onChange={setBody} rows={12} />
    </Modal>
  );
}

// ─── Patterns tab ───

function PatternsTab({ ov, onChanged }: { ov: AgentOverview; onChanged: () => void }) {
  const [edit, setEdit] = useState<PatternItem | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [formError, setFormError] = useState('');

  async function remove(p: PatternItem) {
    if (!confirm(`Delete pattern "${p.name}"? The file backend/patterns/${p.name}.md will be removed.`)) return;
    if (!confirm(`Type-confirm: really delete pattern "${p.name}"?`)) return;
    await api.deletePattern(p.name);
    onChanged();
  }

  return (
    <div>
      <div className="flex justify-end mb-3">
        <button onClick={() => { setEdit(null); setFormError(''); setShowNew(true); }}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
          <Plus size={16} /> New Pattern
        </button>
      </div>
      {(showNew || edit) && (
        <PatternForm item={edit} error={formError}
          onClose={() => { setShowNew(false); setEdit(null); }} onSaved={onChanged} onError={setFormError} />
      )}
      <div className="bg-gray-100 rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="text-left px-4 py-3 font-medium text-gray-600">Name</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Description</th>
              <th className="text-right px-4 py-3 font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody>
            {ov.patterns.map(p => (
              <tr key={p.name} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-xs font-medium text-gray-800">{p.name}<Err text={p.error} /></td>
                <td className="px-4 py-3 text-gray-600 text-xs max-w-[420px] truncate" title={p.description}>{p.description || '—'}</td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <button onClick={() => { setEdit(p); setFormError(''); setShowNew(false); }} className="p-1.5 text-gray-400 hover:text-blue-600"><Pencil size={16} /></button>
                  <button onClick={() => remove(p)} className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 size={16} /></button>
                </td>
              </tr>
            ))}
            {ov.patterns.length === 0 && <tr><td colSpan={3} className="px-4 py-8 text-center text-gray-400">No patterns</td></tr>}
          </tbody>
        </table>
      </div>
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
      onError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  return (
    <Modal title={item ? `Edit pattern ${item.name}` : 'New pattern'} onClose={onClose} onSubmit={submit} error={error} wide>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextField label="Name (file, ^[a-z0-9-]+$)" value={name} onChange={setName} mono />
        <TextField label="Description" value={description} onChange={setDescription} />
      </div>
      <BodyField value={body} onChange={setBody} rows={14} />
    </Modal>
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
    } catch {
      /* backend down — status shows it */
    }
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
      setOutput(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  const loadLogs = useCallback(async () => {
    try {
      const r = await api.getAgentBackendLogs(logService || undefined, logTail, logTs, logGrep || undefined);
      setLog(r.log);
    } catch (e) {
      setLog(e instanceof Error ? e.message : 'Failed');
    }
  }, [logService, logTail, logTs, logGrep]);

  useEffect(() => { loadLogs(); }, [loadLogs]);
  useEffect(() => {
    if (!logLive) return;
    const t = setInterval(loadLogs, 3000);
    return () => clearInterval(t);
  }, [logLive, loadLogs]);
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [log]);

  const toggleProfile = (p: string) =>
    setProfiles(profiles.includes(p) ? profiles.filter(x => x !== p) : [...profiles, p]);

  return (
    <div className="space-y-4">
      <div className="bg-gray-100 rounded-xl border border-gray-200 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-800 flex items-center gap-2">
            <Server size={18} /> Compose services
            {!st?.compose_available && <span className="text-xs text-red-500 font-normal">docker compose unavailable</span>}
          </h3>
          <button onClick={load} className="p-1.5 text-gray-400 hover:text-blue-600"><RefreshCw size={16} /></button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mb-3">
          {(st?.services || []).map(s => (
            <div key={s.name} className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
              <p className="font-mono text-xs font-medium text-gray-800">{s.name}</p>
              <p className="text-[11px] text-gray-500">{s.state}{s.health ? ` (${s.health})` : ''}</p>
            </div>
          ))}
          {(st?.services.length || 0) === 0 && <p className="text-xs text-gray-400">No containers (or compose unavailable)</p>}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-1.5 text-xs text-gray-600">
            <input type="checkbox" checked={profiles.includes('rag')} onChange={() => toggleProfile('rag')} className="rounded" /> rag (tei)
          </label>
          <label className="flex items-center gap-1.5 text-xs text-gray-600">
            <input type="checkbox" checked={profiles.includes('onec')} onChange={() => toggleProfile('onec')} className="rounded" /> onec (mcp-proxy)
          </label>
          <span className="flex-1" />
          <button disabled={busy} onClick={() => run(() => api.agentBackendUp([], profiles))}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs hover:bg-green-700 disabled:opacity-40">
            <Play size={14} /> Start
          </button>
          <button disabled={busy} onClick={() => run(() => api.agentBackendStop([]), 'Stop all agent-backend containers? (data volumes are kept)')}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-200 text-gray-700 rounded-lg text-xs hover:bg-gray-300 disabled:opacity-40">
            <Square size={14} /> Stop all
          </button>
          <button disabled={busy} onClick={() => run(() => api.agentBackendRestart(['backend']), 'Restart the backend container? In-flight chat requests will fail.')}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-200 text-gray-700 rounded-lg text-xs hover:bg-gray-300 disabled:opacity-40">
            <RotateCcw size={14} /> Restart backend
          </button>
        </div>
        {output && <pre className="mt-3 text-[11px] font-mono text-gray-600 bg-gray-900 text-green-400 rounded-lg p-3 max-h-48 overflow-y-auto whitespace-pre-wrap">{output}</pre>}
      </div>

      <div className="bg-gray-100 rounded-xl border border-gray-200 p-4">
        <h3 className="font-semibold text-gray-800 mb-2">Backend API ({st?.backend_url})</h3>
        <p className="text-xs text-gray-600 mb-2">
          Reachable: {st?.backend_reachable ? <span className="text-green-500 font-medium">yes</span> : <span className="text-red-500 font-medium">no</span>}
          {live && (
            <span className="ml-3">
              live agents: <span className="font-mono">{live.agents.join(', ') || '—'}</span>
              {' '}· live skills: <span className="font-mono">{live.skills.length}</span>
            </span>
          )}
        </p>
        {live && live.errors.length > 0 && (
          <div className="text-[11px] text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            Backend reports broken files: {live.errors.join('; ')}
          </div>
        )}
      </div>

      <div className="bg-gray-100 rounded-xl border border-gray-200 p-4">
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <h3 className="font-semibold text-gray-800">Logs</h3>
          <select value={logService} onChange={e => setLogService(e.target.value)}
            className="px-2 py-1 text-xs border border-gray-300 rounded-lg bg-gray-50 text-gray-700">
            <option value="">all services</option>
            <option value="backend">backend</option>
            <option value="postgres">postgres</option>
            <option value="tei">tei</option>
            <option value="mcp-proxy">mcp-proxy</option>
          </select>
          <select value={logTail} onChange={e => setLogTail(Number(e.target.value))}
            className="px-2 py-1 text-xs border border-gray-300 rounded-lg bg-gray-50 text-gray-700" title="Lines to fetch">
            {[100, 200, 500, 1000].map(n => <option key={n} value={n}>tail {n}</option>)}
          </select>
          <label className="flex items-center gap-1 text-xs text-gray-600" title="docker --timestamps">
            <input type="checkbox" checked={logTs} onChange={e => setLogTs(e.target.checked)} className="rounded" /> ts
          </label>
          <input type="text" value={logGrep} onChange={e => setLogGrep(e.target.value)} placeholder="grep…" title="case-insensitive filter"
            className="px-2 py-1 text-xs border border-gray-300 rounded-lg bg-gray-50 text-gray-700 w-40" />
          <button onClick={() => setLogLive(v => !v)} title={logLive ? 'Pause live tail' : 'Resume live tail'}
            className="flex items-center gap-1.5 px-3 py-1 text-xs text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-200">
            {logLive ? <Pause size={12} /> : <Play size={12} />} {logLive ? 'Live' : 'Paused'}
          </button>
          <button onClick={loadLogs} className="flex items-center gap-1.5 px-3 py-1 text-xs text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-200">
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
        <div className="relative">
          <pre className="text-[11px] font-mono text-green-400 bg-gray-900 rounded-lg p-3 max-h-[60vh] overflow-y-auto whitespace-pre-wrap">{log || 'No logs'}</pre>
          <div ref={logEndRef} />
        </div>
      </div>
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
      setMsg(e instanceof Error ? e.message : 'Load failed');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save(key: string) {
    const value = editing[key] ?? '';
    if (!confirm(`Write ${key} to the project .env? Backend restart is required to apply.`)) return;
    setMsg('');
    try {
      await api.putAgentEnv(key, value);
      setMsg(`${key} saved — restart the backend container to apply.`);
      setEditing(prev => { const n = { ...prev }; delete n[key]; return n; });
      setRevealed(prev => ({ ...prev, [key]: false }));
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Save failed');
    }
  }

  return (
    <div>
      <p className="text-xs text-gray-500 mb-3">
        Project <span className="font-mono">.env</span> (allowlisted keys only). Secrets are masked — enter a new value to replace, empty editor keeps the stored value.
      </p>
      {msg && <p className="text-xs text-gray-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 mb-3">{msg}</p>}
      <div className="bg-gray-100 rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="text-left px-4 py-3 font-medium text-gray-600">Key</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Value</th>
              <th className="text-right px-4 py-3 font-medium text-gray-600">Action</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(e => {
              const isEditing = editing[e.key] !== undefined;
              const showSecret = revealed[e.key];
              return (
                <tr key={e.key} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-2.5 font-mono text-xs text-gray-800">
                    {e.key}
                    {!e.present && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-500">absent</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    {isEditing ? (
                      <input type={e.masked && !showSecret ? 'password' : 'text'}
                        value={editing[e.key]} autoFocus
                        onChange={ev => setEditing(prev => ({ ...prev, [e.key]: ev.target.value }))}
                        placeholder={e.masked ? '(leave empty to keep)' : e.value || ''}
                        className="w-full px-2 py-1 border border-gray-300 rounded text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    ) : (
                      <span className="font-mono text-xs text-gray-600">
                        {e.masked ? (e.present ? '***' : '—') : (e.value || '—')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    {isEditing ? (
                      <>
                        <button onClick={() => save(e.key)} className="px-3 py-1 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 mr-1">Save</button>
                        <button onClick={() => setEditing(prev => { const n = { ...prev }; delete n[e.key]; return n; })}
                          className="px-3 py-1 text-xs text-gray-500 hover:text-gray-800">Cancel</button>
                      </>
                    ) : (
                      <>
                        {e.masked && e.present && (
                          <button onClick={() => setEditing(prev => ({ ...prev, [e.key]: '' }))}
                            className="px-2 py-1 text-xs text-gray-500 hover:text-gray-800 mr-1">Replace</button>
                        )}
                        <button onClick={() => setEditing(prev => ({ ...prev, [e.key]: e.masked ? '' : (e.value || '') }))}
                          className="p-1.5 text-gray-400 hover:text-blue-600"><Pencil size={14} /></button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
