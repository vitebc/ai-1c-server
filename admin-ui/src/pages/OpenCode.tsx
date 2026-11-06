import { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Play, Square, RotateCw, Check, X, RefreshCw, KeyRound, Package, Network, ChevronRight, Server as ServerIcon } from 'lucide-react';
import { api } from '../api/client';
import type { OpencodeServer } from '../types';
import { t } from '../i18n';
import { errText } from '../errors';
import { PageHeader, Btn, IconBtn, Badge, TableShell, Th, Td, Row, TextInput, TextArea, Field, Alert, Modal, Confirm, inputCls, monoCls } from '../components/ui';

type Section = 'config' | 'agents' | 'skills' | 'tools' | 'sessions';

interface Selection {
  kind: 'gateway' | 'gateway-logs' | 'section';
  serverId?: string;
  section?: Section;
}

const SECTIONS: { key: Section; label: () => string }[] = [
  { key: 'config', label: () => t.opencode.tabConfig },
  { key: 'agents', label: () => t.opencode.tabAgents },
  { key: 'skills', label: () => t.opencode.tabSkills },
  { key: 'tools', label: () => t.opencode.tabTools },
  { key: 'sessions', label: () => t.opencode.tabSessions },
];

export default function OpenCode() {
  const [servers, setServers] = useState<OpencodeServer[]>([]);
  const [sel, setSel] = useState<Selection>({ kind: 'gateway' });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      const s = await api.getOpencodeServers();
      setServers(s);
      // При первом загрузке — раскрываем первый сервер и выбираем его конфиг.
      setSel(prev => {
        if (prev.kind === 'section' && prev.serverId && s.some(x => x.id === prev.serverId)) return prev;
        const first = s[0];
        if (!first) return { kind: 'gateway' };
        setExpanded(e => ({ ...e, [first.id]: true }));
        return { kind: 'section', serverId: first.id, section: 'config' };
      });
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const selServer = sel.kind === 'section' && sel.serverId ? servers.find(s => s.id === sel.serverId) || null : null;

  function pickGateway() { setSel({ kind: 'gateway' }); }
  function pickGatewayLogs() { setSel({ kind: 'gateway-logs' }); }
  function toggleServer(id: string) { setExpanded(e => ({ ...e, [id]: !e[id] })); }
  function pickSection(serverId: string, section: Section) {
    setExpanded(e => ({ ...e, [serverId]: true }));
    setSel({ kind: 'section', serverId, section });
  }

  return (
    <div>
      <PageHeader title={t.nav.opencode} hint={t.opencode.hint} />
      <div className="flex gap-4 items-start">
        {/* Дерево слева */}
        <aside className="w-56 shrink-0 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
          <div className="p-2 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{t.opencode.treeServers}</span>
            <IconBtn title={t.opencode.addServer} onClick={() => setSel({ kind: 'section', serverId: '__new__', section: 'config' })}>
              <Plus size={14} />
            </IconBtn>
          </div>
          <nav className="p-1.5 max-h-[70vh] overflow-y-auto text-sm">
            {/* Шлюз */}
            <button
              onClick={pickGateway}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left ${sel.kind === 'gateway' ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300' : 'hover:bg-slate-100 dark:hover:bg-slate-800/60'}`}
            >
              <Network size={14} className="shrink-0" />
              <span>{t.opencode.treeGateway}</span>
            </button>
            <div className="ml-5 pl-2 border-l border-slate-200 dark:border-slate-800 my-0.5">
              <button
                onClick={pickGatewayLogs}
                className={`w-full flex items-center gap-2 px-2 py-1 rounded-md text-left text-[13px] ${sel.kind === 'gateway-logs' ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300' : 'hover:bg-slate-100 dark:hover:bg-slate-800/60 text-slate-600 dark:text-slate-400'}`}
              >
                {t.opencode.tabGatewayLogs}
              </button>
            </div>

            {/* Серверы */}
            {servers.map(s => (
              <div key={s.id}>
                <div
                  className={`flex items-center gap-1 px-2 py-1.5 rounded-md cursor-pointer ${expanded[s.id] ? 'bg-slate-100 dark:bg-slate-800/60' : 'hover:bg-slate-100 dark:hover:bg-slate-800/40'}`}
                  onClick={() => toggleServer(s.id)}
                >
                  <ChevronRight size={13} className={`shrink-0 transition-transform ${expanded[s.id] ? 'rotate-90' : ''}`} />
                  <ServerIcon size={14} className="shrink-0" />
                  <span className="truncate flex-1">{s.name}</span>
                  {s.is_default && <Badge tone="green">★</Badge>}
                </div>
                {expanded[s.id] && (
                  <div className="ml-5 pl-2 border-l border-slate-200 dark:border-slate-800 my-0.5">
                    {SECTIONS.map(sec => (
                      <button
                        key={sec.key}
                        onClick={() => pickSection(s.id, sec.key)}
                        className={`w-full flex items-center gap-2 px-2 py-1 rounded-md text-left text-[13px] ${sel.kind === 'section' && sel.serverId === s.id && sel.section === sec.key ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300' : 'hover:bg-slate-100 dark:hover:bg-slate-800/60 text-slate-600 dark:text-slate-400'}`}
                      >
                        {sec.label()}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </nav>
        </aside>

        {/* Контент справа */}
        <div className="flex-1 min-w-0">
          {sel.kind === 'gateway' && <GatewayTab />}
          {sel.kind === 'gateway-logs' && <GatewayLogsTab />}
          {sel.kind === 'section' && sel.serverId === '__new__' && (
            <ServersTab servers={servers} onChanged={load} onPick={(id) => pickSection(id, 'config')} selId="" />
          )}
          {sel.kind === 'section' && selServer && sel.section === 'config' && <ConfigTab server={selServer} />}
          {sel.kind === 'section' && selServer && sel.section === 'agents' && <AgentsTab server={selServer} />}
          {sel.kind === 'section' && selServer && sel.section === 'skills' && <SkillsTab server={selServer} />}
          {sel.kind === 'section' && selServer && sel.section === 'tools' && <ToolsTab server={selServer} onChanged={load} />}
          {sel.kind === 'section' && selServer && sel.section === 'sessions' && <SessionsTab serverId={selServer.id} />}
        </div>
      </div>
    </div>
  );
}

// ─── Шлюз (статус + настройки) ──────────────────────────────────────

interface GatewayStatus {
  project_root?: string; gateway_url?: string; port?: number;
  alive?: boolean; password_set?: boolean; session_count?: number;
  servers: Array<Record<string, any>>;
}

function GatewayTab() {
  const [st, setSt] = useState<GatewayStatus | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  // Настройки (server_settings).
  const [gwUrl, setGwUrl] = useState('');
  const [rootDir, setRootDir] = useState('');
  const [pw, setPw] = useState('');          // PEPK-токен контейнера (только /onec/rpc)
  const [vitra, setVitra] = useState('');    // токен Витра AI (анонимный режим)
  const [vitraSet, setVitraSet] = useState(false);

  const load = useCallback(async () => {
    setErr('');
    try {
      const s = await api.getOpencodeStatus();
      setSt(s);
      setGwUrl(s.gateway_url || '');
      setRootDir(s.project_root || '');
      const vt = await api.getVitraToken();
      setVitraSet(vt.token_set);
    } catch (e) { setErr(errText(e, 'Ошибка статуса')); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function doSaveSettings() {
    setBusy(true); setMsg(''); setErr('');
    try {
      if (gwUrl.trim()) await api.putSetting('opencode_gateway_url', gwUrl.trim());
      if (rootDir.trim()) await api.putSetting('opencode_project_root', rootDir.trim());
      if (pw !== '') await api.putSetting('opencode_gateway_password', pw);
      setPw('');
      // Токен Витры: пустая строка = не трогать; «__clear__» = очистить; иначе — установить.
      if (vitra === '__clear__') {
        await api.putVitraToken('');
        setVitraSet(false);
      } else if (vitra.trim() !== '') {
        await api.putVitraToken(vitra.trim());
        setVitraSet(true);
      }
      setVitra('');
      setMsg(t.opencode.gatewaySaved);
      load();
    } catch (e) { setErr(errText(e, 'Ошибка сохранения')); }
    finally { setBusy(false); }
  }

  if (!st) return <div>{err && <Alert tone="red">{err}</Alert>}</div>;

  const healthyCount = st.servers.filter((s: any) => s.healthy).length;

  return (
    <div className="space-y-4">
      {/* Статус */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatBox label={t.opencode.gatewayState} value={st.alive ? t.opencode.gatewayUp : t.opencode.gatewayDown} tone={st.alive ? 'green' : 'red'} />
        <StatBox label={t.opencode.gatewayAddr} value={st.gateway_url || `http://127.0.0.1:${st.port ?? 9020}`} mono />
        <StatBox label={t.opencode.serversLabel} value={`${healthyCount}/${st.servers.length}`} tone={healthyCount === st.servers.length ? 'green' : 'amber'} />
        <StatBox label={t.opencode.sessionsLabel} value={String(st.session_count ?? 0)} />
      </div>

      {/* Допуск к шлюзу */}
      <div className="flex items-center gap-2 text-xs">
        <Badge tone="green">{t.opencode.gatewaySecure}</Badge>
        <span className="text-slate-500 dark:text-slate-400">
          {vitraSet ? t.opencode.vitraTokenSet : t.opencode.vitraTokenEmpty}
        </span>
      </div>

      {/* Серверы (сводка) */}
      <TableShell colSpan={5} empty={st.servers.length === 0 ? { text: t.opencode.noServers } : null}
        head={<><Th>{t.opencode.name}</Th><Th>{t.opencode.url}</Th><Th>{t.opencode.stateCol}</Th><Th>{t.opencode.pluginCol}</Th><Th>{t.opencode.depsCol}</Th></>}>
        {st.servers.map((s: any) => (
          <Row key={s.id}>
            <Td><span className="font-medium">{s.name}</span>{s.is_default && <span className="ml-2"><Badge tone="green">{t.opencode.defaultBadge}</Badge></span>}</Td>
            <Td><span className={monoCls + ' text-xs'}>{s.url}</span></Td>
            <Td><Badge tone={s.healthy ? 'green' : 'red'}>{s.healthy ? t.opencode.upState : t.opencode.downState}</Badge></Td>
            <Td><Badge tone={s.plugin_generated ? 'green' : 'amber'}>{s.plugin_generated ? '✓' : '—'}</Badge></Td>
            <Td><Badge tone={s.deps_installed ? 'green' : 'amber'}>{s.deps_installed ? '✓' : '—'}</Badge></Td>
          </Row>
        ))}
      </TableShell>

      {/* Настройки */}
      {msg && <Alert tone="blue">{msg}</Alert>}
      {err && <Alert tone="red">{err}</Alert>}
      <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
        <h3 className="font-medium text-sm">{t.opencode.gatewaySettings}</h3>
        <Field label={t.opencode.gatewayUrlSetting} hint={t.opencode.gatewayUrlHint}>
          <TextInput mono value={gwUrl} onChange={e => setGwUrl(e.target.value)} placeholder="http://192.168.60.39:9020" />
        </Field>
        <Field label={t.opencode.rootSetting} hint={t.opencode.rootHint}>
          <TextInput mono value={rootDir} onChange={e => setRootDir(e.target.value)} placeholder="/home/test/project/1C-opencode" />
        </Field>
        <Field label={t.opencode.pepekSetting} hint={t.opencode.pepekHint}>
          <TextInput type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder={st.password_set ? '•••••• (установлен)' : ''} />
        </Field>
        <Field label={t.opencode.vitraSetting} hint={t.opencode.vitraHint}>
          <div className="flex gap-2">
            <TextInput type="password" value={vitra} onChange={e => setVitra(e.target.value)} placeholder={vitraSet ? '•••••• (установлен)' : ''} />
            {vitraSet && (
              <Btn variant="outline" onClick={() => setVitra('__clear__')} title={t.opencode.vitraTokenEmpty}>
                <Trash2 size={15} />
              </Btn>
            )}
          </div>
        </Field>
        <div className="flex justify-end">
          <Btn onClick={doSaveSettings} disabled={busy}><Check size={15} /> {t.common.save}</Btn>
        </div>
      </div>
    </div>
  );
}

function StatBox({ label, value, tone, mono }: { label: string; value: string; tone?: 'green' | 'red' | 'amber'; mono?: boolean }) {
  const dot = tone === 'green' ? 'bg-emerald-500' : tone === 'red' ? 'bg-red-500' : tone === 'amber' ? 'bg-amber-500' : 'bg-slate-400';
  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3">
      <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">{label}</div>
      <div className="flex items-center gap-2">
        {tone && <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />}
        <span className={`text-sm font-medium truncate ${mono ? monoCls : ''}`}>{value}</span>
      </div>
    </div>
  );
}

// ─── Логи обращений к шлюзу ─────────────────────────────────────────

interface GwLogEntry { ts: string; level: string; target: string; msg: string }

function GatewayLogsTab() {
  const [logs, setLogs] = useState<GwLogEntry[]>([]);
  const [err, setErr] = useState('');
  const [level, setLevel] = useState<'ALL' | 'INFO' | 'WARN'>('ALL');

  const load = useCallback(async () => {
    setErr('');
    try { setLogs(await api.getOpencodeGatewayLogs(300)); }
    catch (e) { setErr(errText(e, 'Ошибка загрузки логов')); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const shown = level === 'ALL' ? logs : logs.filter(l => l.level.startsWith(level));

  return (
    <div>
      {err && <div className="mb-3"><Alert tone="red">{err}</Alert></div>}
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">{t.opencode.gatewayLogsHint}</p>
      <div className="flex items-center gap-2 mb-2">
        <select
          value={level}
          onChange={e => setLevel(e.target.value as 'ALL' | 'INFO' | 'WARN')}
          className="text-sm border border-slate-300 dark:border-slate-700 rounded-md px-2 py-1 bg-white dark:bg-slate-900"
        >
          <option value="ALL">Все уровни</option>
          <option value="INFO">INFO + WARN</option>
          <option value="WARN">Только WARN</option>
        </select>
        <span className="text-xs text-slate-500 dark:text-slate-400">{shown.length} записей</span>
        <div className="flex-1" />
        <Btn variant="outline" onClick={load}><RefreshCw size={15} /> {t.common.refresh}</Btn>
      </div>
      <TableShell colSpan={3} empty={shown.length === 0 ? { text: t.opencode.gatewayLogsEmpty } : null}
        head={<><Th>{t.opencode.gwLogTime}</Th><Th>{t.opencode.gwLogLevel}</Th><Th>{t.opencode.gwLogMsg}</Th></>}>
        {shown.map((l, i) => (
          <Row key={i}>
            <Td className="whitespace-nowrap"><span className={monoCls + ' text-xs'}>{new Date(l.ts).toLocaleTimeString('ru-RU')}</span></Td>
            <Td><Badge tone={l.level === 'WARN' ? 'amber' : l.level === 'ERROR' ? 'red' : 'neutral'}>{l.level}</Badge></Td>
            <Td><span className="text-sm">{l.msg}</span></Td>
          </Row>
        ))}
      </TableShell>
    </div>
  );
}

// ─── Серверы ────────────────────────────────────────────────────────

interface ServerForm {
  name: string; title: string; config_dir: string; url: string; username: string;
  password: string; bases: string[]; compose_service: string; compose_profile: string;
  onec_user: string; onec_password: string; enabled: boolean; is_default: boolean;
}

const emptyForm: ServerForm = {
  name: '', title: '', config_dir: '', url: 'http://127.0.0.1:4040', username: 'opencode',
  password: '', bases: [], compose_service: '', compose_profile: '', onec_user: '', onec_password: '', enabled: true, is_default: false,
};

function ServersTab({ servers, onChanged, onPick, selId }: { servers: OpencodeServer[]; onChanged: () => void; onPick: (id: string) => void; selId: string }) {
  const [form, setForm] = useState<ServerForm | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [del, setDel] = useState<OpencodeServer | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  function openNew() { setEditingId(null); setForm({ ...emptyForm }); }
  function openEdit(s: OpencodeServer) {
    setEditingId(s.id);
    setForm({
      name: s.name, title: s.title, config_dir: s.config_dir, url: s.url, username: s.username,
      password: '', bases: [...s.bases], compose_service: s.compose_service, compose_profile: s.compose_profile,
      onec_user: s.onec_user, onec_password: '', enabled: s.enabled, is_default: s.is_default,
    });
  }

  async function doSave() {
    if (!form) return;
    setErr(''); setMsg('');
    try {
      const payload = {
        name: form.name.trim(), title: form.title, config_dir: form.config_dir || undefined, url: form.url,
        username: form.username, password: form.password || undefined, bases: form.bases,
        compose_service: form.compose_service, compose_profile: form.compose_profile,
        onec_user: form.onec_user, onec_password: form.onec_password || undefined,
        enabled: form.enabled, is_default: form.is_default,
      };
      if (editingId) await api.updateOpencodeServer(editingId, payload);
      else {
        const created = await api.createOpencodeServer(payload);
        onPick(created.id);
      }
      setForm(null);
      setMsg('Сохранено');
      onChanged();
    } catch (e) { setErr(errText(e, 'Ошибка')); }
  }

  async function doLifecycle(s: OpencodeServer, action: 'up' | 'stop' | 'restart') {
    setBusy(`${s.name}:${action}`); setErr(''); setMsg('');
    try {
      const r = await api.opencodeLifecycle(s.id, action);
      setMsg(`${s.name}: ${r.output || 'ok'}`.slice(0, 400));
    } catch (e) { setErr(errText(e, 'Ошибка')); }
    finally { setBusy(''); }
  }

  async function doDelete() {
    if (!del) return;
    setErr('');
    try {
      await api.deleteOpencodeServer(del.id);
      if (selId === del.id) onPick('');
      setDel(null); setMsg('Удалено'); onChanged();
    } catch (e) { setErr(errText(e, 'Ошибка')); }
  }

  return (
    <div>
      {msg && <div className="mb-3"><Alert tone="blue">{msg}</Alert></div>}
      {err && <div className="mb-3"><Alert tone="red">{err}</Alert></div>}
      <div className="flex justify-end mb-2">
        <Btn onClick={openNew}><Plus size={15} /> {t.opencode.addServer}</Btn>
      </div>
      <TableShell
        colSpan={7}
        empty={servers.length === 0 ? { text: t.opencode.noServers } : null}
        head={<><Th>{t.opencode.name}</Th><Th>{t.opencode.url}</Th><Th>{t.opencode.bases}</Th><Th>1С</Th><Th right>Compose</Th><Th right>Флаг</Th><Th right>{t.common.actions}</Th></>}
      >
        {servers.map(s => (
          <Row key={s.id} className={s.id === selId ? 'bg-blue-50/60 dark:bg-blue-950/30' : ''}>
            <Td>
              <div className="font-medium">{s.name}</div>
              {s.title && <div className="text-xs text-slate-500 dark:text-slate-400">{s.title}</div>}
            </Td>
            <Td><span className={monoCls + ' text-xs'}>{s.url}</span></Td>
            <Td>
              <div className="flex flex-wrap gap-1">
                {s.bases.map(b => <Badge key={b} tone="sky">{b}</Badge>)}
              </div>
            </Td>
            <Td><span className="text-xs">{s.onec_user || '—'}</span></Td>
            <Td className="text-right"><span className="text-xs">{s.compose_service || '—'}</span></Td>
            <Td className="text-right">
              <div className="flex gap-1 justify-end">
                {s.is_default && <Badge tone="green">{t.opencode.defaultBadge}</Badge>}
                {!s.enabled && <Badge tone="red">{t.common.disabled}</Badge>}
              </div>
            </Td>
            <Td className="text-right">
              <div className={`flex gap-0.5 justify-end ${busy ? 'opacity-40 pointer-events-none' : ''}`}>
                <IconBtn title={t.opencode.up} onClick={() => doLifecycle(s, 'up')}><Play size={14} /></IconBtn>
                <IconBtn title={t.opencode.stop} onClick={() => doLifecycle(s, 'stop')}><Square size={14} /></IconBtn>
                <IconBtn title={t.opencode.restart} onClick={() => doLifecycle(s, 'restart')}><RotateCw size={14} /></IconBtn>
                <IconBtn title={t.common.edit} onClick={() => openEdit(s)}><Pencil size={14} /></IconBtn>
                <IconBtn title={t.common.delete} onClick={() => setDel(s)}><Trash2 size={14} /></IconBtn>
              </div>
            </Td>
          </Row>
        ))}
      </TableShell>

      {form && (
        <Modal title={editingId ? t.opencode.editServer : t.opencode.newServer} onClose={() => setForm(null)} wide>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t.opencode.name}><TextInput value={form.name} mono onChange={e => setForm({ ...form, name: e.target.value.toLowerCase() })} placeholder="ca2_ai" /></Field>
            <Field label={t.opencode.serverTitle}><TextInput value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></Field>
            <Field label={t.opencode.configDir} hint={t.opencode.configDirHint}><TextInput value={form.config_dir} mono onChange={e => setForm({ ...form, config_dir: e.target.value })} placeholder="/home/test/project/1C-opencode/config/main" /></Field>
            <Field label={t.opencode.url}><TextInput value={form.url} mono onChange={e => setForm({ ...form, url: e.target.value })} /></Field>
            <Field label={t.opencode.username}><TextInput value={form.username} mono onChange={e => setForm({ ...form, username: e.target.value })} /></Field>
            <Field label={editingId ? t.opencode.passwordKeep : t.opencode.password}><TextInput type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></Field>
            <Field label={t.opencode.bases} hint={t.opencode.basesHint}>
              <ChipsInput values={form.bases} onChange={v => setForm({ ...form, bases: v })} placeholder="ca2_ai" />
            </Field>
            <Field label={t.opencode.composeService}><TextInput value={form.compose_service} mono onChange={e => setForm({ ...form, compose_service: e.target.value })} placeholder="server-main" /></Field>
            <Field label={t.opencode.onecUser}><TextInput value={form.onec_user} mono onChange={e => setForm({ ...form, onec_user: e.target.value })} placeholder="agent" /></Field>
            <Field label={t.opencode.onecPassword} hint={t.opencode.onecCredsHint}><TextInput type="password" value={form.onec_password} onChange={e => setForm({ ...form, onec_password: e.target.value })} /></Field>
          </div>
          <div className="flex gap-4 mt-3">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} /> {t.common.enabled}</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.is_default} onChange={e => setForm({ ...form, is_default: e.target.checked })} /> {t.opencode.isDefault}</label>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Btn variant="outline" onClick={() => setForm(null)}>{t.common.cancel}</Btn>
            <Btn onClick={doSave}><Check size={15} /> {t.common.save}</Btn>
          </div>
        </Modal>
      )}

      {del && (
        <Confirm title={t.common.deleteConfirmLabel} message={t.opencode.deleteServerConfirm(del.name)} onConfirm={doDelete} onClose={() => setDel(null)} danger />
      )}
    </div>
  );
}

function ChipsInput({ values, onChange, placeholder }: { values: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState('');
  function commit() {
    const v = draft.trim().toLowerCase();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  }
  return (
    <div className={inputCls + ' flex flex-wrap items-center gap-1 py-1.5'}>
      {values.map(v => (
        <span key={v} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-xs">
          {v}
          <button onClick={() => onChange(values.filter(x => x !== v))} className="text-slate-400 hover:text-red-500"><X size={12} /></button>
        </span>
      ))}
      <input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); } }}
        onBlur={commit}
        placeholder={placeholder}
        className="flex-1 min-w-[80px] bg-transparent outline-none text-sm"
      />
    </div>
  );
}

// ─── Конфиг (opencode.jsonc) ────────────────────────────────────────

function ConfigTab({ server }: { server: OpencodeServer }) {
  const [content, setContent] = useState('');
  const [exists, setExists] = useState(true);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.getOpencodeConfig(server.id);
      setContent(r.content || '');
      setExists(r.exists);
      setParseErr(r.error || null);
    } catch (e) { setErr(errText(e, 'Ошибка')); }
  }, [server.id]);

  useEffect(() => { load(); }, [load]);

  async function doSave() {
    setMsg(''); setErr('');
    try {
      const r = await api.putOpencodeConfig(server.id, content);
      setMsg(t.opencode.configSaveOk(r.path));
      load();
    } catch (e) { setErr(errText(e, 'Ошибка')); }
  }

  return (
    <div>
      {!exists && <div className="mb-3"><Alert tone="amber">{t.opencode.configMissing}</Alert></div>}
      {parseErr && <div className="mb-3"><Alert tone="red">JSON: {parseErr}</Alert></div>}
      {msg && <div className="mb-3"><Alert tone="blue">{msg}</Alert></div>}
      {err && <div className="mb-3"><Alert tone="red">{err}</Alert></div>}
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">{t.opencode.configHint}</p>
      <TextArea mono value={content} onChange={e => setContent(e.target.value)} rows={26} spellCheck={false} />
      <div className="flex justify-end mt-2">
        <Btn onClick={doSave}><Check size={15} /> {t.common.save}</Btn>
      </div>
    </div>
  );
}

// ─── Агенты ─────────────────────────────────────────────────────────

interface AgentForm { name: string; frontmatter: string; body: string; }

function AgentsTab({ server }: { server: OpencodeServer }) {
  const [agents, setAgents] = useState<(AgentForm & { description?: string; mode?: string })[]>([]);
  const [form, setForm] = useState<AgentForm | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [del, setDel] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.getOpencodeAgents(server.id);
      setAgents(r.agents.map(a => ({ name: a.name, frontmatter: a.frontmatter || '', body: a.body, description: a.description, mode: a.mode })));
    } catch (e) { setErr(errText(e, 'Ошибка')); }
  }, [server.id]);

  useEffect(() => { load(); }, [load]);

  async function doSave() {
    if (!form) return;
    setErr('');
    try {
      await api.putOpencodeAgent(server.id, form);
      setForm(null); load();
    } catch (e) { setErr(errText(e, 'Ошибка')); }
  }

  async function doDelete() {
    if (!del) return;
    try { await api.deleteOpencodeAgent(server.id, del); setDel(null); load(); }
    catch (e) { setErr(errText(e, 'Ошибка')); }
  }

  return (
    <div>
      {err && <div className="mb-3"><Alert tone="red">{err}</Alert></div>}
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">{t.opencode.agentsHint}</p>
      <div className="flex justify-end mb-2">
        <Btn onClick={() => { setIsNew(true); setForm({ name: '', frontmatter: 'mode: primary\n', body: '' }); }}>
          <Plus size={15} /> {t.opencode.newAgent}
        </Btn>
      </div>
      <TableShell colSpan={3} empty={agents.length === 0 ? { text: t.studio.noAgents } : null}
        head={<><Th>{t.opencode.agentName}</Th><Th>{t.skills.description}</Th><Th className="text-right">{t.common.actions}</Th></>}>
        {agents.map(a => (
          <Row key={a.name}>
            <Td><span className={monoCls + ' text-xs'}>{a.name}</span>{a.mode && <Badge tone="neutral">{a.mode}</Badge>}</Td>
            <Td><span className="text-sm">{a.description || '—'}</span></Td>
            <Td className="text-right">
              <div className="flex gap-0.5 justify-end">
                <IconBtn title={t.common.edit} onClick={() => { setIsNew(false); setForm({ ...a }); }}><Pencil size={14} /></IconBtn>
                <IconBtn title={t.common.delete} onClick={() => setDel(a.name)}><Trash2 size={14} /></IconBtn>
              </div>
            </Td>
          </Row>
        ))}
      </TableShell>

      {form && (
        <Modal title={isNew ? t.opencode.newAgent : `Агент: ${form.name}`} onClose={() => setForm(null)} xwide fill>
          <Field label={t.opencode.agentName} hint="^[a-z0-9_-]+$"><TextInput mono value={form.name} disabled={!isNew} onChange={e => setForm({ ...form, name: e.target.value.toLowerCase() })} /></Field>
          <Field label="Frontmatter (YAML)" hint="description, mode, model, permissions — как в agents/<имя>.md" className="mt-3">
            <TextArea mono value={form.frontmatter} onChange={e => setForm({ ...form, frontmatter: e.target.value })} rows={8} spellCheck={false} placeholder={'description: …\nmode: primary\nmodel: local-12600/qwen3.8'} />
          </Field>
          <TextArea mono value={form.body} onChange={e => setForm({ ...form, body: e.target.value })} rows={14} className="mt-3" spellCheck={false} placeholder="Системный промпт агента (Markdown)" />
          <div className="flex justify-end gap-2 mt-4">
            <Btn variant="outline" onClick={() => setForm(null)}>{t.common.cancel}</Btn>
            <Btn onClick={doSave}><Check size={15} /> {t.common.save}</Btn>
          </div>
        </Modal>
      )}

      {del && (
        <Confirm title={t.common.deleteConfirmLabel} message={t.opencode.deleteAgentConfirm(del)} onConfirm={doDelete} onClose={() => setDel(null)} danger />
      )}
    </div>
  );
}

// ─── Скилы ──────────────────────────────────────────────────────────

interface SkillForm { name: string; description: string; body: string; }

function SkillsTab({ server }: { server: OpencodeServer }) {
  const [skills, setSkills] = useState<SkillForm[]>([]);
  const [form, setForm] = useState<SkillForm | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [del, setDel] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.getOpencodeSkills(server.id);
      setSkills(r.skills.map(s => ({ name: s.name, description: s.description || '', body: s.body })));
    } catch (e) { setErr(errText(e, 'Ошибка')); }
  }, [server.id]);

  useEffect(() => { load(); }, [load]);

  async function doSave() {
    if (!form) return;
    setErr('');
    try { await api.putOpencodeSkill(server.id, form); setForm(null); load(); }
    catch (e) { setErr(errText(e, 'Ошибка')); }
  }

  async function doDelete() {
    if (!del) return;
    try { await api.deleteOpencodeSkill(server.id, del); setDel(null); load(); }
    catch (e) { setErr(errText(e, 'Ошибка')); }
  }

  return (
    <div>
      {err && <div className="mb-3"><Alert tone="red">{err}</Alert></div>}
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">{t.opencode.skillsHint}</p>
      <div className="flex justify-end mb-2">
        <Btn onClick={() => { setIsNew(true); setForm({ name: '', description: '', body: '' }); }}>
          <Plus size={15} /> {t.opencode.newSkill}
        </Btn>
      </div>
      <TableShell colSpan={3} empty={skills.length === 0 ? { text: t.skills.noSkills } : null}
        head={<><Th>{t.opencode.skillName}</Th><Th>{t.skills.description}</Th><Th right>{t.common.actions}</Th></>}>
        {skills.map(s => (
          <Row key={s.name}>
            <Td><span className={monoCls + ' text-xs'}>{s.name}</span></Td>
            <Td><span className="text-sm">{s.description || '—'}</span></Td>
            <Td className="text-right">
              <div className="flex gap-0.5 justify-end">
                <IconBtn title={t.common.edit} onClick={() => { setIsNew(false); setForm({ ...s }); }}><Pencil size={14} /></IconBtn>
                <IconBtn title={t.common.delete} onClick={() => setDel(s.name)}><Trash2 size={14} /></IconBtn>
              </div>
            </Td>
          </Row>
        ))}
      </TableShell>

      {form && (
        <Modal title={isNew ? t.opencode.newSkill : `Скилл: ${form.name}`} onClose={() => setForm(null)} xwide fill>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t.opencode.skillName} hint="^[a-z0-9]+(-[a-z0-9]+)*$"><TextInput mono value={form.name} disabled={!isNew} onChange={e => setForm({ ...form, name: e.target.value.toLowerCase() })} /></Field>
            <Field label={t.skills.description}><TextInput value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></Field>
          </div>
          <TextArea mono value={form.body} onChange={e => setForm({ ...form, body: e.target.value })} rows={18} className="mt-3" spellCheck={false} />
          <div className="flex justify-end gap-2 mt-4">
            <Btn variant="outline" onClick={() => setForm(null)}>{t.common.cancel}</Btn>
            <Btn onClick={doSave}><Check size={15} /> {t.common.save}</Btn>
          </div>
        </Modal>
      )}

      {del && (
        <Confirm title={t.common.deleteConfirmLabel} message={t.opencode.deleteSkillConfirm(del)} onConfirm={doDelete} onClose={() => setDel(null)} danger />
      )}
    </div>
  );
}

// ─── Инструменты 1С ─────────────────────────────────────────────────

function ToolsTab({ server, onChanged }: { server: OpencodeServer; onChanged: () => void }) {
  const [toolCount, setToolCount] = useState<number | null>(null);
  const [token, setToken] = useState('');
  const [syncMsg, setSyncMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [testTool, setTestTool] = useState('');
  const [testArgs, setTestArgs] = useState('{}');
  const [testResult, setTestResult] = useState<string>('');
  const [pluginGenerated, setPluginGenerated] = useState(false);
  const [depsInstalled, setDepsInstalled] = useState(false);

  const load = useCallback(async () => {
    try {
      // Каталог читаем через конфиг-эндпоинт: нет отдельного GET /tools — парсим tools/sync ответ.
      // Показываем из каталога, если есть (через status). Пока используем sync-result.
      const r = await api.getOpencodePluginToken(server.id);
      setToken(r.token);
    } catch { /* нет токена — ок */ }
    try {
      const st = await api.getOpencodeStatus();
      const me = (st.servers as any[]).find((s: any) => s.id === server.id || s.name === server.name);
      if (me) { setPluginGenerated(!!me.plugin_generated); setDepsInstalled(!!me.deps_installed); }
    } catch { /* status недоступен — ок */ }
  }, [server.id, server.name]);

  useEffect(() => { load(); }, [load]);

  async function doInstallDeps() {
    setErr(''); setBusy(true);
    try {
      const r = await api.opencodeToolsInstallDeps(server.id);
      setSyncMsg(`Зависимости установлены: ${r.dir}`);
    } catch (e) { setErr(errText(e, 'Ошибка npm install')); }
    finally { setBusy(false); }
  }

  async function doApply() {
    setErr(''); setBusy(true);
    try {
      const r = await api.opencodeToolsApply(server.id);
      setToolCount(r.synced);
      const parts = [`Синхронизировано: ${r.synced}`, `Сгенерирован плагин: ${r.generated}`];
      if (r.changed) parts.push(r.restarted ? 'Контейнер перезапущен' : 'Каталог изменился, но контейнер не перезапущен (нет compose-сервиса)');
      else parts.push('Каталог не изменился — рестарт пропущен');
      setSyncMsg(parts.join(' · '));
      onChanged();
    } catch (e) { setErr(errText(e, 'Ошибка применения')); }
    finally { setBusy(false); }
  }

  async function doTest() {
    setErr(''); setTestResult('');
    let args: Record<string, unknown> = {};
    try { args = testArgs.trim() ? JSON.parse(testArgs) : {}; } catch { setErr('Аргументы: некорректный JSON'); return; }
    setBusy(true);
    try {
      const r = await api.opencodeToolsTest(server.id, testTool, args);
      setTestResult(JSON.stringify(r.result, null, 2));
    } catch (e) { setErr(errText(e, 'Ошибка теста')); }
    finally { setBusy(false); }
  }

  return (
    <div>
      {toolCount !== null && (
        <div className="mb-3"><Badge tone="green">В каталоге: {toolCount} инструментов</Badge></div>
      )}
      <div className="flex gap-2 mb-3">
        <Badge tone={pluginGenerated ? 'green' : 'amber'}>{t.opencode.pluginState(pluginGenerated)}</Badge>
        <Badge tone={depsInstalled ? 'green' : 'amber'}>{t.opencode.depsState(depsInstalled)}</Badge>
      </div>
      {syncMsg && <div className="mb-3"><Alert tone="blue">{syncMsg}</Alert></div>}
      {err && <div className="mb-3"><Alert tone="red">{err}</Alert></div>}
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">{t.opencode.toolsHint}</p>

      <div className="flex gap-2 mb-4">
        <Btn onClick={doApply} disabled={busy}><RefreshCw size={15} className={busy ? 'animate-spin' : ''} /> {t.opencode.toolsApply}</Btn>
        <Btn variant="outline" onClick={doInstallDeps} disabled={busy}><Package size={15} /> {t.opencode.toolsInstallDeps}</Btn>
        {token && (
          <span className="inline-flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <KeyRound size={13} /> {t.opencode.pluginToken}: <code className={monoCls}>{token.slice(0, 16)}…</code>
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label={t.opencode.toolsTool}>
          <TextInput mono value={testTool} onChange={e => setTestTool(e.target.value)} placeholder="get_configuration_info" />
        </Field>
        <Field label={t.opencode.toolsArgs}>
          <TextArea mono value={testArgs} onChange={e => setTestArgs(e.target.value)} rows={2} spellCheck={false} />
        </Field>
      </div>
      <div className="flex gap-2 mt-3">
        <Btn onClick={doTest} disabled={busy || !testTool}><Play size={15} /> {t.opencode.toolsTest}</Btn>
      </div>
      {testResult && (
        <pre className={monoCls + ' text-xs mt-3 p-3 rounded-lg bg-slate-100 dark:bg-slate-900 overflow-auto max-h-80 whitespace-pre-wrap'}>{testResult}</pre>
      )}
    </div>
  );
}

// ─── Сессии ─────────────────────────────────────────────────────────

function SessionsTab({ serverId }: { serverId: string }) {
  const [all, setAll] = useState<{ session_id: string; server: string; user?: string | null; base?: string | null; has_jwt: boolean; expires_at: number }[]>([]);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.getOpencodeSessions();
      setAll(r.sessions);
    } catch (e) { setErr(errText(e, 'Ошибка')); }
  }, []);

  // Фильтр по выбранному серверу (server — id сервера из реестра шлюза).
  const sessions = all.filter(s => s.server === serverId);

  useEffect(() => { load(); }, [load]);

  async function doDrop(id: string) {
    try { await api.dropOpencodeSession(id); load(); }
    catch (e) { setErr(errText(e, 'Ошибка')); }
  }

  return (
    <div>
      {err && <div className="mb-3"><Alert tone="red">{err}</Alert></div>}
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">{t.opencode.sessionsHint}</p>
      <div className="flex justify-end mb-2">
        <Btn variant="outline" onClick={load}><RefreshCw size={15} /> {t.common.refresh}</Btn>
      </div>
      <TableShell colSpan={5} empty={sessions.length === 0 ? { text: t.opencode.noSessions } : null}
        head={<><Th>Session</Th><Th>{t.opencode.sessionUser}</Th><Th>{t.opencode.sessionBase}</Th><Th>{t.opencode.sessionJwT}</Th><Th right>{t.common.actions}</Th></>}>
        {sessions.map(s => (
          <Row key={s.session_id}>
            <Td><span className={monoCls + ' text-xs'}>{s.session_id.slice(0, 24)}…</span></Td>
            <Td><span className="text-sm">{s.user || '—'}</span></Td>
            <Td>{s.base ? <Badge tone="sky">{s.base}</Badge> : '—'}</Td>
            <Td>{s.has_jwt ? <Badge tone="green">да</Badge> : <Badge tone="red">нет</Badge>}</Td>
            <Td className="text-right"><IconBtn title={t.opencode.dropSession} onClick={() => doDrop(s.session_id)}><Trash2 size={14} /></IconBtn></Td>
          </Row>
        ))}
      </TableShell>
    </div>
  );
}
