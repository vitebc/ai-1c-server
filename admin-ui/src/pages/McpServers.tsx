import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, RotateCcw, Copy, Check, FolderOpen, BarChart3, DatabaseZap, Wrench } from 'lucide-react';
import { api } from '../api/client';
import { copyText } from '../clipboard';
import FileBrowser from '../components/FileBrowser';
import type { McpServer, ServerStatus } from '../types';
import { t } from '../i18n';
import { PageHeader, Card, CardBody, Btn, IconBtn, Badge, StatusDot, TableShell, Th, Td, Row, Field, TextInput, TextArea, Select, Modal, Alert } from '../components/ui';

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
  const [toolsFor, setToolsFor] = useState<McpServer | null>(null);
  const [reindexJob, setReindexJob] = useState<{ jobId: string; name: string } | null>(null);
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
    if (!confirm(t.mcp.deleteConfirm)) return;
    await api.deleteMcpServer(id);
    load();
  }

  async function handleRestart(id: string) {
    await api.restartMcpServer(id);
    load();
  }

  async function handleReindex(item: McpServer) {
    if (!confirm(t.mcp.reindexConfirm(item.name))) return;
    setOpMsg('');
    try {
      const res = await api.reindexMcp(item.id);
      setReindexJob({ jobId: res.job_id, name: item.name });
    } catch (e) {
      setOpMsg(e instanceof Error ? `Ошибка переиндексации: ${e.message}` : 'Ошибка переиндексации');
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
      setCopyError(e instanceof Error ? e.message : 'Ошибка копирования');
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
      <PageHeader
        title={t.mcp.title}
        hint={`${items.length}`}
        right={<Btn variant="primary" onClick={openCreate}><Plus size={15} /> {t.mcp.add}</Btn>}
      />

      {showForm && (
        <ServerForm item={edit} onClose={() => setShowForm(false)} onSaved={load} />
      )}
      {statsFor && (
        <StatsModal item={statsFor} onClose={() => setStatsFor(null)} />
      )}
      {toolsFor && (
        <ToolsModal item={toolsFor} onClose={() => setToolsFor(null)} />
      )}
      {reindexJob && (
        <ReindexProgress
          jobId={reindexJob.jobId}
          name={reindexJob.name}
          onClose={() => { setReindexJob(null); load(); }}
        />
      )}
      {opMsg && (
        <div className="mb-4">
          <Alert tone={/fail|ошиб/i.test(opMsg) ? 'red' : 'green'}>{opMsg}</Alert>
        </div>
      )}

      <Card className="mb-4">
        <CardBody>
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-200 mb-2">{t.mcp.singlePoint}</div>
          <code className="block text-xs font-mono text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-2 py-1.5 mb-3 truncate">{aggUrl}</code>
          <div className="flex flex-wrap gap-2">
            {formats.map(f => (
              <Btn key={f.key} variant="outline" onClick={() => copyExport(f.key)} className="!px-2.5 !py-1.5 !text-xs">
                {copied === f.key ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
                {t.common.copy} {f.label}.json
              </Btn>
            ))}
          </div>
          {copyError && <p className="text-xs text-red-600 dark:text-red-400 mt-2">{copyError}</p>}
        </CardBody>
      </Card>

      <TableShell
        colSpan={6}
        empty={items.length === 0 ? { text: t.mcp.noServers } : null}
        head={<><Th>{t.mcp.name}</Th><Th>{t.mcp.type}</Th><Th>{t.mcp.transport}</Th><Th>{t.mcp.command}</Th><Th>{t.mcp.status}</Th><Th right>{t.common.actions}</Th></>}
      >
        {items.map(item => (
          <Row key={item.id}>
            <Td><span className="font-medium text-slate-800 dark:text-slate-100">{item.name}</span></Td>
            <Td><span className="text-slate-600 dark:text-slate-300">{item.server_type}</span></Td>
            <Td><span className="text-slate-600 dark:text-slate-300">{item.transport}</span></Td>
            <Td><span className="block font-mono text-xs text-slate-600 dark:text-slate-300 truncate max-w-[280px]" title={item.command || '-'}>{item.command || '-'}</span></Td>
            <Td>
              <span className="inline-flex items-center gap-1.5">
                <Badge tone={item.enabled ? 'green' : 'neutral'}>
                  {item.enabled ? t.common.enabled : t.common.disabled}
                </Badge>
                {item.enabled && live[item.id] && (
                  <Badge tone={live[item.id] === 'running' ? 'green' : 'red'}>
                    <StatusDot status={live[item.id]} />
                    {live[item.id]}
                  </Badge>
                )}
              </span>
            </Td>
            <Td className="text-right whitespace-nowrap">
              {item.server_type.startsWith('search') && (
                <IconBtn title={t.mcp.indexStats} onClick={() => setStatsFor(item)}><BarChart3 size={15} /></IconBtn>
              )}
              {item.server_type.startsWith('search') && (
                <IconBtn title={t.mcp.reindex} onClick={() => handleReindex(item)}><DatabaseZap size={15} /></IconBtn>
              )}
              <IconBtn title={t.mcp.liveTools} onClick={() => setToolsFor(item)}><Wrench size={15} /></IconBtn>
              <IconBtn title={t.mcp.restart} onClick={() => handleRestart(item.id)}><RotateCcw size={15} /></IconBtn>
              <IconBtn title={t.common.edit} onClick={() => openEdit(item)}><Pencil size={15} /></IconBtn>
              <IconBtn title={t.common.delete} onClick={() => handleDelete(item.id)} className="hover:!text-red-600 dark:hover:!text-red-400"><Trash2 size={15} /></IconBtn>
            </Td>
          </Row>
        ))}
      </TableShell>
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
      setSubmitError(err instanceof Error ? err.message : 'Ошибка сохранения');
    }
  }

  const typeOpts = SERVER_TYPES.includes(form.server_type) ? SERVER_TYPES : [...SERVER_TYPES, form.server_type];
  const transportOpts = TRANSPORTS.includes(form.transport) ? TRANSPORTS : [...TRANSPORTS, form.transport];

  return (
    <Modal title={item ? t.mcp.editTitle : t.mcp.newTitle} onClose={onClose} wide>
      <form onSubmit={handleSubmit} className="space-y-3">
        <Field label={t.mcp.name}>
          <TextInput value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t.mcp.type}>
            <Select value={form.server_type} onChange={e => setForm(f => ({ ...f, server_type: e.target.value }))}>
              {typeOpts.map(o => <option key={o} value={o}>{o}</option>)}
            </Select>
          </Field>
          <Field label={t.mcp.transport}>
            <Select value={form.transport} onChange={e => setForm(f => ({ ...f, transport: e.target.value }))}>
              {transportOpts.map(o => <option key={o} value={o}>{o}</option>)}
            </Select>
          </Field>
        </div>
        <Field label={t.mcp.command} hint={t.mcp.searchBinaryHint}>
          <div className="flex gap-2">
            <TextInput
              value={form.command}
              onChange={e => setForm(f => ({ ...f, command: e.target.value }))}
              placeholder="/path/to/mcp-binary"
              mono
              className="flex-1"
            />
            <Btn variant="outline" type="button" onClick={() => setBrowse(true)} className="shrink-0">
              <FolderOpen size={15} /> {t.mcp.browse}
            </Btn>
          </div>
        </Field>
        <JsonField label={t.mcp.args} value={form.args}
          onChange={v => setForm(f => ({ ...f, args: v }))}
          placeholder='["--port", "8080"]' kind="array" />
        <JsonField label={t.mcp.env} value={form.env}
          onChange={v => setForm(f => ({ ...f, env: v }))}
          placeholder='{"KEY": "value"}' kind="object" />
        <Field label={t.mcp.url}>
          <TextInput value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="http://… (для транспортов http/sse)" mono />
        </Field>
        <label className="flex items-center gap-2 text-[13px] text-slate-700 dark:text-slate-300 cursor-pointer">
          <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} className="rounded accent-indigo-600" />
          {t.mcp.enabled}
        </label>
        {submitError && <Alert tone="red">{submitError}</Alert>}
        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="ghost" type="button" onClick={onClose}>{t.common.cancel}</Btn>
          <Btn variant="primary" type="submit">{item ? t.common.save : t.common.create}</Btn>
        </div>
      </form>
      {browse && (
        <FileBrowser
          initialPath={form.command.includes('/') ? form.command.slice(0, form.command.lastIndexOf('/')) || '/' : undefined}
          onPick={p => { setForm(f => ({ ...f, command: p })); setBrowse(false); }}
          onClose={() => setBrowse(false)}
        />
      )}
    </Modal>
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
      if (kind === 'array' && !Array.isArray(parsed)) error = 'Должен быть JSON-массивом';
      if (kind === 'object' && (Array.isArray(parsed) || typeof parsed !== 'object' || parsed === null)) error = 'Должен быть JSON-объектом';
    } catch (e) {
      error = e instanceof Error ? e.message : 'Некорректный JSON';
    }
  }

  function format() {
    if (!trimmed || error) return;
    onChange(JSON.stringify(JSON.parse(trimmed), null, 2));
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="block text-[13px] font-medium text-slate-700 dark:text-slate-300">{label}</label>
        <div className="flex items-center gap-2">
          {trimmed && !error && <span className="text-xs text-emerald-600 dark:text-emerald-400">{t.mcp.validJson}</span>}
          {error && <span className="text-xs text-red-600 dark:text-red-400 max-w-[300px] truncate" title={error}>{error}</span>}
          <button type="button" onClick={format} disabled={!trimmed || !!error}
            className="text-xs px-2 py-0.5 text-slate-600 dark:text-slate-300 border border-slate-300 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors cursor-pointer">
            {t.mcp.format}
          </button>
        </div>
      </div>
      <TextArea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        spellCheck={false}
        mono
        className={error ? '!border-red-400 !bg-red-50 dark:!bg-red-950/30' : ''}
      />
    </div>
  );
}

function StatsModal({ item, onClose }: { item: McpServer; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getMcpStats(item.id)
      .then(r => setText(r.text || '(пусто — индекс, возможно, ещё строится)'))
      .catch(e => setError(e instanceof Error ? e.message : 'Не удалось загрузить статистику'));
  }, [item.id]);

  return (
    <Modal title={`${t.mcp.indexStats}: ${item.name}`} onClose={onClose}>
      <div className="space-y-3">
        {error && <Alert tone="red">{error}</Alert>}
        {!text && !error && <p className="text-sm text-slate-400 dark:text-slate-500">{t.common.loading}</p>}
        {text && <pre className="text-xs font-mono text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3 whitespace-pre-wrap break-all">{text}</pre>}
        <div className="flex justify-end">
          <Btn variant="ghost" onClick={onClose}>{t.common.close}</Btn>
        </div>
      </div>
    </Modal>
  );
}

function ToolsModal({ item, onClose }: { item: McpServer; onClose: () => void }) {
  const [tools, setTools] = useState<{ name: string; description?: string }[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');

  useEffect(() => {
    api.getMcpTools(item.id)
      .then(r => setTools(r.tools || []))
      .catch(e => setError(e instanceof Error ? e.message : 'Не удалось загрузить инструменты'));
  }, [item.id]);

  const shown = (tools || []).filter(tl =>
    !filter || tl.name.toLowerCase().includes(filter.toLowerCase())
      || (tl.description || '').toLowerCase().includes(filter.toLowerCase()));

  return (
    <Modal title={`${t.mcp.tools}: ${item.name}${tools ? ` (${tools.length})` : ''}`} onClose={onClose}>
      <div className="space-y-2">
        {error && <Alert tone="red">{error}</Alert>}
        {!tools && !error && <p className="text-sm text-slate-400 dark:text-slate-500">{t.common.loading}</p>}
        {tools && tools.length === 0 && <p className="text-sm text-slate-400 dark:text-slate-500">Нет инструментов (сервер работает, список пуст)</p>}
        {tools && tools.length > 0 && (
          <TextInput value={filter} onChange={e => setFilter(e.target.value)} placeholder={t.common.filter} />
        )}
        <div className="space-y-2 max-h-[50vh] overflow-y-auto">
          {shown.map(tl => (
            <div key={tl.name} className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2">
              <div className="text-xs font-mono font-semibold text-slate-800 dark:text-slate-100 break-all">{tl.name}</div>
              {tl.description && <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 break-words">{tl.description}</div>}
            </div>
          ))}
        </div>
        {tools && tools.length > 0 && shown.length === 0 && (
          <p className="text-sm text-slate-400 dark:text-slate-500">Ничего не найдено по «{filter}»</p>
        )}
        <div className="flex justify-end pt-1">
          <Btn variant="ghost" onClick={onClose}>{t.common.close}</Btn>
        </div>
      </div>
    </Modal>
  );
}

function ReindexProgress({ jobId, name, onClose }: { jobId: string; name: string; onClose: () => void }) {
  const [job, setJob] = useState<{
    state: string; progress: number; message: string; neighbors: string[];
    deleted: string[]; roots: string[]; error: string | null;
  } | null>(null);
  const [fetchError, setFetchError] = useState('');

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const j = await api.getReindexJob(jobId);
        if (alive) setJob(j);
      } catch (e) {
        if (alive) setFetchError(e instanceof Error ? e.message : 'Ошибка опроса');
      }
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [jobId]);

  const done = job?.state === 'done' || job?.state === 'error';
  const pct = job?.progress ?? 0;

  return (
    <Modal title={`Переиндексация: ${name}`} onClose={() => { if (done) onClose(); }}>
      <div className="space-y-3">
        {fetchError && <Alert tone="red">{fetchError}</Alert>}
        {!job && !fetchError && <p className="text-sm text-slate-400 dark:text-slate-500">{t.common.starting}</p>}
        {job && (
          <>
            <div className="w-full bg-slate-200 dark:bg-slate-800 rounded-full h-2.5 overflow-hidden">
              <div
                className={`h-2.5 rounded-full transition-all duration-500 ${job.state === 'error' ? 'bg-red-500' : 'bg-indigo-600'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-600 dark:text-slate-300 truncate">{job.message}</span>
              <span className="text-slate-500 dark:text-slate-400 font-mono ml-2 shrink-0">{pct}%</span>
            </div>
            {job.neighbors.length > 0 && (
              <p className="text-[11px] text-slate-500 dark:text-slate-400">Также остановлены общие строки: {job.neighbors.join(', ')}</p>
            )}
            {job.deleted.length > 0 && (
              <p className="text-[11px] text-slate-500 dark:text-slate-400">Удалено файлов индекса: {job.deleted.length}</p>
            )}
            {job.state === 'done' && (
              <Btn variant="primary" onClick={onClose} className="w-full justify-center">
                {t.common.close}
              </Btn>
            )}
            {job.state === 'error' && (
              <Alert tone="red">{job.error || 'Ошибка переиндексации'}</Alert>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
