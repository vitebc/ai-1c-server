import { useCallback, useEffect, useState } from 'react';
import { Upload, Trash2, Pencil, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import type { AppClient, AppRelease, AppSettings } from '../types';
import { t } from '../i18n';
import { errText } from '../errors';
import { PageHeader, TableShell, Th, Td, Row, Badge, IconBtn, Btn, Modal, Field, TextInput, TextArea, Select, Alert, Confirm, Segmented, Card, CardBody, CardTitle } from '../components/ui';

type Tab = 'releases' | 'clients' | 'settings';

function fmtSize(bytes: number): string {
  if (!bytes) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function Application() {
  const [tab, setTab] = useState<Tab>('releases');
  const [releases, setReleases] = useState<AppRelease[]>([]);
  const [clients, setClients] = useState<AppClient[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const ov = await api.getAppOverview();
      setReleases(ov.releases);
      setClients(ov.clients);
      setSettings(ov.settings);
    } catch (e) {
      setError(errText(e, 'Ошибка загрузки'));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <PageHeader title={t.appSec.title} hint={t.appSec.hint} right={<Btn variant="ghost" onClick={load}><RefreshCw size={14} /> {t.common.refresh}</Btn>} />
      {error && <Alert tone="red">{error}</Alert>}
      <div className="mb-4">
        <Segmented<Tab>
          options={[
            { key: 'releases', label: `${t.appSec.tabReleases} (${releases.length})` },
            { key: 'clients', label: `${t.appSec.tabClients} (${clients.length})` },
            { key: 'settings', label: t.appSec.tabSettings },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>
      {tab === 'releases' && <ReleasesTab releases={releases} onSaved={load} setError={setError} />}
      {tab === 'clients' && <ClientsTab clients={clients} onSaved={load} setError={setError} />}
      {tab === 'settings' && settings && <SettingsTab settings={settings} onSaved={load} setError={setError} />}
    </div>
  );
}

function ReleasesTab({ releases, onSaved, setError }: {
  releases: AppRelease[]; onSaved: () => void; setError: (s: string) => void;
}) {
  const [showUpload, setShowUpload] = useState(false);
  const [edit, setEdit] = useState<AppRelease | null>(null);
  const [del, setDel] = useState<AppRelease | null>(null);

  async function togglePublish(r: AppRelease) {
    try {
      await api.setAppReleasePublish(r.id, !r.published);
      onSaved();
    } catch (e) { setError(errText(e, 'Ошибка')); }
  }

  return (
    <div>
      <div className="flex justify-end mb-3">
        <Btn variant="primary" onClick={() => setShowUpload(true)}><Upload size={14} /> {t.appSec.upload}</Btn>
      </div>
      <TableShell
        colSpan={8}
        empty={releases.length === 0 ? { text: t.appSec.noReleases } : null}
        head={<><Th>{t.appSec.version}</Th><Th>{t.appSec.platform}</Th><Th>{t.appSec.channel}</Th><Th>{t.appSec.size}</Th><Th>{t.appSec.downloads}</Th><Th>{t.appSec.created}</Th><Th right>{t.common.actions}</Th></>}
      >
        {releases.map(r => (
          <Row key={r.id}>
            <Td>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-semibold">{r.version}</span>
                {r.required ? <Badge tone="amber">{t.appSec.mandatory}</Badge> : null}
                {r.published ? <Badge tone="green">{t.appSec.published}</Badge> : <Badge tone="neutral">{t.appSec.draft}</Badge>}
              </div>
            </Td>
            <Td><span className="text-xs">{r.platform}/{r.arch}</span></Td>
            <Td><span className="text-xs text-slate-500">{r.channel}</span></Td>
            <Td><span className="text-xs">{fmtSize(r.size)}</span></Td>
            <Td><span className="text-xs">{r.downloads}</span></Td>
            <Td><span className="text-xs text-slate-500" title={r.created_by}>{r.created_at}</span></Td>
            <Td className="text-right">
              <div className="flex items-center justify-end gap-1">
                <IconBtn title={r.published ? t.appSec.unpublish : t.appSec.publish} onClick={() => togglePublish(r)}>
                  {r.published ? <EyeOff size={14} /> : <Eye size={14} />}
                </IconBtn>
                <IconBtn title={t.common.edit} onClick={() => setEdit(r)}><Pencil size={14} /></IconBtn>
                <IconBtn title={t.common.delete} onClick={() => setDel(r)}><Trash2 size={14} /></IconBtn>
              </div>
            </Td>
          </Row>
        ))}
      </TableShell>
      {showUpload && <UploadModal onClose={() => setShowUpload(false)} onSaved={() => { setShowUpload(false); onSaved(); }} setError={setError} />}
      {edit && <EditReleaseModal item={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onSaved(); }} setError={setError} />}
      {del && (
        <Confirm title={t.common.deleteConfirmLabel} message={t.appSec.deleteConfirm(del.version)} danger double
          onConfirm={async () => { await api.deleteAppRelease(del.id).catch(e => setError(errText(e, 'Ошибка'))); setDel(null); onSaved(); }}
          onClose={() => setDel(null)} />
      )}
    </div>
  );
}

function UploadModal({ onClose, onSaved, setError }: { onClose: () => void; onSaved: () => void; setError: (s: string) => void }) {
  const [version, setVersion] = useState('');
  const [platform, setPlatform] = useState('linux');
  const [arch, setArch] = useState('x86_64');
  const [channel, setChannel] = useState('stable');
  const [notes, setNotes] = useState('');
  const [required, setRequired] = useState(false);
  const [published, setPublished] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [sigFile, setSigFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!file || !version.trim()) return;
    setBusy(true); setError('');
    try {
      await api.uploadAppRelease(file, sigFile, { version: version.trim(), platform, arch, channel, notes, required, published });
      onSaved();
    } catch (e) {
      setError(errText(e, 'Ошибка загрузки'));
    } finally { setBusy(false); }
  }

  return (
    <Modal title={t.appSec.upload} onClose={onClose} wide>
      <div className="space-y-3">
        <Field label={t.appSec.version}><TextInput mono value={version} onChange={e => setVersion(e.target.value)} placeholder="1.0.0" /></Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label={t.appSec.platform}>
            <Select value={platform} onChange={e => setPlatform(e.target.value)}>
              <option value="linux">linux</option><option value="windows">windows</option><option value="darwin">darwin</option>
            </Select>
          </Field>
          <Field label={t.appSec.arch}>
            <Select value={arch} onChange={e => setArch(e.target.value)}>
              <option value="x86_64">x86_64</option><option value="aarch64">aarch64</option>
            </Select>
          </Field>
          <Field label={t.appSec.channel}><TextInput mono value={channel} onChange={e => setChannel(e.target.value)} /></Field>
        </div>
        <Field label={t.appSec.file}>
          <input type="file" className="block w-full text-xs text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-blue-50 file:px-3 file:py-2 file:text-xs file:font-medium file:text-blue-700 dark:file:bg-blue-950 dark:file:text-blue-300"
            onChange={e => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <Field label={`${t.appSec.sigFile} (опционально)`} hint={t.appSec.sigHint}>
          <input type="file" className="block w-full text-xs text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-xs file:font-medium file:text-slate-700 dark:file:bg-slate-800 dark:file:text-slate-300"
            onChange={e => setSigFile(e.target.files?.[0] ?? null)} />
        </Field>
        <Field label={t.appSec.notes}><TextArea rows={3} value={notes} onChange={e => setNotes(e.target.value)} /></Field>
        <div className="flex gap-5">
          <label className="flex items-center gap-2 text-xs cursor-pointer"><input type="checkbox" checked={required} onChange={e => setRequired(e.target.checked)} className="rounded accent-blue-600" /> {t.appSec.required}</label>
          <label className="flex items-center gap-2 text-xs cursor-pointer"><input type="checkbox" checked={published} onChange={e => setPublished(e.target.checked)} className="rounded accent-blue-600" /> {t.appSec.published}</label>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="ghost" type="button" onClick={onClose}>{t.common.cancel}</Btn>
          <Btn variant="primary" type="button" disabled={!file || !version.trim() || busy} onClick={submit}>{busy ? t.appSec.uploading : t.common.save}</Btn>
        </div>
      </div>
    </Modal>
  );
}

function EditReleaseModal({ item, onClose, onSaved, setError }: {
  item: AppRelease; onClose: () => void; onSaved: () => void; setError: (s: string) => void;
}) {
  const [notes, setNotes] = useState(item.notes);
  const [required, setRequired] = useState(item.required);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true); setError('');
    try {
      await api.updateAppRelease(item.id, { notes, required });
      onSaved();
    } catch (e) { setError(errText(e, 'Ошибка')); } finally { setBusy(false); }
  }

  return (
    <Modal title={`${t.appSec.editTitle} ${item.version}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t.appSec.notes}><TextArea rows={4} value={notes} onChange={e => setNotes(e.target.value)} /></Field>
        <label className="flex items-center gap-2 text-xs cursor-pointer"><input type="checkbox" checked={required} onChange={e => setRequired(e.target.checked)} className="rounded accent-blue-600" /> {t.appSec.required}</label>
        <div className="text-xs text-slate-500 space-y-1">
          <p>{t.appSec.file}: <span className="font-mono">{item.file_name}</span></p>
          <p>{t.appSec.sha256}: <span className="font-mono break-all">{item.sha256}</span></p>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="ghost" type="button" onClick={onClose}>{t.common.cancel}</Btn>
          <Btn variant="primary" type="button" disabled={busy} onClick={submit}>{t.common.save}</Btn>
        </div>
      </div>
    </Modal>
  );
}

function ClientsTab({ clients, onSaved, setError }: {
  clients: AppClient[]; onSaved: () => void; setError: (s: string) => void;
}) {
  const [clearing, setClearing] = useState(false);

  return (
    <div>
      <div className="flex justify-end mb-3">
        <Btn variant="danger-outline" disabled={clients.length === 0} onClick={() => setClearing(true)}><Trash2 size={14} /> {t.appSec.clearClients}</Btn>
      </div>
      <TableShell
        colSpan={6}
        empty={clients.length === 0 ? { text: t.appSec.noClients } : null}
        head={<><Th>{t.appSec.clientId}</Th><Th>{t.clients.version}</Th><Th>{t.appSec.platform}</Th><Th>{t.appSec.clientHost}</Th><Th>{t.appSec.firstSeen}</Th><Th>{t.appSec.lastSeen}</Th></>}
      >
        {clients.map(c => (
          <Row key={c.client_id}>
            <Td><span className="font-mono text-xs text-slate-500 dark:text-slate-400">{c.client_id}</span></Td>
            <Td><span className="text-xs font-mono">{c.version || '—'}</span></Td>
            <Td><span className="text-xs">{c.platform || '—'}</span></Td>
            <Td><span className="text-xs">{c.hostname ? `${c.hostname}${c.user_name ? ` (${c.user_name})` : ''}` : '—'}</span></Td>
            <Td><span className="text-xs text-slate-500">{c.first_seen_at || '—'}</span></Td>
            <Td><span className="text-xs text-slate-500">{c.last_seen_at || '—'}</span></Td>
          </Row>
        ))}
      </TableShell>
      {clearing && (
        <Confirm title={t.appSec.clearClients} message={t.appSec.clearClientsConfirm} danger double
          onConfirm={async () => { await api.clearAppClients().catch(e => setError(errText(e, 'Ошибка'))); setClearing(false); onSaved(); }}
          onClose={() => setClearing(false)} />
      )}
    </div>
  );
}

function SettingsTab({ settings, onSaved, setError }: {
  settings: AppSettings; onSaved: () => void; setError: (s: string) => void;
}) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [baseUrl, setBaseUrl] = useState(settings.base_url);
  const [channel, setChannel] = useState(settings.channel);
  const [requireSig, setRequireSig] = useState(settings.require_signature);
  const [pubkey, setPubkey] = useState(settings.pubkey || '');
  const [busy, setBusy] = useState(false);

  // Предпросмотр.
  const [pvVersion, setPvVersion] = useState('');
  const [pvPlatform, setPvPlatform] = useState('linux');
  const [pvArch, setPvArch] = useState('x86_64');
  const [pvResult, setPvResult] = useState<{ status: number; body?: Record<string, unknown> | null; note?: string; error?: string } | null>(null);

  async function save() {
    setBusy(true); setError('');
    try {
      await api.putAppSettings({ enabled, base_url: baseUrl, channel, require_signature: requireSig, pubkey });
      onSaved();
    } catch (e) { setError(errText(e, 'Ошибка')); } finally { setBusy(false); }
  }

  async function preview() {
    try {
      setPvResult(await api.getAppUpdatePreview({ version: pvVersion || undefined, platform: pvPlatform, arch: pvArch, channel }));
    } catch (e) { setError(errText(e, 'Ошибка')); }
  }

  const checkUrl = `${(baseUrl || 'http://192.168.60.39:9020').replace(/\/$/, '')}/api/update/check?version={{current_version}}&platform={{target}}&arch={{arch}}`;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardBody>
          <CardTitle>{t.appSec.tabSettings}</CardTitle>
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-xs cursor-pointer"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="rounded accent-blue-600" /> {t.appSec.enabled}</label>
            <Field label={t.appSec.baseUrl} hint={t.appSec.baseUrlHint}><TextInput mono value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="http://192.168.60.39:9020" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t.appSec.channelLabel}><TextInput mono value={channel} onChange={e => setChannel(e.target.value)} /></Field>
              <label className="flex items-end gap-2 pb-2 text-xs cursor-pointer"><input type="checkbox" checked={requireSig} onChange={e => setRequireSig(e.target.checked)} className="rounded accent-blue-600" /> {t.appSec.requireSig}</label>
            </div>
            <Field label={t.appSec.pubkey} hint={t.appSec.pubkeyHint}><TextArea rows={2} mono value={pubkey} onChange={e => setPubkey(e.target.value)} /></Field>
            <p className="text-xs text-slate-500">{t.appSec.releasesDir}: <span className="font-mono break-all">{settings.releases_dir}</span></p>
            <div className="flex justify-end"><Btn variant="primary" disabled={busy} onClick={save}>{t.common.save}</Btn></div>
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <CardTitle>{t.appSec.previewTitle}</CardTitle>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label={t.appSec.previewCurrent}><TextInput mono value={pvVersion} onChange={e => setPvVersion(e.target.value)} placeholder="1.0.0" /></Field>
              <Field label={t.appSec.platform}>
                <Select value={pvPlatform} onChange={e => setPvPlatform(e.target.value)}>
                  <option value="linux">linux</option><option value="windows">windows</option><option value="darwin">darwin</option>
                </Select>
              </Field>
            </div>
            <Field label={t.appSec.arch}>
              <Select value={pvArch} onChange={e => setPvArch(e.target.value)}>
                <option value="x86_64">x86_64</option><option value="aarch64">aarch64</option>
              </Select>
            </Field>
            <Btn variant="outline" onClick={preview}><Eye size={14} /> {t.appSec.previewBtn}</Btn>
            {pvResult && (
              pvResult.status === 200
                ? <Alert tone="green">{t.appSec.previewOk(String(pvResult.body?.version ?? ''))}<pre className="mt-2 text-[11px] font-mono whitespace-pre-wrap break-all">{JSON.stringify(pvResult.body, null, 2)}</pre></Alert>
                : <Alert tone={pvResult.status === 500 ? 'red' : 'blue'}>{pvResult.error || (pvResult.note ?? t.appSec.previewNoUpdate)}</Alert>
            )}
          </div>
        </CardBody>
      </Card>
      <Card className="lg:col-span-2">
        <CardBody>
          <CardTitle>{t.appSec.checkUrl}</CardTitle>
          <p className="text-xs text-slate-500 mb-2">{t.appSec.clientConfigHint}</p>
          <code className="block rounded-lg bg-slate-100 dark:bg-slate-950 p-3 text-[11px] font-mono break-all">{checkUrl}</code>
        </CardBody>
      </Card>
    </div>
  );
}
