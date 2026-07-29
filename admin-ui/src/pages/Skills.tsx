import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Upload, CheckCircle, XCircle } from 'lucide-react';
import { api } from '../api/client';
import type { Skill } from '../types';

const BASE = import.meta.env.VITE_API_BASE || '';

export default function Skills() {
  const [items, setItems] = useState<Skill[]>([]);
  const [edit, setEdit] = useState<Skill | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [importDir, setImportDir] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);

  useEffect(() => { load(); }, []);
  function load() { api.getSkills().then(setItems); }

  async function handleImport() {
    if (!importDir) return;
    setImporting(true);
    setImportResult(null);
    try {
      const r = await fetch(`${BASE}/api/admin/skills/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: importDir }),
      });
      const data = await r.json();
      const errs = data.errors?.length ? `, errors: ${data.errors.join('; ')}` : '';
      setImportResult(`Imported: ${data.imported}, skipped: ${data.skipped}${errs}`);
      load();
    } catch (e: any) {
      setImportResult(`Error: ${e.message}`);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-800">Skills</h2>
        <button onClick={() => { setEdit(null); setShowForm(true); }} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors">
          <Plus size={16} /> Add Skill
        </button>
      </div>

      <div className="bg-gray-100 rounded-xl border border-gray-200 p-4 mb-6">
        <h3 className="text-sm font-semibold text-gray-800 mb-3">Import from .md files</h3>
        <div className="flex items-center gap-3">
          <input type="text" value={importDir} onChange={e => setImportDir(e.target.value)}
            placeholder="Path to directory with .md skills"
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <button onClick={handleImport} disabled={importing || !importDir}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-500 disabled:opacity-50">
            <Upload size={16} /> {importing ? 'Importing...' : 'Import'}
          </button>
        </div>
        {importResult && (
          <div className={`mt-3 flex items-center gap-2 text-sm ${importResult.startsWith('Error') ? 'text-red-500' : 'text-green-500'}`}>
            {importResult.startsWith('Error') ? <XCircle size={16} /> : <CheckCircle size={16} />}
            {importResult}
          </div>
        )}
      </div>

      {showForm && <SkillForm item={edit} onClose={() => setShowForm(false)} onSaved={load} />}
      <div className="bg-gray-100 rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="text-left px-4 py-3 font-medium text-gray-600">Name</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Tool</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Server</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Category</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
              <th className="text-right px-4 py-3 font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-800">{item.name}</td>
                <td className="px-4 py-3 text-gray-600 font-mono text-xs">{item.tool_name}</td>
                <td className="px-4 py-3 text-gray-600">{item.server_id || '-'}</td>
                <td className="px-4 py-3 text-gray-600">{item.category || '-'}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${item.enabled ? 'bg-green-50 text-green-500' : 'bg-gray-200 text-gray-400'}`}>
                    {item.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => { setEdit(item); setShowForm(true); }} className="p-1.5 text-gray-400 hover:text-blue-600"><Pencil size={16} /></button>
                  <button onClick={() => { if (confirm('Delete?')) api.deleteSkill(item.id).then(load); }} className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 size={16} /></button>
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No skills</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SkillForm({ item, onClose, onSaved }: { item?: Skill | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: item?.name || '',
    tool_name: item?.tool_name || '',
    tool_schema: item?.tool_schema || '{}',
    server_id: item?.server_id || '',
    category: item?.category || '',
    version: item?.version || '',
    enabled: item?.enabled ?? true,
    description: item?.description || '',
    metadata: item?.metadata || '',
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (item) {
      await api.updateSkill(item.id, { ...form, server_id: form.server_id || null, category: form.category || null, version: form.version || null, description: form.description || null, metadata: form.metadata || null });
    } else {
      await api.createSkill(form as any);
    }
    onSaved();
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-100 rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <h3 className="text-lg font-semibold text-gray-800">{item ? 'Edit Skill' : 'Add Skill'}</h3>
          <Field label="Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} required />
          <Field label="Tool Name" value={form.tool_name} onChange={v => setForm(f => ({ ...f, tool_name: v }))} required />
          <Field label="Tool Schema (JSON)" value={form.tool_schema} onChange={v => setForm(f => ({ ...f, tool_schema: v }))} />
          <Field label="Server ID" value={form.server_id} onChange={v => setForm(f => ({ ...f, server_id: v }))} />
          <Field label="Category" value={form.category} onChange={v => setForm(f => ({ ...f, category: v }))} />
          <Field label="Version" value={form.version} onChange={v => setForm(f => ({ ...f, version: v }))} />
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} className="rounded" />
            Enabled
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
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
    </div>
  );
}
