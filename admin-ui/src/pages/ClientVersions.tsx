import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import type { ClientVersion } from '../types';

export default function ClientVersions() {
  const [items, setItems] = useState<ClientVersion[]>([]);
  const [edit, setEdit] = useState<ClientVersion | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => { load(); }, []);
  function load() { api.getClientVersions().then(setItems); }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-800">Client Versions</h2>
        <button onClick={() => { setEdit(null); setShowForm(true); }} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
          <Plus size={16} /> Add Version
        </button>
      </div>
      {showForm && <VersionForm item={edit} onClose={() => setShowForm(false)} onSaved={load} />}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="text-left px-4 py-3 font-medium text-gray-600">Version</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Platform</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Required</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Created</th>
              <th className="text-right px-4 py-3 font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-800">{item.version}</td>
                <td className="px-4 py-3 text-gray-600">{item.platform}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${item.required ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}>
                    {item.required ? 'Required' : 'Optional'}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-600 text-xs">{item.created_at}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => { setEdit(item); setShowForm(true); }} className="p-1.5 text-gray-400 hover:text-blue-600"><Pencil size={16} /></button>
                  <button onClick={() => { if (confirm('Delete?')) api.deleteClientVersion(item.id).then(load); }} className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 size={16} /></button>
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">No versions</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VersionForm({ item, onClose, onSaved }: { item?: ClientVersion | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    version: item?.version || '',
    platform: item?.platform || 'windows',
    url: item?.url || '',
    checksum: item?.checksum || '',
    changelog: item?.changelog || '',
    required: item?.required ?? false,
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (item) {
      await api.updateClientVersion(item.id, { ...form, changelog: form.changelog || null });
    } else {
      await api.createClientVersion(form as any);
    }
    onSaved();
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4" onClick={e => e.stopPropagation()}>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <h3 className="text-lg font-semibold text-gray-800">{item ? 'Edit Version' : 'Add Version'}</h3>
          <Field label="Version" value={form.version} onChange={v => setForm(f => ({ ...f, version: v }))} required />
          <Field label="Platform" value={form.platform} onChange={v => setForm(f => ({ ...f, platform: v }))} required />
          <Field label="URL" value={form.url} onChange={v => setForm(f => ({ ...f, url: v }))} required />
          <Field label="Checksum" value={form.checksum} onChange={v => setForm(f => ({ ...f, checksum: v }))} required />
          <Field label="Changelog" value={form.changelog} onChange={v => setForm(f => ({ ...f, changelog: v }))} />
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.required} onChange={e => setForm(f => ({ ...f, required: e.target.checked }))} className="rounded" />
            Required update
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

function Field({ label, value, onChange, required }: { label: string; value: string; onChange: (v: string) => void; required?: boolean }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input type="text" value={value} onChange={e => onChange(e.target.value)} required={required}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
    </div>
  );
}
