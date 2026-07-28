import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import type { ConfigProfile } from '../types';

export default function Configs() {
  const [items, setItems] = useState<ConfigProfile[]>([]);
  const [edit, setEdit] = useState<ConfigProfile | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => { load(); }, []);
  function load() { api.getConfigProfiles().then(setItems); }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-800">Config Profiles</h2>
        <button onClick={() => { setEdit(null); setShowForm(true); }} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
          <Plus size={16} /> Add Profile
        </button>
      </div>
      {showForm && <ConfigForm item={edit} onClose={() => setShowForm(false)} onSaved={load} />}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="text-left px-4 py-3 font-medium text-gray-600">Name</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Path</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Active</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Last Indexed</th>
              <th className="text-right px-4 py-3 font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-800">{item.name}</td>
                <td className="px-4 py-3 text-gray-600 font-mono text-xs">{item.path}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${item.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
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
            {items.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">No profiles</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ConfigForm({ item, onClose, onSaved }: { item?: ConfigProfile | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(item?.name || '');
  const [path, setPath] = useState(item?.path || '');
  const [active, setActive] = useState(item?.active ?? false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (item) {
      await api.updateConfigProfile(item.id, { name, path, active });
    } else {
      await api.createConfigProfile({ name, path, active } as any);
    }
    onSaved();
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4" onClick={e => e.stopPropagation()}>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <h3 className="text-lg font-semibold text-gray-800">{item ? 'Edit Profile' : 'Add Profile'}</h3>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Path</label>
            <input type="text" value={path} onChange={e => setPath(e.target.value)} required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} className="rounded" />
            Active
          </label>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
            <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">{item ? 'Save' : 'Create'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
