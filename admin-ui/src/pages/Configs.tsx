import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, FolderOpen } from 'lucide-react';
import { api } from '../api/client';
import FileBrowser from '../components/FileBrowser';
import type { ConfigProfile } from '../types';

export default function Configs() {
  const [items, setItems] = useState<ConfigProfile[]>([]);
  const [edit, setEdit] = useState<ConfigProfile | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => { load(); }, []);
  function load() { api.getConfigProfiles().then(setItems); }

  const mains = items.filter(i => !i.parent_id);
  const parentName = (id: string | null) => mains.find(m => m.id === id)?.name || '?';

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-800">Config Profiles</h2>
        <button onClick={() => { setEdit(null); setShowForm(true); }} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
          <Plus size={16} /> Add Profile
        </button>
      </div>
      {showForm && <ConfigForm item={edit} mains={mains} onClose={() => setShowForm(false)} onSaved={load} />}
      <SearchSettings />
      <div className="bg-gray-100 rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="text-left px-4 py-3 font-medium text-gray-600">Name</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Path</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Parent</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Active</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Last Indexed</th>
              <th className="text-right px-4 py-3 font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-800">
                  {item.parent_id && <span className="text-gray-500 mr-1">↳</span>}{item.name}
                  {item.parent_id && <span className="ml-1.5 text-[11px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-500">extension</span>}
                </td>
                <td className="px-4 py-3 text-gray-600 font-mono text-xs">{item.path}</td>
                <td className="px-4 py-3 text-gray-600 text-xs">{item.parent_id ? parentName(item.parent_id) : '—'}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${item.active ? 'bg-green-50 text-green-500' : 'bg-gray-200 text-gray-400'}`}>
                    {item.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-600 text-xs">{item.last_indexed || '-'}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => { setEdit(item); setShowForm(true); }} className="p-1.5 text-gray-400 hover:text-blue-600"><Pencil size={16} /></button>
                  <button onClick={() => { if (confirm('Delete?')) api.deleteConfigProfile(item.id).then(load); }} className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 size={16} /></button>
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No profiles</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500 mt-3">
        Each main profile gets an auto <span className="font-mono">search-&lt;name&gt;</span> MCP row
        (env regenerated from profiles on every change). Extensions attach to a main profile.
        Active = row enabled = indexed.
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

  // A main with extensions cannot become an extension (server also enforces).
  const candidates = mains.filter(m => !item || m.id !== item.id);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const payload: any = { name, path, active };
    if (parentId) payload.parent_id = parentId;
    else if (item?.parent_id) payload.parent_id = null; // detach → main
    try {
      if (item) await api.updateConfigProfile(item.id, payload);
      else await api.createConfigProfile(payload);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-100 rounded-xl shadow-xl w-full max-w-lg mx-4" onClick={e => e.stopPropagation()}>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <h3 className="text-lg font-semibold text-gray-800">{item ? 'Edit Profile' : 'Add Profile'}</h3>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Path</label>
            <div className="flex gap-2">
              <input type="text" value={path} onChange={e => setPath(e.target.value)} required
                placeholder="/data/1c-src/erp"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <button type="button" onClick={() => setBrowse(true)}
                className="flex items-center gap-1.5 px-3 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm hover:bg-gray-300 transition-colors shrink-0">
                <FolderOpen size={16} /> Browse
              </button>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Parent (empty = main config)</label>
            <select value={parentId} onChange={e => setParentId(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-gray-100 text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="">— Main configuration —</option>
              {candidates.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} className="rounded" />
            Active
          </label>
          {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
            <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">{item ? 'Save' : 'Create'}</button>
          </div>
        </form>
      </div>
      {browse && (
        <FileBrowser
          dirsOnly
          title="Select configuration folder"
          initialPath={path || undefined}
          onPick={p => { setPath(p); setBrowse(false); }}
          onClose={() => setBrowse(false)}
        />
      )}
    </div>
  );
}

function SearchSettings() {
  const [binary, setBinary] = useState('');
  const [indexDir, setIndexDir] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
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
    <div className="bg-gray-100 rounded-xl border border-gray-200 p-4 mb-4">
      <div className="text-sm font-medium text-gray-700 mb-1">Search engine template</div>
      <p className="text-xs text-gray-500 mb-3">
        Binary used for auto <span className="font-mono">search-*</span> rows.
        Empty = reuse command from an enabled manual <span className="font-mono">search</span> row.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <input value={binary} onChange={e => setBinary(e.target.value)}
          placeholder="/path/to/mcp-1c-search"
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
        <div className="flex gap-2">
          <input value={indexDir} onChange={e => setIndexDir(e.target.value)}
            placeholder="index dir (default: data/search-index)"
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <button onClick={save} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors shrink-0">
            {saved ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
