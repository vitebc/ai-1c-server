import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Plus, Trash2, CheckCircle, XCircle, Download, Upload } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, authFetch } from '../api/client';
import type { Skill } from '../types';
import { t } from '../i18n';
import { PageHeader, Card, CardBody, Btn, Field, TextInput, TextArea, Alert } from '../components/ui';

export default function Skills() {
  const [items, setItems] = useState<Skill[]>([]);
  const [selected, setSelected] = useState<Skill | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  useEffect(() => { load(); }, []);
  function load() { api.getSkills().then(setItems).catch(() => {}); }

  async function handleExport() {
    try {
      const r = await authFetch('/skills/export');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'skills.zip';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setImportResult(`Ошибка экспорта: ${e instanceof Error ? e.message : 'неизвестная ошибка'}`);
    }
  }

  async function handleFolderPick(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setImporting(true);
    setImportResult(null);
    const mdFiles: { path: string; content: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.name.endsWith('.md')) continue;
      mdFiles.push({ path: file.webkitRelativePath || file.name, content: await file.text() });
    }
    try {
      const r = await authFetch('/skills/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: mdFiles }),
      });
      const data = await r.json();
      const errs = data.errors?.length ? `\nОшибки: ${data.errors.join('; ')}` : '';
      setImportResult(`Импортировано: ${data.imported}, пропущено: ${data.skipped}${errs}`);
      load();
    } catch (e) {
      setImportResult(`Ошибка: ${e instanceof Error ? e.message : 'неизвестная ошибка'}`);
    } finally {
      setImporting(false);
      if (folderRef.current) folderRef.current.value = '';
    }
  }

  // Группировка по категориям
  const grouped = new Map<string, Skill[]>();
  for (const s of items) {
    const cat = s.category || t.skills.uncategorized;
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(s);
  }
  const sortedGroups = Array.from(grouped.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  const isError = importResult != null && /^(ошибка|error|export error)/i.test(importResult.trim());

  return (
    <div>
      <PageHeader
        title={t.skills.title}
        hint={`${items.length}`}
        right={
          <>
            <Btn variant="outline" onClick={handleExport}>
              <Download size={15} /> {t.skills.export}
            </Btn>
            <input
              type="file"
              ref={folderRef}
              onChange={handleFolderPick}
              multiple
              style={{ display: 'none' }}
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            />
            <Btn variant="outline" onClick={() => folderRef.current?.click()} disabled={importing}>
              <Upload size={15} /> {t.skills.import}
            </Btn>
            <Btn variant="primary" onClick={() => { setSelected(null); setShowForm(true); }}>
              <Plus size={15} /> {t.skills.add}
            </Btn>
          </>
        }
      />

      {importResult && (
        <div className="mb-4">
          <Alert tone={isError ? 'red' : 'green'}>
            <span className="inline-flex items-start gap-1.5" style={{ whiteSpace: 'pre-wrap' }}>
              {isError ? <XCircle size={15} className="shrink-0 mt-px" /> : <CheckCircle size={15} className="shrink-0 mt-px" />}
              <span>{importResult}</span>
            </span>
          </Alert>
        </div>
      )}

      <div className="flex gap-6">
        <div className="w-72 shrink-0 space-y-1 overflow-y-auto max-h-[calc(100vh-12rem)]">
          {sortedGroups.map(([cat, skills]) => (
            <div key={cat}>
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide px-3 py-2 mt-2 first:mt-0">
                {cat} <span className="text-slate-500 dark:text-slate-500 font-normal">({skills.length})</span>
              </div>
              {skills.map(s => (
                <button
                  key={s.id}
                  onClick={() => { setSelected(s); setShowForm(false); }}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors cursor-pointer ${
                    selected?.id === s.id
                      ? 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                      : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                  }`}
                >
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-slate-400 mt-0.5 font-mono">{s.tool_name}</div>
                </button>
              ))}
            </div>
          ))}
          {items.length === 0 && (
            <p className="text-sm text-slate-400 px-3 py-8 text-center">{t.skills.noSkills}</p>
          )}
        </div>

        <div className="flex-1 min-w-0">
          {showForm ? (
            <SkillForm item={selected} onClose={() => setShowForm(false)} onSaved={() => { load(); setShowForm(false); }} />
          ) : selected ? (
            <SkillDetail key={selected.id} skill={selected} onSaved={() => { load(); }} onDeleted={() => { setSelected(null); load(); }} />
          ) : (
            <Card>
              <CardBody className="p-8 text-center text-slate-400 dark:text-slate-500">
                <p className="text-sm">{t.skills.selectHint}</p>
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Skill Detail / Editor ─────────────────────────────────

function SkillDetail({ skill, onSaved, onDeleted }: { skill: Skill; onSaved: () => void; onDeleted: () => void }) {
  const [form, setForm] = useState({
    name: skill.name,
    tool_name: skill.tool_name,
    tool_schema: skill.tool_schema,
    instruction: skill.instruction || '',
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
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm(t.skills.deleteConfirm)) return;
    await api.deleteSkill(skill.id);
    onDeleted();
  }

  const set = (k: keyof typeof form) => (v: string) => setForm(f => ({ ...f, [k]: v }));

  return (
    <Card>
      <CardBody className="p-6 space-y-6">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{skill.name}</h3>
          <Btn variant="danger-outline" onClick={handleDelete}>
            <Trash2 size={14} /> {t.common.delete}
          </Btn>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Field label={t.skills.name}><TextInput value={form.name} onChange={e => set('name')(e.target.value)} /></Field>
          <Field label={t.skills.toolName}><TextInput value={form.tool_name} onChange={e => set('tool_name')(e.target.value)} mono /></Field>
          <Field label={t.skills.serverId}><TextInput value={form.server_id} onChange={e => set('server_id')(e.target.value)} mono /></Field>
          <Field label={t.skills.category}><TextInput value={form.category} onChange={e => set('category')(e.target.value)} /></Field>
          <Field label={t.skills.version}><TextInput value={form.version} onChange={e => set('version')(e.target.value)} mono /></Field>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-[13px] text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))}
                className="rounded accent-blue-600"
              />
              {t.common.enabled}
            </label>
          </div>
        </div>

        <Field label={t.skills.description}>
          <TextArea value={form.description} onChange={e => set('description')(e.target.value)} rows={2} />
        </Field>

        <Field label={t.skills.instruction}>
          <div className="grid grid-cols-2 gap-4">
            <TextArea
              value={form.instruction}
              onChange={e => set('instruction')(e.target.value)}
              rows={24}
              mono
              className="resize-none"
            />
            <div className="md-preview border border-slate-300 dark:border-slate-700 rounded-lg p-3 overflow-y-auto max-h-[580px] bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-300">
              <Markdown remarkPlugins={[remarkGfm]}>{form.instruction || '*Нет содержимого*'}</Markdown>
            </div>
          </div>
        </Field>

        <Field label={t.skills.schema}>
          <TextArea value={form.tool_schema} onChange={e => set('tool_schema')(e.target.value)} rows={4} mono />
        </Field>

        <div className="flex justify-end">
          <Btn variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? t.common.saving : t.common.save}
          </Btn>
        </div>
      </CardBody>
    </Card>
  );
}

// ─── Add Skill Form ────────────────────────────────────────

function SkillForm({ item, onClose, onSaved }: { item?: Skill | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: item?.name || '',
    tool_name: item?.tool_name || '',
    tool_schema: item?.tool_schema || '{}',
    instruction: item?.instruction || '',
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
      await api.updateSkill(item.id, {
        ...form,
        server_id: form.server_id || null,
        category: form.category || null,
        version: form.version || null,
        description: form.description || null,
        metadata: form.metadata || null,
      });
    } else {
      await api.createSkill(form);
    }
    onSaved();
    onClose();
  }

  const set = (k: keyof typeof form) => (v: string) => setForm(f => ({ ...f, [k]: v }));

  return (
    <Card>
      <CardBody className="p-6">
        <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100 mb-6">{t.skills.add}</h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label={t.skills.name}><TextInput value={form.name} onChange={e => set('name')(e.target.value)} required /></Field>
            <Field label={t.skills.toolName}><TextInput value={form.tool_name} onChange={e => set('tool_name')(e.target.value)} required mono /></Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t.skills.serverId}><TextInput value={form.server_id} onChange={e => set('server_id')(e.target.value)} mono /></Field>
            <Field label={t.skills.category}><TextInput value={form.category} onChange={e => set('category')(e.target.value)} /></Field>
          </div>
          <Field label={t.skills.description}>
            <TextArea value={form.description} onChange={e => set('description')(e.target.value)} rows={2} />
          </Field>
          <Field label={t.skills.instruction}>
            <div className="grid grid-cols-2 gap-4">
              <TextArea
                value={form.instruction}
                onChange={e => set('instruction')(e.target.value)}
                rows={24}
                mono
                className="resize-none"
              />
              <div className="md-preview border border-slate-300 dark:border-slate-700 rounded-lg p-3 overflow-y-auto max-h-[580px] bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-300">
                <Markdown remarkPlugins={[remarkGfm]}>{form.instruction || '*Нет содержимого*'}</Markdown>
              </div>
            </div>
          </Field>
          <Field label={t.skills.schema}>
            <TextArea value={form.tool_schema} onChange={e => set('tool_schema')(e.target.value)} rows={4} mono />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label={t.skills.version}><TextInput value={form.version} onChange={e => set('version')(e.target.value)} mono /></Field>
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 text-[13px] text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))}
                  className="rounded accent-blue-600"
                />
                {t.common.enabled}
              </label>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Btn variant="ghost" type="button" onClick={onClose}>{t.common.cancel}</Btn>
            <Btn variant="primary" type="submit">{item ? t.common.save : t.common.create}</Btn>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
