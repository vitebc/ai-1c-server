import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import type { McpServer } from '../types';

export default function McpServers() {
  const [items, setItems] = useState<McpServer[]>([]);
  const [edit, setEdit] = useState<McpServer | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => { load(); }, []);

  function load() { api.getMcpServers().then(setItems); }

  function openCreate() { setEdit(null); setShowForm(true); }

  function openEdit(item: McpServer) { setEdit(item); setShowForm(true); }

  async function handleDelete(id: string) {
    if (!confirm('Delete this server?')) return;
    await api.deleteMcpServer(id);
    load();
  }

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
                </td>
                <td className="px-4 py-3 text-right">
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (item) {
      await api.updateMcpServer(item.id, { ...form, command: form.command || null, args: form.args || null, env: form.env || null, url: form.url || null, description: form.description || null, config: form.config || null });
    } else {
      await api.createMcpServer(form as any);
    }
    onSaved();
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-100 rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <h3 className="text-lg font-semibold text-gray-800">{item ? 'Edit Server' : 'Add Server'}</h3>
          <Field label="Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} required />
          <Field label="Type" value={form.server_type} onChange={v => setForm(f => ({ ...f, server_type: v }))} required />
          <Field label="Transport" value={form.transport} onChange={v => setForm(f => ({ ...f, transport: v }))} required />
          <Field label="Command" value={form.command} onChange={v => setForm(f => ({ ...f, command: v }))} placeholder="e.g. node server.js" />
          <Field label="Args (JSON)" value={form.args} onChange={v => setForm(f => ({ ...f, args: v }))} placeholder='["--port","8080"]' />
          <Field label="Env (JSON)" value={form.env} onChange={v => setForm(f => ({ ...f, env: v }))} placeholder='{"KEY":"value"}' />
          <Field label="URL" value={form.url} onChange={v => setForm(f => ({ ...f, url: v }))} placeholder="http://..." />
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} className="rounded" />
            Enabled
          </label>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors">Cancel</button>
            <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors">
              {item ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
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
