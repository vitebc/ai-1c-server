import { useCallback, useEffect, useState } from 'react';
import { BookOpen, Database, RefreshCw, Search, Trash2, Upload, FileText } from 'lucide-react';
import { api } from '../api/client';
import { t } from '../i18n';
import { errText } from '../errors';
import type { RagDocumentDetail, RagDocumentItem, RagStatus } from '../types';
import { Card, CardBody, Btn, IconBtn, Badge, TableShell, Th, Td, Row, Field, TextInput, TextArea, Modal as UiModal, Alert, Confirm } from '../components/ui';

const PAGE = 50;

/** Вкладка «База знаний»: состояние корпуса, документы, поиск, переинжест. */
export default function RagTab() {
  const [status, setStatus] = useState<RagStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [items, setItems] = useState<RagDocumentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [collection, setCollection] = useState('');
  const [offset, setOffset] = useState(0);
  const [docsError, setDocsError] = useState('');

  const [detail, setDetail] = useState<RagDocumentDetail | null>(null);
  const [detailError, setDetailError] = useState('');

  const [searchOpen, setSearchOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [reingestOpen, setReingestOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<RagDocumentItem | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.getRagStatus();
      if (s.error) {
        setStatusError(s.error);
        return;
      }
      setStatusError('');
      setStatus(s);
    } catch (e) {
      setStatusError(errText(e, t.common.error));
    }
  }, []);

  const loadDocs = useCallback(async () => {
    try {
      const r = await api.getRagDocuments({ q: q || undefined, collection: collection || undefined, limit: PAGE, offset });
      if (r.error) {
        setDocsError(r.error);
        return;
      }
      setDocsError('');
      setItems(r.items || []);
      setTotal(r.total ?? 0);
    } catch (e) {
      setDocsError(errText(e, t.common.error));
    }
  }, [q, collection, offset]);

  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => { loadDocs(); }, [loadDocs]);

  async function openDetail(id: number) {
    setDetailError('');
    try {
      const d = await api.getRagDocument(id);
      if (d.error) {
        setDetailError(d.error);
        return;
      }
      setDetail(d);
    } catch (e) {
      setDetailError(errText(e, t.common.error));
    }
  }

  async function removeDoc(item: RagDocumentItem) {
    try {
      const r = await api.deleteRagDocument(item.id);
      if (r.error) {
        setDocsError(r.error);
        return;
      }
      setConfirmDelete(null);
      setDetail(null);
      await Promise.all([loadDocs(), loadStatus()]);
    } catch (e) {
      setDocsError(errText(e, t.common.error));
    }
  }

  return (
    <div className="space-y-4">
      <Card><CardBody>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold flex items-center gap-2 text-slate-800 dark:text-slate-200">
            <Database size={17} /> {t.rag.statusTitle}
          </h3>
          <IconBtn title={t.common.refresh} onClick={() => { loadStatus(); loadDocs(); }}>
            <RefreshCw size={15} />
          </IconBtn>
        </div>
        {statusError && <Alert tone="red">{statusError}</Alert>}
        {status && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            <Stat label={t.rag.provider} value={status.provider} />
            <Stat label={t.rag.documents} value={String(status.documents)} />
            <Stat label={t.rag.chunks} value={String(status.chunks)} />
            <Stat label={t.rag.dimension} value={String(status.embedding_dim)} />
            <Stat label={t.rag.kbMinScore} value={status.kb_min_score.toFixed(2)} />
            <Stat
              label={t.rag.skillThreshold}
              value={status.skill_match_threshold.toFixed(2)}
            />
          </div>
        )}
        {status && (
          <div className="mt-3 text-xs text-slate-500 dark:text-slate-400 space-y-1">
            <div>
              <span className="font-medium">{t.rag.kbDir}:</span>{' '}
              <span className="font-mono">{status.kb_dir}</span>{' '}
              {status.kb_dir_exists
                ? <Badge tone="green">{t.rag.dirOk}</Badge>
                : <Badge tone="red">{t.rag.dirMissing}</Badge>}
            </div>
            {status.collections.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {status.collections.map(c => {
                  const disk = status.files_on_disk?.[c.name];
                  const mismatch = disk !== undefined && disk.unique !== c.documents;
                  const hint = mismatch ? (disk.count > disk.unique ? t.rag.duplicatesHint(disk.count, disk.unique) : t.rag.mismatchHint(disk.unique, c.documents)) : undefined;
                  return (
                    <span key={c.name} className="inline-flex items-center gap-1" title={hint}>
                      <Badge tone="blue">{c.name}</Badge>
                      <span className="text-slate-500">
                        {c.documents} / {c.chunks}
                        {disk !== undefined && (
                          <> · {t.rag.filesOnDisk}: {disk.count}{disk.count > disk.unique ? ` (${t.rag.uniqueShort}: ${disk.unique})` : ''}</>
                        )}
                      </span>
                      {mismatch && <Badge tone="amber">{t.rag.mismatchBadge}</Badge>}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap mt-3 pt-3 border-t border-slate-200 dark:border-slate-800">
          <Btn onClick={() => setSearchOpen(true)}><Search size={15} /> {t.rag.testSearch}</Btn>
          <Btn onClick={() => setUploadOpen(true)}><Upload size={15} /> {t.rag.uploadDoc}</Btn>
          <Btn onClick={() => setReingestOpen(true)}><RefreshCw size={15} /> {t.rag.reingest}</Btn>
        </div>
      </CardBody></Card>

      <Card><CardBody>
        <div className="flex items-end gap-2 flex-wrap mb-3">
          <Field label={t.common.search} className="flex-1 min-w-[220px]">
            <TextInput value={q} onChange={e => { setQ(e.target.value); setOffset(0); }} placeholder={t.rag.searchDocs} />
          </Field>
          <Field label={t.rag.collection} className="w-48">
            <TextInput value={collection} onChange={e => { setCollection(e.target.value); setOffset(0); }} placeholder="updinfo" />
          </Field>
          <IconBtn title={t.common.refresh} onClick={loadDocs}><RefreshCw size={15} /></IconBtn>
        </div>
        {docsError && <Alert tone="red">{docsError}</Alert>}
        <TableShell
          head={<><Th>ID</Th><Th>{t.rag.title}</Th><Th>{t.rag.source}</Th><Th>{t.rag.chunks}</Th><Th right>{t.common.actions}</Th></>}
          empty={items.length === 0 ? { text: t.rag.noDocs } : null}
          colSpan={5}
        >
          {items.map(d => (
            <Row key={d.id}>
              <Td className="font-mono text-xs">{d.id}</Td>
              <Td>
                <button className="text-left hover:underline flex items-center gap-1.5" onClick={() => openDetail(d.id)}>
                  <FileText size={13} className="shrink-0 text-slate-400" />
                  <span className="truncate max-w-[420px]" title={d.title}>{d.title}</span>
                </button>
              </Td>
              <Td className="font-mono text-xs text-slate-500 truncate max-w-[280px]">{d.source}</Td>
              <Td className="text-xs">{d.chunks}</Td>
              <Td className="text-right">
                <div className="flex items-center justify-end gap-1">
                  <IconBtn title={t.rag.view} onClick={() => openDetail(d.id)}><BookOpen size={15} /></IconBtn>
                  <IconBtn title={t.common.delete} onClick={() => setConfirmDelete(d)}><Trash2 size={15} /></IconBtn>
                </div>
              </Td>
            </Row>
          ))}
        </TableShell>
        <div className="flex items-center justify-between mt-3 text-xs text-slate-500">
          <span>{t.rag.total}: {total}</span>
          <div className="flex items-center gap-2">
            <Btn disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>←</Btn>
            <span>{Math.floor(offset / PAGE) + 1} / {Math.max(1, Math.ceil(total / PAGE))}</span>
            <Btn disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>→</Btn>
          </div>
        </div>
      </CardBody></Card>

      {detail && (
        <UiModal title={detail.title} onClose={() => setDetail(null)} xwide fill>
          <div className="space-y-3 flex-1 min-h-0 flex flex-col">
            {detailError && <Alert tone="red">{detailError}</Alert>}
            <div className="text-xs text-slate-500 font-mono">
              {detail.source} · {t.rag.chunks}: {detail.chunks.length} · {detail.access_profile}
              {detail.agent_name ? ` · agent=${detail.agent_name}` : ''}
            </div>
            <div className="overflow-auto space-y-2 flex-1 min-h-0">
              {detail.chunks.map(c => (
                <div
                  key={c.id}
                  className={`rounded-lg border px-3 py-2 text-xs whitespace-pre-wrap ${
                    c.is_header
                      ? 'border-blue-300 bg-blue-50/60 dark:border-blue-800 dark:bg-blue-950/40'
                      : 'border-slate-200 dark:border-slate-800'
                  }`}
                >
                  {c.is_header && <Badge tone="blue">{t.rag.headerChunk}</Badge>}
                  <div className="text-slate-700 dark:text-slate-200 mt-1">{c.text}</div>
                </div>
              ))}
            </div>
          </div>
        </UiModal>
      )}

      {searchOpen && (
        <RagSearchModal onClose={() => setSearchOpen(false)} />
      )}
      {uploadOpen && (
        <RagUploadModal onClose={() => setUploadOpen(false)} onDone={() => { loadDocs(); loadStatus(); }} />
      )}
      {reingestOpen && (
        <RagReingestModal onClose={() => setReingestOpen(false)} onDone={() => { loadDocs(); loadStatus(); }} />
      )}
      {confirmDelete && (
        <Confirm
          title={t.rag.deleteDoc}
          message={t.rag.deleteDocConfirm(confirmDelete.title)}
          confirmLabel={t.common.delete}
          danger
          onConfirm={() => removeDoc(confirmDelete)}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 bg-slate-50 dark:bg-slate-950">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className="text-sm font-medium text-slate-800 dark:text-slate-100 font-mono truncate">{value}</p>
    </div>
  );
}

// ─── Пробный поиск ───

function RagSearchModal({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState(5);
  const [res, setRes] = useState<Awaited<ReturnType<typeof api.searchRag>> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError('');
    try {
      const r = await api.searchRag({ query, top_k: topK });
      if (r.error) {
        setError(r.error);
        return;
      }
      setRes(r);
    } catch (e) {
      setError(errText(e, t.common.error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <UiModal title={t.rag.testSearch} onClose={onClose} wide>
      <div className="space-y-3">
        <Field label={t.rag.query} hint={t.rag.testSearchHint}>
          <TextInput value={query} onChange={e => setQuery(e.target.value)} placeholder="Что нового в версии 2.6.1.64?" />
        </Field>
        <Field label="top_k">
          <TextInput type="number" min={1} max={10} value={topK} onChange={e => setTopK(Number(e.target.value) || 5)} />
        </Field>
        {error && <Alert tone="red">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Btn variant="ghost" onClick={onClose}>{t.common.close}</Btn>
          <Btn disabled={busy || query.trim().length < 2} onClick={run}>
            {busy ? t.common.loading : t.rag.search}
          </Btn>
        </div>
        {res && (
          <div className="space-y-2 pt-2 border-t border-slate-200 dark:border-slate-800">
            <div className="text-xs text-slate-500">
              {res.found ? `${t.rag.found}: ${res.fragments.length}` : t.rag.notFound}
              {` · min_score=${res.min_score}`}
            </div>
            {res.fragments.map((f, i) => (
              <div key={i} className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2">
                <div className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate">{f.title}</div>
                <div className="text-xs text-slate-600 dark:text-slate-400 whitespace-pre-wrap mt-1">{f.text.slice(0, 400)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </UiModal>
  );
}

// ─── Загрузка документа ───

function RagUploadModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [collection, setCollection] = useState('manual');
  const [profile, setProfile] = useState('all');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const r = await api.uploadRagDocument({ title, content, collection, access_profile: profile });
      if (r.error) {
        setError(r.error);
        return;
      }
      onDone();
      onClose();
    } catch (e) {
      setError(errText(e, t.common.error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <UiModal title={t.rag.uploadDoc} onClose={onClose} wide>
      <div className="space-y-3">
        <Field label={t.rag.title}>
          <TextInput value={title} onChange={e => setTitle(e.target.value)} placeholder={t.rag.docTitleHint} />
        </Field>
        <Field label={t.rag.content}>
          <TextArea value={content} onChange={e => setContent(e.target.value)} rows={12} mono />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t.rag.collection}>
            <TextInput value={collection} onChange={e => setCollection(e.target.value)} />
          </Field>
          <Field label={t.rag.profile} hint="all | sales | accounting">
            <TextInput value={profile} onChange={e => setProfile(e.target.value)} />
          </Field>
        </div>
        {error && <Alert tone="red">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Btn variant="ghost" onClick={onClose}>{t.common.cancel}</Btn>
          <Btn disabled={busy || !title.trim() || !content.trim()} onClick={submit}>
            {busy ? t.common.saving : t.common.create}
          </Btn>
        </div>
      </div>
    </UiModal>
  );
}

// ─── Переинжест коллекции ───

function RagReingestModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [collection, setCollection] = useState('updinfo');
  const [replace, setReplace] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>('');
  const [mismatch, setMismatch] = useState<{ files_on_disk: number; unique_files: number; documents_in_db: number } | null>(null);

  async function submit() {
    setBusy(true);
    setError('');
    setResult('');
    setMismatch(null);
    try {
      const r = await api.reingestRag({ collection, replace });
      if (r.error) {
        setError(r.error);
        return;
      }
      setResult(
        `${t.rag.done}: ${r.documents} / ${r.chunks} (${t.rag.files}: ${r.files}, ${t.rag.removed}: ${r.removed})` +
        (r.errors?.length ? ` · ${t.rag.errors}: ${r.errors.length}` : ''),
      );
      setMismatch(r.file_count_mismatch ?? null);
      onDone();
    } catch (e) {
      setError(errText(e, t.common.error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <UiModal title={t.rag.reingest} onClose={onClose} wide>
      <div className="space-y-3">
        <Field label={t.rag.collection} hint={t.rag.reingestHint}>
          <TextInput value={collection} onChange={e => setCollection(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
          <input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} className="rounded accent-blue-600" />
          {t.rag.replaceExisting}
        </label>
        {error && <Alert tone="red">{error}</Alert>}
        {result && <Alert tone="green">{result}</Alert>}
        {mismatch && (
          <Alert tone="amber">
            {mismatch.files_on_disk > mismatch.unique_files
              ? t.rag.duplicatesHint(mismatch.files_on_disk, mismatch.unique_files)
              : t.rag.mismatchHint(mismatch.unique_files, mismatch.documents_in_db)}
          </Alert>
        )}
        <div className="flex justify-end gap-2">
          <Btn variant="ghost" onClick={onClose}>{t.common.close}</Btn>
          <Btn disabled={busy || !collection.trim()} onClick={submit}>
            {busy ? t.rag.working : t.rag.reingest}
          </Btn>
        </div>
      </div>
    </UiModal>
  );
}
