import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, RotateCcw, Copy, Check, FolderOpen, BarChart3, X, DatabaseZap } from 'lucide-react';
import { api } from '../api/client';
import { copyText } from '../clipboard';
import FileBrowser from '../components/FileBrowser';
import type { McpServer, ServerStatus } from '../types';

const SERVER_TYPES = ['custom', 'local', 'remote', 'builtin'];
const TRANSPORTS = ['stdio', 'sse', 'http'];

export default function McpServers() {
  const [items, setItems] = useState<McpServer[]>([]);
  const [live, setLive] = useState<Record<string, string>>({});
  const [edit, setEdit] = useState<McpServer | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState('');
  const [statsFor, setStatsFor] = useState<McpServer | null>(null);
  const [opMsg, setOpMsg] = useState('');

  useEffect(() => { load(); }, []);

  function load() {
    api.getMcpServers().then(setItems);
    api.getStatus().then(s => {
      const map: Record<string, string> = {};
      (s as ServerStatus[]).forEach(x => { map[x.id] = x.status; });
      setLive(map);
    }).catch(() => {});
  }

  function openCreate() { setEdit(null); setShowForm(true); }

  function openEdit(item: McpServer) { setEdit(item); setShowForm(true); }

  async function handleDelete(id: string) {
    if (!confirm('Delete this server?')) return;
    await api.deleteMcpServer(id);
    load();
  }

  async function handleRestart(id: string) {
    await api.restartMcpServer(id);
    load();
  }

  async function handleReindex(item: McpServer) {
    if (!confirm(`Full reindex of "${item.name}"? Index files will be deleted and rebuilt in background (may take minutes).`)) return;
    setOpMsg('');
    try {
      const res = await api.reindexMcp(item.id);
      setOpMsg(`Reindex started for "${item.name}": ${res.deleted.length} index file(s) removed, rebuilding in background.`);
      load();
    } catch (e) {
      setOpMsg(e instanceof Error ? `Reindex failed: ${e.message}` : 'Reindex failed');
    }
  }

  async function copyExport(format: string) {
    setCopyError('');
    try {
      const data = await api.exportMcpConfig(format, window.location.origin);
      await copyText(JSON.stringify(data, null, 2));
      setCopied(format);
      setTimeout(() => setCopied(null), 1500);
    } catch (e) {
      setCopyError(e instanceof Error ? e.message : 'Copy failed');
    }
  }

  const aggUrl = `${window.location.origin}/api/mcp-aggregated/mcp`;
  const formats = [
    { key: 'opencode', label: 'opencode' },
    { key: 'opencode-legacy', label: 'opencode-legacy' },
    { key: 'claude', label: 'Claude Code' },
    { key: 'cursor', label: 'Cursor' },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-800">MCP Servers</h2>
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors">
          <Plus size={16} /> Add Server
        </button>
      </div>

      {showForm && (
        <ServerForm item={edit} onClose={() => setShowForm(false)} onSaved={load} />
      )}
      {statsFor && (
        <StatsModal item={statsFor} onClose={() => setStatsFor(null)} />
      )}
      {opMsg && (
        <p className={`text-xs px-3 py-2 rounded-lg border mb-4 ${opMsg.startsWith('Reindex failed') ? 'text-red-600 bg-red-50 border-red-200' : 'text-green-600 bg-green-50 border-green-200'}`}>{opMsg}</p>
      )}

      <div className="bg-gray-100 rounded-xl border border-gray-200 p-4 mb-4">
        <div className="text-sm font-medium text-gray-700 mb-1">Single entry point (all enabled servers)</div>
        <code className="block text-xs font-mono text-gray-600 bg-gray-50 border border-gray-200 rounded px-2 py-1.5 mb-3 break-all">{aggUrl}</code>
        <div className="flex flex-wrap gap-2">
          {formats.map(f => (
            <button key={f.key} onClick={() => copyExport(f.key)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-700 hover:bg-gray-200 transition-colors">
              {copied === f.key ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
              Copy {f.label}.json
            </button>
          ))}
        </div>
        {copyError && <p className="text-xs text-red-600 mt-2">{copyError}</p>}
      </div>

      <div className="bg-gray-100 rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="text-left px-4 py-3 font-medium text-gray-600">Name</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Type</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Transport</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Command</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
              <th className="text-right px-4 py-3 font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-800">{item.name}</td>
                <td className="px-4 py-3 text-gray-600">{item.server_type}</td>
                <td className="px-4 py-3 text-gray-600">{item.transport}</td>
                <td className="px-4 py-3 text-gray-600 font-mono text-xs">{item.command || '-'}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${item.enabled ? 'bg-green-50 text-green-500' : 'bg-gray-200 text-gray-400'}`}>
                    {item.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  {item.enabled && live[item.id] && (
                    <span className={`ml-1.5 text-xs px-2 py-0.5 rounded-full ${live[item.id] === 'running' ? 'bg-green-600 text-white' : 'bg-red-100 text-red-600'}`}>
                      {live[item.id]}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {item.server_type.startsWith('search') && (
                    <button title="Index stats" onClick={() => setStatsFor(item)} className="p-1.5 text-gray-400 hover:text-purple-500 transition-colors"><BarChart3 size={16} /></button>
                  )}
                  {item.server_type.startsWith('search') && (
                    <button title="Full reindex (deletes index, rebuilds in background)" onClick={() => handleReindex(item)} className="p-1.5 text-gray-400 hover:text-orange-500 transition-colors"><DatabaseZap size={16} /></button>
                  )}
                  <button title="Restart (hot-reload)" onClick={() => handleRestart(item.id)} className="p-1.5 text-gray-400 hover:text-green-600 transition-colors"><RotateCcw size={16} /></button>
                  <button onClick={() => openEdit(item)} className="p-1.5 text-gray-400 hover:text-blue-600 transition-colors"><Pencil size={16} /></button>
                  <button onClick={() => handleDelete(item.id)} className="p-1.5 text-gray-400 hover:text-red-600 transition-colors"><Trash2 size={16} /></button>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No servers configured</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ServerForm({ item, onClose, onSaved }: { item?: McpServer | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: item?.name || '',
    server_type: item?.server_type || 'custom',
    transport: item?.transport || 'stdio',
    command: item?.command || '',
    args: item?.args || '',
    env: item?.env || '',
    url: item?.url || '',
    enabled: item?.enabled ?? true,
    description: item?.description || '',
    config: item?.config || '',
  });
  const [browse, setBrowse] = useState(false);
  const [submitError, setSubmitError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError('');
    const payload = {
      ...form,
      command: form.command || null,
      args: form.args.trim() ? form.args : null,
      env: form.env.trim() ? form.env : null,
      url: form.url || null,
      description: form.description || null,
      config: form.config || null,
    };
    try {
      if (item) await api.updateMcpServer(item.id, payload);
      else await api.createMcpServer(payload as any);
      onSaved();
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-100 rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <h3 className="text-lg font-semibold text-gray-800">{item ? 'Edit Server' : 'Add Server'}</h3>
          <Field label="Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} required />
          <div className="grid grid-cols-2 gap-3">
            <SelectField label="Type" value={form.server_type} options={SERVER_TYPES}
              onChange={v => setForm(f => ({ ...f, server_type: v }))} />
            <SelectField label="Transport" value={form.transport} options={TRANSPORTS}
              onChange={v => setForm(f => ({ ...f, transport: v }))} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Command</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={form.command}
                onChange={e => setForm(f => ({ ...f, command: e.target.value }))}
                placeholder="/path/to/mcp-binary"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <button type="button" onClick={() => setBrowse(true)}
                className="flex items-center gap-1.5 px-3 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm hover:bg-gray-300 transition-colors shrink-0">
                <FolderOpen size={16} /> Browse
              </button>
            </div>
          </div>
          <JsonField label="Args (JSON array)" value={form.args}
            onChange={v => setForm(f => ({ ...f, args: v }))}
            placeholder='["--port", "8080"]' kind="array" />
          <JsonField label="Env (JSON object)" value={form.env}
            onChange={v => setForm(f => ({ ...f, env: v }))}
            placeholder='{"KEY": "value"}' kind="object" />
          <Field label="URL" value={form.url} onChange={v => setForm(f => ({ ...f, url: v }))} placeholder="http://... (for http/sse transport)" />
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} className="rounded" />
            Enabled
          </label>
          {submitError && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{submitError}</p>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors">Cancel</button>
            <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors">
              {item ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
      {browse && (
        <FileBrowser
          initialPath={form.command.includes('/') ? form.command.slice(0, form.command.lastIndexOf('/')) || '/' : undefined}
          onPick={p => { setForm(f => ({ ...f, command: p })); setBrowse(false); }}
          onClose={() => setBrowse(false)}
        />
      )}
    </div>
  );
}

function Field({ label, value, onChange, required, placeholder }: { label: string; value: string; onChange: (v: string) => void; required?: boolean; placeholder?: string }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      />
    </div>
  );
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  const opts = options.includes(value) ? options : [...options, value];
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-gray-100 text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      >
        {opts.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

function JsonField({ label, value, onChange, placeholder, kind }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; kind: 'array' | 'object';
}) {
  const trimmed = value.trim();
  let error = '';
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      if (kind === 'array' && !Array.isArray(parsed)) error = 'Must be a JSON array';
      if (kind === 'object' && (Array.isArray(parsed) || typeof parsed !== 'object' || parsed === null)) error = 'Must be a JSON object';
    } catch (e) {
      error = e instanceof Error ? e.message : 'Invalid JSON';
    }
  }

  function format() {
    if (!trimmed || error) return;
    onChange(JSON.stringify(JSON.parse(trimmed), null, 2));
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-sm font-medium text-gray-700">{label}</label>
        <div className="flex items-center gap-2">
          {trimmed && !error && <span className="text-xs text-green-600">Valid JSON</span>}
          {error && <span className="text-xs text-red-600 max-w-[300px] truncate" title={error}>{error}</span>}
          <button type="button" onClick={format} disabled={!trimmed || !!error}
            className="text-xs px-2 py-0.5 text-gray-600 border border-gray-300 rounded hover:bg-gray-200 disabled:opacity-40 transition-colors">
            Format
          </button>
        </div>
      </div>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        spellCheck={false}
        className={`w-full px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent ${error ? 'border-red-400 bg-red-50/50' : 'border-gray-300'}`}
      />
    </div>
  );
}

function StatsModal({ item, onClose }: { item: McpServer; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getMcpStats(item.id)
      .then(r => setText(r.text || '(empty — index may still be building)'))
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load stats'));
  }, [item.id]);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-100 rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h4 className="text-sm font-semibold text-gray-800">Index stats: {item.name}</h4>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700 transition-colors"><X size={18} /></button>
        </div>
        <div className="p-4 overflow-y-auto">
          {error && <p className="text-xs text-red-600">{error}</p>}
          {!text && !error && <p className="text-sm text-gray-400">Loading…</p>}
          {text && <pre className="text-xs font-mono text-gray-700 bg-gray-50 border border-gray-200 rounded-lg p-3 whitespace-pre-wrap break-all">{text}</pre>}
        </div>
      </div>
    </div>
  );
}

