import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, RotateCcw, Copy, Check, FolderOpen, Folder, File, ChevronUp } from 'lucide-react';
import { api } from '../api/client';
import type { FsBrowseResult, McpServer, ServerStatus } from '../types';

const SERVER_TYPES = ['custom', 'local', 'remote', 'builtin'];
const TRANSPORTS = ['stdio', 'sse', 'http'];

export default function McpServers() {
  const [items, setItems] = useState<McpServer[]>([]);
  const [live, setLive] = useState<Record<string, string>>({});
  const [edit, setEdit] = useState<McpServer | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

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

  async function copyExport(format: string) {
    const data = await api.exportMcpConfig(format, window.location.origin);
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    setCopied(format);
    setTimeout(() => setCopied(null), 1500);
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
          initialPath={form.command.includes('/') ? form.command.slice(0, form.command.lastIndexOf('/')) || '/' : '/root'}
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

function FileBrowser({ initialPath, onPick, onClose }: { initialPath: string; onPick: (p: string) => void; onClose: () => void }) {
  const [data, setData] = useState<FsBrowseResult | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');

  function load(path: string) {
    setError('');
    setSelected(null);
    api.browseFs(path).then(setData).catch(e => setError(e instanceof Error ? e.message : 'Failed to list'));
  }

  useEffect(() => { load(initialPath); }, [initialPath]);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60]" onClick={onClose}>
      <div className="bg-gray-100 rounded-xl shadow-xl w-full max-w-xl mx-4 max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b border-gray-200">
          <h4 className="text-sm font-semibold text-gray-800 mb-2">Select binary</h4>
          <div className="flex items-center gap-2">
            {data?.parent && (
              <button type="button" onClick={() => load(data.parent!)} title="Up"
                className="p-1.5 text-gray-500 hover:text-gray-800 hover:bg-gray-200 rounded transition-colors">
                <ChevronUp size={16} />
              </button>
            )}
            <code className="flex-1 text-xs font-mono text-gray-600 bg-gray-50 border border-gray-200 rounded px-2 py-1.5 truncate">
              {data?.path || initialPath}
            </code>
          </div>
          {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
        </div>
        <div className="flex-1 overflow-y-auto p-2 min-h-[200px]">
          {data?.entries.map(e => (
            <button
              key={e.path}
              type="button"
              onClick={() => (e.is_dir ? load(e.path) : setSelected(e.path))}
              onDoubleClick={() => e.is_dir && load(e.path)}
              className={`flex items-center gap-2 w-full text-left px-3 py-1.5 rounded-lg text-sm transition-colors ${
                selected === e.path ? 'bg-blue-100 text-blue-700' : 'text-gray-700 hover:bg-gray-200'
              }`}
            >
              {e.is_dir
                ? <Folder size={16} className="text-yellow-600 shrink-0" />
                : <File size={16} className="text-gray-400 shrink-0" />}
              <span className="flex-1 truncate font-mono text-xs">{e.name}</span>
              {!e.is_dir && e.size != null && (
                <span className="text-[11px] text-gray-400 shrink-0">{formatSize(e.size)}</span>
              )}
            </button>
          ))}
          {data && data.entries.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-8">Empty directory</p>
          )}
        </div>
        <div className="p-4 border-t border-gray-200 flex items-center justify-between gap-3">
          <code className="flex-1 text-xs font-mono text-gray-600 truncate">{selected || 'No file selected'}</code>
          <div className="flex gap-2 shrink-0">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors">Cancel</button>
            <button type="button" onClick={() => selected && onPick(selected)} disabled={!selected}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-40 transition-colors">
              Select
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
