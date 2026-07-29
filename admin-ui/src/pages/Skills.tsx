import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, CheckCircle, XCircle, FolderOpen } from 'lucide-react';
import { api } from '../api/client';
import type { Skill } from '../types';

export default function Skills() {
  const [items, setItems] = useState<Skill[]>([]);
  const [selected, setSelected] = useState<Skill | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const BASE = import.meta.env.VITE_API_BASE || '';

  useEffect(() => { load(); }, []);
  function load() { api.getSkills().then(setItems); }

  async function handleFolderPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setImporting(true); setImportResult(null);
    const mdFiles: { path: string; content: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.name.endsWith('.md')) continue;
      mdFiles.push({ path: file.webkitRelativePath || file.name, content: await file.text() });
    }
    try {
      const r = await fetch(`${BASE}/api/admin/skills/upload`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: mdFiles }),
      });
      const data = await r.json();
      const errs = data.errors?.length ? `\nErrors: ${data.errors.join('; ')}` : '';
      setImportResult(`Imported: ${data.imported}, skipped: ${data.skipped}${errs}`);
      load();
    } catch (e: any) { setImportResult(`Error: ${e.message}`);
    } finally { setImporting(false); if (folderRef.current) folderRef.current.value = ''; }
  }

  // Group by category
  const grouped = new Map<string, Skill[]>();
  for (const s of items) {
    const cat = s.category || 'Uncategorized';
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(s);
  }
  const sortedGroups = Array.from(grouped.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-800">Skills</h2>
        <div className="flex gap-2">
          <input type="file" ref={folderRef} onChange={handleFolderPick} multiple
            // @ts-ignore
            style={{ display: 'none' }} webkitdirectory="" directory="" />
          <button onClick={() => folderRef.current?.click()} disabled={importing}
            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-400 border border-gray-300 rounded-lg hover:bg-gray-200 disabled:opacity-50">
            <FolderOpen size={16} /> Import
          </button>
          <button onClick={() => { setSelected(null); setShowForm(true); }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-500 transition-colors">
            <Plus size={16} /> Add Skill
          </button>
        </div>
      </div>

      {importResult && (
        <div className={`mb-4 p-3 rounded-xl text-sm ${importResult.startsWith('Error') ? 'bg-red-50 text-red-400 border border-red-300' : 'bg-green-50 text-green-500 border border-green-300'}`}
          style={{ whiteSpace: 'pre-wrap' }}>
          {importResult.startsWith('Error') ? <XCircle size={16} className="inline mr-1" /> : <CheckCircle size={16} className="inline mr-1" />}
          {importResult}
        </div>
      )}

      <div className="flex gap-6">
        {/* Left: grouped skill list */}
        <div className="w-80 shrink-0 space-y-1 overflow-y-auto max-h-[calc(100vh-12rem)]">
          {sortedGroups.map(([cat, skills]) => (
            <div key={cat}>
              <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide px-3 py-2 mt-2 first:mt-0">
                {cat} <span className="text-gray-500 font-normal">({skills.length})</span>
              </div>
              {skills.map(s => (
                <button
                  key={s.id}
                  onClick={() => { setSelected(s); setShowForm(false); }}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                    selected?.id === s.id
                      ? 'bg-blue-50 text-blue-500'
                      : 'text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-gray-400 mt-0.5 font-mono">{s.tool_name}</div>
                </button>
              ))}
            </div>
          ))}
          {items.length === 0 && (
            <p className="text-sm text-gray-400 px-3 py-8 text-center">No skills. Import or add one.</p>
          )}
        </div>

        {/* Right: detail / editor */}
        <div className="flex-1 min-w-0">
          {showForm ? (
            <SkillForm item={selected} onClose={() => setShowForm(false)} onSaved={() => { load(); setShowForm(false); }} />
          ) : selected ? (
            <SkillDetail key={selected.id} skill={selected} onSaved={() => { load(); }} onDeleted={() => { setSelected(null); load(); }} />
          ) : (
            <div className="bg-gray-100 rounded-xl border border-gray-200 p-8 text-center text-gray-400">
              <p>Select a skill from the list to edit</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SkillDetail({ skill, onSaved, onDeleted }: { skill: Skill; onSaved: () => void; onDeleted: () => void }) {
  const [form, setForm] = useState({
    name: skill.name,
    tool_name: skill.tool_name,
    tool_schema: skill.tool_schema,
    server_id: skill.server_id || '',
    category: skill.category || '',
    version: skill.version || '',
    enabled: skill.enabled,
    description: skill.description || '',
    metadata: skill.metadata || '',
  });
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await api.updateSkill(skill.id, {
        ...form,
        server_id: form.server_id || null,
        category: form.category || null,
        version: form.version || null,
        description: form.description || null,
        metadata: form.metadata || null,
      });
      onSaved();
    } finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!confirm('Delete this skill?')) return;
    await api.deleteSkill(skill.id);
    onDeleted();
  }

  return (
    <div className="bg-gray-100 rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-lg font-semibold text-gray-800">{skill.name}</h3>
        <div className="flex gap-2">
          <button onClick={handleDelete} className="flex items-center gap-1 px-3 py-1.5 text-xs text-red-500 border border-red-300 rounded-lg hover:bg-red-50">
            <Trash2 size={14} /> Delete
          </button>
        </div>
      </div>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} />
          <Field label="Tool Name" value={form.tool_name} onChange={v => setForm(f => ({ ...f, tool_name: v }))} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Server ID" value={form.server_id} onChange={v => setForm(f => ({ ...f, server_id: v }))} />
          <Field label="Category" value={form.category} onChange={v => setForm(f => ({ ...f, category: v }))} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
          <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Tool Schema (JSON)</label>
          <textarea value={form.tool_schema} onChange={e => setForm(f => ({ ...f, tool_schema: e.target.value }))}
            rows={5}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Version" value={form.version} onChange={v => setForm(f => ({ ...f, version: v }))} />
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} className="rounded" />
              Enabled
            </label>
          </div>
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-500 disabled:opacity-50 transition-colors">
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
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
    <div className="bg-gray-100 rounded-xl border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-800 mb-6">{item ? 'Edit Skill' : 'New Skill'}</h3>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} />
          <Field label="Tool Name" value={form.tool_name} onChange={v => setForm(f => ({ ...f, tool_name: v }))} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Server ID" value={form.server_id} onChange={v => setForm(f => ({ ...f, server_id: v }))} />
          <Field label="Category" value={form.category} onChange={v => setForm(f => ({ ...f, category: v }))} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
          <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Tool Schema (JSON)</label>
          <textarea value={form.tool_schema} onChange={e => setForm(f => ({ ...f, tool_schema: e.target.value }))}
            rows={5}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Version" value={form.version} onChange={v => setForm(f => ({ ...f, version: v }))} />
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} className="rounded" />
              Enabled
            </label>
          </div>
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-400 border border-gray-300 rounded-lg hover:bg-gray-200">Cancel</button>
          <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-500">{item ? 'Save' : 'Create'}</button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input type="text" value={value} onChange={e => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
    </div>
  );
}
