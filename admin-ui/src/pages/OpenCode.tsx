import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, Play, Square, RotateCw, Check, X, RefreshCw, KeyRound, Package, Network, ChevronRight, Server as ServerIcon, MessageSquare } from 'lucide-react';
import * as yaml from 'js-yaml';
import { api } from '../api/client';
import type { ModelProvider, OpencodeServer } from '../types';
import { t } from '../i18n';
import { errText } from '../errors';
import { PageHeader, Btn, IconBtn, Badge, TableShell, Th, Td, Row, TextInput, TextArea, Select, Field, Alert, Modal, Confirm, Segmented, inputCls, monoCls } from '../components/ui';

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
      <TableShell colSpan={6} empty={st.servers.length === 0 ? { text: t.opencode.noServers } : null}
        head={<><Th>{t.opencode.name}</Th><Th>{t.opencode.url}</Th><Th>{t.opencode.stateCol}</Th><Th>{t.opencode.pluginCol}</Th><Th>{t.opencode.tokenCol}</Th><Th>{t.opencode.depsCol}</Th></>}>
        {st.servers.map((s: any) => (
          <Row key={s.id}>
            <Td><span className="font-medium">{s.name}</span>{s.is_default && <span className="ml-2"><Badge tone="green">{t.opencode.defaultBadge}</Badge></span>}</Td>
            <Td><span className={monoCls + ' text-xs'}>{s.url}</span></Td>
            <Td><Badge tone={s.healthy ? 'green' : 'red'}>{s.healthy ? t.opencode.upState : t.opencode.downState}</Badge></Td>
            <Td><Badge tone={s.plugin_generated ? 'green' : 'amber'}>{s.plugin_generated ? '✓' : '—'}</Badge></Td>
            <Td>{!s.plugin_generated
              ? <span className="text-slate-400 dark:text-slate-500 text-xs">—</span>
              : s.plugin_stale
                ? <span title={t.opencode.tokenStale}><Badge tone="red">{t.opencode.tokenStale}</Badge></span>
                : <Badge tone="green">{t.opencode.tokenOk}</Badge>}</Td>
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

/// Алиасы выгрузок code-index (соответствуют записям MCP `code-index-<алиас>`).
const CODE_INDEX_ALIASES = ['ka2', 'erp', 'ktm', 'upp', 'obrabotki', 'erp_ext', 'ka_market_ext', 'ka_rs_ext', 'ka_td_ext'];

interface ServerForm {
  name: string; title: string; config_dir: string; url: string; username: string;
  password: string; bases: string[]; compose_service: string; compose_profile: string;
  onec_user: string; onec_password: string; enabled: boolean; is_default: boolean;
  visible_agents: string[]; code_indexes: string[];
}

const emptyForm: ServerForm = {
  name: '', title: '', config_dir: '', url: 'http://127.0.0.1:4040', username: 'opencode',
  password: '', bases: [], compose_service: '', compose_profile: '', onec_user: '', onec_password: '', enabled: true, is_default: false,
  visible_agents: [], code_indexes: [],
};

function ServersTab({ servers, onChanged, onPick, selId }: { servers: OpencodeServer[]; onChanged: () => void; onPick: (id: string) => void; selId: string }) {
  const [form, setForm] = useState<ServerForm | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [del, setDel] = useState<OpencodeServer | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const [agentNames, setAgentNames] = useState<string[]>([]);

  function openNew() { setEditingId(null); setForm({ ...emptyForm }); setAgentNames([]); }
  async function openEdit(s: OpencodeServer) {
    setEditingId(s.id);
    setForm({
      name: s.name, title: s.title, config_dir: s.config_dir, url: s.url, username: s.username,
      password: '', bases: [...s.bases], compose_service: s.compose_service, compose_profile: s.compose_profile,
      onec_user: s.onec_user, onec_password: '', enabled: s.enabled, is_default: s.is_default,
      visible_agents: [...(s.visible_agents || [])], code_indexes: [...(s.code_indexes || [])],
    });
    // Загружаем список агентов сервера для чекбоксов.
    try {
      const r = await api.getOpencodeAgents(s.id);
      setAgentNames(r.agents.map(a => a.name));
    } catch { setAgentNames([]); }
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
        visible_agents: form.visible_agents, code_indexes: form.code_indexes,
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
          {editingId && agentNames.length > 0 && (
            <div className="mt-3">
              <div className="text-sm font-medium mb-1">{t.opencode.visibleAgents}</div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">{t.opencode.visibleAgentsHint}</p>
              <div className="flex flex-wrap gap-3">
                {agentNames.map(name => (
                  <label key={name} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={form.visible_agents.includes(name)}
                      onChange={e => setForm({
                        ...form,
                        visible_agents: e.target.checked
                          ? [...form.visible_agents, name]
                          : form.visible_agents.filter(n => n !== name),
                      })}
                    />
                    {name}
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="mt-3">
            <div className="text-sm font-medium mb-1">{t.opencode.codeIndexes}</div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">{t.opencode.codeIndexesHint}</p>
            <div className="flex flex-wrap gap-3">
              {CODE_INDEX_ALIASES.map(alias => (
                <label key={alias} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={form.code_indexes.includes(alias)}
                    onChange={e => setForm({
                      ...form,
                      code_indexes: e.target.checked
                        ? [...form.code_indexes, alias]
                        : form.code_indexes.filter(n => n !== alias),
                    })}
                  />
                  <span className={monoCls}>{alias}</span>
                </label>
              ))}
            </div>
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

function ChipsInput({ values, onChange, placeholder, mono }: { values: string[]; onChange: (v: string[]) => void; placeholder?: string; mono?: boolean }) {
  const [draft, setDraft] = useState('');
  function commit() {
    // lower-case только для имён каталогов (видимые агенты); имена моделей
    // сохраняем как ввели — префикс провайдера case-sensitive.
    const v = mono ? draft.trim() : draft.trim().toLowerCase();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  }
  return (
    <div className={inputCls + ' flex flex-wrap items-center gap-1 py-1.5'}>
      {values.map(v => (
        <span key={v} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-xs ${mono ? monoCls : ''}`}>
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
        className={`flex-1 min-w-[80px] bg-transparent outline-none text-sm ${mono ? monoCls : ''}`}
      />
    </div>
  );
}

// ─── Конфиг (opencode.jsonc) ────────────────────────────────────────

/// Выбор MCP-серверов из админки для секции mcp.servers в opencode.jsonc.
/// Стиль — как McpSelect в редакторе агента (AgentStudio).
function McpPicker({ serverId, selected, onChange }: {
  serverId: string;
  selected: Record<string, boolean>; // name → disabled
  onChange: (next: Record<string, boolean>) => void;
}) {
  const [options, setOptions] = useState<{ name: string; transport: string; running: boolean }[] | null>(null);

  useEffect(() => {
    let alive = true;
    api.getOpencodeMcpOptions(serverId)
      .then(r => { if (alive) setOptions(r.servers); })
      .catch(() => { if (alive) setOptions(null); });
    return () => { alive = false; };
  }, [serverId]);

  function toggle(name: string) {
    const next = { ...selected };
    if (next[name] !== undefined) delete next[name];
    else next[name] = true; // new → disabled by default
    onChange(next);
  }

  if (options === null) return <span className="text-xs text-slate-400">Загрузка…</span>;
  if (options.length === 0) return <span className="text-xs text-slate-400">Нет включённых MCP-серверов в админке</span>;

  const sorted = [...options].sort((a, b) =>
    ((b.running ? 1 : 0) - (a.running ? 1 : 0)) || a.name.localeCompare(b.name));
  // Extra entries in selected that are not in options (external / removed).
  const extra = Object.keys(selected).filter(n => !sorted.some(o => o.name === n));

  return (
    <div>
      <div className="border border-slate-300 dark:border-slate-700 rounded-lg p-2 overflow-y-auto flex flex-col gap-0 bg-slate-50 dark:bg-slate-950 max-h-48">
        {sorted.map(s => {
          const dis = selected[s.name] !== undefined && selected[s.name];
          return (
            <label key={s.name} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 px-1 py-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer"
              title={`${s.name} (${s.transport})${dis ? ' — выключен' : ''}`}>
              <input type="checkbox" checked={selected[s.name] !== undefined} onChange={() => toggle(s.name)} className="rounded accent-blue-600 shrink-0" />
              <span className="font-mono break-all">{s.name}</span>
              {dis && <Badge tone="neutral">disabled</Badge>}
              {s.running && <span className="text-[10px] text-emerald-500 shrink-0">●</span>}
            </label>
          );
        })}
        {extra.map(name => (
          <label key={name} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 px-1 py-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer" title="Внешний (нет в списке админки)">
            <input type="checkbox" checked onChange={() => toggle(name)} className="rounded accent-blue-600 shrink-0" />
            <span className="font-mono break-all">{name}</span>
            {selected[name] && <Badge tone="neutral">disabled</Badge>}
            <Badge tone="sky">внешний</Badge>
          </label>
        ))}
      </div>
    </div>
  );
}

/// Выбор провайдеров и моделей из вкладки «Модели» админки.
/// Состояние: selected[providerName] = Set<model>. Изменения — локально,
/// PUT уходит только по кнопке «Сохранить».
function ProviderPicker({ providers, selected, onChange }: {
  providers: ModelProvider[];
  selected: Record<string, string[]>;
  onChange: (next: Record<string, string[]>) => void;
}) {
  const enabled = providers.filter(p => p.enabled && p.models.length > 0);
  if (enabled.length === 0) return <span className="text-xs text-slate-400">Нет доступных провайдеров</span>;

  function toggleProvider(pname: string, models: string[]) {
    const next = { ...selected };
    if (next[pname] && next[pname].length > 0) delete next[pname];
    else next[pname] = [...models];
    onChange(next);
  }

  function toggleModel(pname: string, m: string) {
    const cur = selected[pname] || [];
    const next = { ...selected };
    if (cur.includes(m)) {
      const filtered = cur.filter(x => x !== m);
      if (filtered.length === 0) delete next[pname]; else next[pname] = filtered;
    } else {
      next[pname] = [...cur, m];
    }
    onChange(next);
  }

  return (
    <div className="space-y-2">
      {enabled.map(p => {
        const pname = p.name;
        const sel = selected[pname] || [];
        const allSelected = p.models.every(m => sel.includes(m));
        return (
          <div key={p.id} className="border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => toggleProvider(pname, p.models)}
                className="accent-blue-600"
              />
              <span className="font-medium text-sm">{pname}</span>
              <span className="text-xs text-slate-400 font-mono truncate max-w-[280px]">{p.base_url}</span>
            </label>
            {sel.length > 0 && (
              <div className="mt-1.5 ml-6 flex flex-wrap gap-x-3 gap-y-1">
                {p.models.map(m => (
                  <label key={m} className="flex items-center gap-1.5 cursor-pointer text-xs">
                    <input
                      type="checkbox"
                      checked={sel.includes(m)}
                      onChange={() => toggleModel(pname, m)}
                      className="accent-blue-600"
                    />
                    <span className="font-mono">{m}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ConfigTab({ server }: { server: OpencodeServer }) {
  const [content, setContent] = useState('');
  const [exists, setExists] = useState(true);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  // Выбранные провайдеры/модели: <name из вкладки «Модели»> → [model, ...]. Локальное состояние.
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [defaultModel, setDefaultModel] = useState('');
  // MCP-серверы: name → disabled (true = выключен). Пусто = не выбран.
  const [mcpSelected, setMcpSelected] = useState<Record<string, boolean>>({});
  const [mcpBaseUrl, setMcpBaseUrl] = useState('');
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [providerStatus, setProviderStatus] = useState<Record<string, { available: boolean; context?: number; error?: string }>>({});
  const [loaded, setLoaded] = useState(false);
  // Пока пользователь печатает в textarea — не затираем его текст автосборкой.
  const editingRef = useRef(false);

  // Перечитать файл + модели из providers + провайдеры админки.
  async function loadAll() {
    try {
      const [cfgR, modelsR, provR] = await Promise.all([
        api.getOpencodeConfig(server.id),
        api.getOpencodeConfigModels(server.id),
        api.getModelProviders(),
      ]);
      setExists(cfgR.exists);
      setParseErr(cfgR.error || null);
      if (modelsR.providers_status) setProviderStatus(modelsR.providers_status);
      setProviders(provR);

      // Инициализация selected из секции providers в конфиге.
      const sel: Record<string, string[]> = {};
      try {
        const cfg = JSON.parse(stripJsonc(cfgR.content || ''));
        if (cfg?.providers && typeof cfg.providers === 'object') {
          for (const [pname, pval] of Object.entries<any>(cfg.providers)) {
            const ms = Object.keys(pval?.models || {});
            if (ms.length > 0) sel[pname] = ms;
          }
        }
      } catch { /* контент не парсится — чекбоксы будут пустыми */ }
      setSelected(sel);

      // Default model из файла.
      let dm = '';
      try {
        const cfg = JSON.parse(stripJsonc(cfgR.content || ''));
        dm = typeof cfg?.model === 'string' ? cfg.model : '';
      } catch { /* ignore */ }
      setDefaultModel(dm);

      // MCP-серверы из mcp.servers: name → disabled.
      const mcpSel: Record<string, boolean> = {};
      try {
        const cfg = JSON.parse(stripJsonc(cfgR.content || ''));
        const servers = cfg?.mcp?.servers;
        if (servers && typeof servers === 'object') {
          for (const [name, val] of Object.entries<any>(servers)) {
            mcpSel[name] = val?.disabled === true;
          }
        }
      } catch { /* ignore */ }
      setMcpSelected(mcpSel);

      // Базовый URL MCP-шлюза — из первой записи (type: remote → url).
      let base = '';
      try {
        const cfg = JSON.parse(stripJsonc(cfgR.content || ''));
        const servers = cfg?.mcp?.servers;
        if (servers && typeof servers === 'object') {
          for (const val of Object.values<any>(servers)) {
            if (val?.url && typeof val.url === 'string') {
              // Берём origin из первого URL.
              try { base = new URL(val.url).origin; } catch { base = val.url.replace(/\/api\/mcp\/.*$/, ''); }
              break;
            }
          }
        }
      } catch { /* ignore */ }
      setMcpBaseUrl(base);

      // Контент — как в файле (автосборка перезапишет при первом изменении блоков).
      editingRef.current = false;
      setContent(cfgR.content || '');

      setLoaded(true);
    } catch (e) { setErr(errText(e, 'Ошибка')); }
  }

  useEffect(() => { loadAll(); }, [server.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Полный список моделей из selected: <name>/<model>.
  const allModels: string[] = Object.entries(selected).flatMap(([p, ms]) => ms.map(m => `${p}/${m}`));

  // baseURL провайдера: имя совпадает с именем на вкладке «Модели».
  function providerBaseUrl(pname: string): string | null {
    const p = providers.find(x => x.name === pname);
    return p?.base_url || null;
  }

  // Сборка итогового JSON из textarea + selected + defaultModel.
  // Все изменения — только в окне редактирования; файл пишется по кнопке.
  function buildConfig(): string {
    let cfg: any = {};
    try {
      const parsed = JSON.parse(stripJsonc(content));
      if (parsed && typeof parsed === 'object') cfg = parsed;
    } catch { /* контент не парсится — начинаем с пустого объекта */ }

    // providers: только выбранные (selected). Снятые — удаляются.
    const provs: Record<string, any> = {};
    for (const [pname, ms] of Object.entries(selected)) {
      if (ms.length === 0) continue;
      const base_url = providerBaseUrl(pname);
      // Существующая секция (ручная правка) — сохраняем её структуру.
      const existing: any = cfg.providers?.[pname] || {};
      const modelsObj: Record<string, any> = {};
      for (const m of ms) {
        const prev = existing.models?.[m];
        const ctx = providerStatus[pname]?.context || 32768;
        modelsObj[m] = prev && typeof prev === 'object' ? prev : {
          modelID: m,
          name: m,
          capabilities: { input: ['text'], output: ['text'], tools: true },
          limit: { context: ctx, output: 4096 },
        };
      }
      provs[pname] = {
        ...existing,
        models: modelsObj,
        name: pname,
        package: existing.package || 'aisdk:@ai-sdk/openai-compatible',
        settings: { baseURL: base_url || existing.settings?.baseURL || '' },
      };
    }
    cfg.providers = provs;

    // Default model: одна строка или удаление ключа.
    // Если провайдер/модель сняты — сбрасываем, чтобы не было «висящей» ссылки.
    const dm = defaultModel || '';
    if (dm) {
      const slash = dm.indexOf('/');
      const pPart = slash > 0 ? dm.slice(0, slash) : dm;
      const mPart = slash > 0 ? dm.slice(slash + 1) : '';
      if ((provs[pPart]?.models && provs[pPart].models[mPart]) || (slash < 0 && provs[dm])) {
        cfg.model = dm;
      } else {
        delete cfg.model;
      }
    } else {
      delete cfg.model;
    }

    // mcp.servers: только выбранные (mcpSelected). Снятые — удаляются.
    const base = mcpBaseUrl || window.location.origin;
    const mcpServers: Record<string, any> = {};
    for (const [name, disabled] of Object.entries(mcpSelected)) {
      // Существующая запись (ручная правка) — сохраняем прочие поля.
      const prev = cfg.mcp?.servers?.[name];
      mcpServers[name] = {
        ...(prev && typeof prev === 'object' ? prev : {}),
        type: 'remote',
        url: `${base.replace(/\/$/, '')}/api/mcp/${encodeURIComponent(name)}`,
        oauth: false,
        disabled,
      };
    }
    if (Object.keys(mcpServers).length > 0) {
      cfg.mcp = { ...cfg.mcp, servers: mcpServers };
    } else {
      delete cfg.mcp;
    }

    // models[] — нестандартный ключ OpenCode, удаляем.
    delete cfg.models;

    return JSON.stringify(cfg, null, 2) + '\n';
  }

  // Живое отражение: при изменении чекбоксов / default model / MCP пересобираем
  // textarea (если пользователь не печатает в нём прямо сейчас).
  useEffect(() => {
    if (!loaded || editingRef.current) return;
    setContent(buildConfig());
  }, [selected, defaultModel, mcpSelected, mcpBaseUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Если сняли провайдера/модель, на которую ссылается default model — сбрасываем её.
  useEffect(() => {
    if (!loaded || !defaultModel) return;
    const slash = defaultModel.indexOf('/');
    const pPart = slash > 0 ? defaultModel.slice(0, slash) : defaultModel;
    const mPart = slash > 0 ? defaultModel.slice(slash + 1) : '';
    if (slash < 0 || !selected[pPart]?.includes(mPart)) {
      setDefaultModel('');
    }
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  async function doSave() {
    setSaving(true); setMsg(''); setErr('');
    try {
      // Итоговый JSON — уже в textarea (автосборка). Записываем файл как есть.
      const r = await api.putOpencodeConfig(server.id, content);
      setMsg(t.opencode.configSaveOk(r.path));
      // Перечитать статусы провайдеров (лимиты могли обновиться).
      try {
        const modelsR = await api.getOpencodeConfigModels(server.id);
        if (modelsR.providers_status) setProviderStatus(modelsR.providers_status);
      } catch { /* ignore */ }
    } catch (e) { setErr(errText(e, 'Ошибка')); }
    finally { setSaving(false); }
  }

  // Перечитать конфиг из файла (отменить локальные изменения).
  async function doReload() {
    setMsg(''); setErr('');
    try {
      await loadAll();
      setMsg(t.opencode.configReloaded);
    } catch (e) { setErr(errText(e, 'Ошибка')); }
  }

  return (
    <div>
      {!exists && <div className="mb-3"><Alert tone="amber">{t.opencode.configMissing}</Alert></div>}
      {parseErr && <div className="mb-3"><Alert tone="red">JSON: {parseErr}</Alert></div>}
      {msg && <div className="mb-3"><Alert tone="blue">{msg}</Alert></div>}
      {err && <div className="mb-3"><Alert tone="red">{err}</Alert></div>}
      {loaded && (
        <>
          {/* Провайдеры и модели из админки */}
          <Field label={t.opencode.configProvidersTitle} hint={t.opencode.configProvidersHint}>
            <ProviderPicker providers={providers} selected={selected} onChange={setSelected} />
            {/* Статусы провайдеров */}
            {Object.keys(providerStatus).length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {Object.entries(providerStatus).map(([pname, st]) => (
                  <div key={pname} className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs ${
                    st.available 
                      ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400' 
                      : 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400'
                  }`}>
                    <span className={`w-2 h-2 rounded-full ${st.available ? 'bg-emerald-500' : 'bg-red-500'}`} />
                    <span className="font-medium">{pname}</span>
                    {st.available && st.context && (
                      <span className="text-slate-500 dark:text-slate-400">ctx {(st.context / 1024).toFixed(0)}k</span>
                    )}
                    {!st.available && st.error && (
                      <span className="text-red-600 dark:text-red-400 truncate max-w-[200px]">{st.error}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Field>

          {/* MCP-серверы из админки */}
          <Field label={t.opencode.configMcpTitle} hint={t.opencode.configMcpHint}>
            <div className="space-y-2">
              <McpPicker serverId={server.id} selected={mcpSelected} onChange={setMcpSelected} />
              <TextInput
                value={mcpBaseUrl}
                onChange={e => setMcpBaseUrl(e.target.value)}
                placeholder={window.location.origin}
                mono
              />
            </div>
          </Field>

          {/* Модель по умолчанию */}
          <Field label={t.opencode.configDefaultModelTitle} hint={t.opencode.configDefaultModelHint}>
            <Select value={defaultModel} onChange={e => setDefaultModel(e.target.value)} className="max-w-md">
              <option value="">{t.opencode.configDefaultModelNone}</option>
              {allModels.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </Select>
          </Field>
        </>
      )}
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-2 mt-3">{t.opencode.configHint}</p>
      <TextArea
        mono
        value={content}
        onChange={e => { editingRef.current = true; setContent(e.target.value); }}
        onBlur={() => {
          editingRef.current = false;
          // После потери фокуса — пересобрать, чтобы блоки и текст были синхронны.
          setContent(buildConfig());
        }}
        rows={26}
        spellCheck={false}
      />
      <div className="flex justify-end gap-2 mt-2">
        <Btn variant="outline" onClick={doReload}><RefreshCw size={15} /> {t.opencode.configReload}</Btn>
        <Btn onClick={doSave} disabled={saving}><Check size={15} /> {t.common.save}</Btn>
      </div>
    </div>
  );
}


// ─── Агенты ─────────────────────────────────────────────────────────

/// Убирает // и /* */ комментарии вне строк (JSONC → JSON).
function stripJsonc(s: string): string {
  let out = '';
  let inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true; out += c;
    } else if (c === '/' && n === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

/// Имена MCP-серверов из opencode.jsonc (mcp.servers) — для секции
/// «MCP-серверы» в редакторе разрешений. Ошибки → пустой список.
async function loadMcpServerNames(serverId: string): Promise<string[]> {
  try {
    const r = await api.getOpencodeConfig(serverId);
    if (!r.content) return [];
    const cfg = JSON.parse(stripJsonc(r.content));
    const names = Object.keys(cfg?.mcp?.servers ?? {});
    return names.filter((n: string) => typeof n === 'string');
  } catch { return []; }
}

type AgentMode = 'primary' | 'subagent' | 'all';

/// Эффект правила: Default = правила нет (штатная политика OpenCode).
type PermEffect = 'default' | 'allow' | 'ask' | 'deny';

interface PermsState { global: PermEffect; actions: Record<string, PermEffect>; }

/// Встроенные действия OpenCode v2 (docs/permissions) — фиксированный список строк.
const BUILTIN_ACTIONS = [
  'shell', 'edit', 'read', 'glob', 'grep', 'patch',
  'webfetch', 'websearch', 'skill', 'subagent', 'question', 'external_directory',
];

/// Правила разрешений агента из frontmatter.
interface PermRule { action: string; resource: string; effect: string; }

/// Парсит permissions из YAML-объекта (не из строки).
function parsePermsFromObj(obj: Record<string, unknown>): PermsState {
  const st: PermsState = { global: 'default', actions: {} };
  const perms = obj.permissions;
  if (!Array.isArray(perms)) return st;
  for (const rule of perms) {
    if (typeof rule !== 'object' || rule === null) continue;
    const r = rule as Record<string, unknown>;
    const action = typeof r.action === 'string' ? r.action : '';
    const effect = typeof r.effect === 'string' ? r.effect : '';
    if (!action || (effect !== 'allow' && effect !== 'ask' && effect !== 'deny')) continue;
    if (action === '*') st.global = effect;
    else st.actions[action] = effect;
  }
  return st;
}

/// Собирает правила permissions из PermsState.
function buildPermsRules(p: PermsState): PermRule[] {
  const rules: PermRule[] = [];
  if (p.global !== 'default') rules.push({ action: '*', resource: '*', effect: p.global });
  for (const a of BUILTIN_ACTIONS) {
    const e = p.actions[a];
    if (e && e !== 'default') rules.push({ action: a, resource: '*', effect: e });
  }
  // Кастомные ключи — в порядке добавления.
  for (const [a, e] of Object.entries(p.actions)) {
    if (BUILTIN_ACTIONS.includes(a) || a === '*') continue;
    if (e && e !== 'default') rules.push({ action: a, resource: '*', effect: e });
  }
  return rules;
}

/// Сохраняет нестандартные правила (resource ≠ «*») из исходного frontmatter.
function extractCustomPerms(obj: Record<string, unknown>): PermRule[] {
  const perms = obj.permissions;
  if (!Array.isArray(perms)) return [];
  const keep: PermRule[] = [];
  for (const rule of perms) {
    if (typeof rule !== 'object' || rule === null) continue;
    const r = rule as Record<string, unknown>;
    const action = typeof r.action === 'string' ? r.action : '';
    const resource = typeof r.resource === 'string' ? r.resource : '*';
    const effect = typeof r.effect === 'string' ? r.effect : '';
    if (action && resource !== '*' && (effect === 'allow' || effect === 'ask' || effect === 'deny')) {
      keep.push({ action, resource, effect });
    }
  }
  return keep;
}

interface AgentForm { name: string; title: string; description: string; mode: AgentMode; model: string; frontmatter: string; body: string; perms: PermsState; mcpNames: string[]; onecTools: string[]; customKey: string; tab?: 'main' | 'tools' | 'yaml'; fmBroken?: boolean; }

/// Правила по умолчанию для нового агента — как у штатного plan (read-only):
/// чтение и вопросы разрешены, правка файлов запрещена.
const DEFAULT_AGENT_FRONTMATTER = `mode: primary
permissions:
  - action: "*"
    resource: "*"
    effect: allow
  - action: read
    resource: "*.env"
    effect: ask
  - action: read
    resource: "*.env.*"
    effect: ask
  - action: read
    resource: "*.env.example"
    effect: allow
  - action: question
    resource: "*"
    effect: allow
  - action: edit
    resource: "*"
    effect: deny
  - action: browser
    resource: "*"
    effect: deny`;

function AgentsTab({ server }: { server: OpencodeServer }) {
  const [agents, setAgents] = useState<(AgentForm & { description?: string; mode?: string })[]>([]);
  const [form, setForm] = useState<AgentForm | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [del, setDel] = useState<string | null>(null);
  const [err, setErr] = useState('');
  // Список моделей — из конфига сервера (models[] в opencode.jsonc),
  // а не из провайдеров: имена там полные, как их видит OpenCode.
  const [modelOptions, setModelOptions] = useState<string[]>([]);

  useEffect(() => {
    api.getOpencodeConfigModels(server.id).then(r => setModelOptions(r.models || [])).catch(() => {});
  }, [server.id]);

  /// Режим агента из frontmatter: 'all' — ключ mode отсутствует (штатное
  /// поведение OpenCode), 'primary'/'subagent' — явное значение.
  function parseMode(fm: string): AgentMode {
    const m = fm.match(/^mode:\s*(\S+)/m);
    if (!m) return 'all';
    return m[1] === 'subagent' ? 'subagent' : 'primary';
  }

  /// Модель агента из frontmatter (ключ model). Пусто = модель по умолчанию.
  function parseModel(fm: string): string {
    const m = fm.match(/^model:\s*(\S+)/m);
    return m ? m[1] : '';
  }

  /// Подставляет/удаляет ключ в frontmatter. Если значение совпадает с
  /// текущим — не трогаем (чтобы не дублировать строку).
  const load = useCallback(async () => {
    try {
      const [r, mcpNames] = await Promise.all([api.getOpencodeAgents(server.id), loadMcpServerNames(server.id)]);
      setAgents(r.agents.map(a => {
        // Парсим frontmatter в объект для извлечения полей.
        let fmObj: Record<string, unknown> = {};
        try {
          const parsed = yaml.load(a.frontmatter || '');
          if (typeof parsed === 'object' && parsed !== null) fmObj = parsed as Record<string, unknown>;
        } catch { /* ignore */ }
        
        return {
          name: a.name,
          title: typeof fmObj.title === 'string' ? fmObj.title : '',
          description: typeof fmObj.description === 'string' ? fmObj.description : '',
          mode: parseMode(a.frontmatter || ''),
          model: parseModel(a.frontmatter || ''),
          frontmatter: a.frontmatter || '',
          body: a.body,
          perms: parsePermsFromObj(fmObj),
          mcpNames,
          onecTools: [],
          customKey: '',
          // Frontmatter был в файле, но не распарсился как YAML (бэкенд
          // вернул пустую карту). Показываем алерт в форме.
          fmBroken: !!(a.frontmatter && /^{}\s*$/m.test(a.frontmatter) && a.body.trim()),
        };
      }));
    } catch (e) { setErr(errText(e, 'Ошибка')); }
  }, [server.id]);

  useEffect(() => { load(); }, [load]);

  /// Открывает форму: подгружает инструменты 1С из каталога плагина.
  function openForm(a: AgentForm & { description?: string; mode?: string }) {
    setIsNew(false);
    setForm({ ...a, tab: 'main' });
    api.opencodeToolsCatalog(server.id).then(r => {
      setForm(f => f ? { ...f, onecTools: (r.tools || []).map((t: any) => t.name as string) } : f);
    }).catch(() => {});
  }

  async function doSave() {
    if (!form) return;
    setErr('');
    
    // Парсим frontmatter в объект.
    let fmObj: Record<string, unknown>;
    try {
      const parsed = yaml.load(form.frontmatter);
      fmObj = (typeof parsed === 'object' && parsed !== null) ? parsed as Record<string, unknown> : {};
    } catch (e) {
      setErr(`YAML parse error: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    
    // Извлекаем нестандартные правила permissions (resource ≠ «*») до перезаписи.
    const customPerms = extractCustomPerms(fmObj);
    
    // Title / description / mode / model — из полей формы. Пустое значение = убрать ключ.
    if (form.title.trim()) fmObj.title = form.title.trim();
    else delete fmObj.title;
    
    if (form.description.trim()) fmObj.description = form.description.trim();
    else delete fmObj.description;
    
    if (form.mode !== 'all') fmObj.mode = form.mode;
    else delete fmObj.mode;
    
    if (form.model.trim()) fmObj.model = form.model.trim();
    else delete fmObj.model;
    
    // Permissions — из состояния UI + сохранённые нестандартные правила.
    const rules = buildPermsRules(form.perms);
    if (rules.length || customPerms.length) {
      fmObj.permissions = [...rules, ...customPerms];
    } else {
      delete fmObj.permissions;
    }
    
    // Сериализуем обратно в YAML. js-yaml сам экранирует все значения.
    const fmStr = yaml.dump(fmObj, { indent: 2, lineWidth: -1 });
    
    try {
      await api.putOpencodeAgent(server.id, { name: form.name, frontmatter: fmStr, body: form.body });
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
        <Btn onClick={() => {
          setIsNew(true);
          const fm = DEFAULT_AGENT_FRONTMATTER;
          // Парсим permissions из DEFAULT_AGENT_FRONTMATTER.
          let defaultPerms: PermsState = { global: 'default', actions: {} };
          try {
            const parsed = yaml.load(fm);
            if (typeof parsed === 'object' && parsed !== null) {
              defaultPerms = parsePermsFromObj(parsed as Record<string, unknown>);
            }
          } catch { /* ignore */ }
          
          setForm({ name: '', title: '', description: '', mode: 'primary', model: '', frontmatter: fm, body: '', perms: defaultPerms, mcpNames: [], onecTools: [], customKey: '', tab: 'main' });
          api.opencodeToolsCatalog(server.id).then(r => {
            setForm(f => f ? { ...f, onecTools: (r.tools || []).map((x: any) => x.name as string) } : f);
          }).catch(() => {});
        }}>
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
                <IconBtn title={t.common.edit} onClick={() => openForm(a)}><Pencil size={14} /></IconBtn>
                <IconBtn title={t.common.delete} onClick={() => setDel(a.name)}><Trash2 size={14} /></IconBtn>
              </div>
            </Td>
          </Row>
        ))}
      </TableShell>

      {form && (
        <Modal title={isNew ? t.opencode.newAgent : `Агент: ${form.name}`} onClose={() => setForm(null)} xwide fill>
          {/* Вкладки: Основная (поля + промпт) / Тулзы (разрешения) / YAML. */}
          <div className="flex gap-1 border-b border-slate-200 dark:border-slate-800 mb-4">
            {([['main', 'Основная'], ['tools', t.opencode.permsTitle], ['yaml', 'Frontmatter (YAML)']] as const).map(([key, label]) => (
              <button key={key} type="button" onClick={() => setForm({ ...form, tab: key })}
                className={`px-4 py-2 text-sm rounded-t-md border-b-2 transition-colors cursor-pointer ${form.tab === key ? 'border-blue-600 dark:border-blue-500 text-slate-900 dark:text-slate-100 font-medium' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'}`}>
                {label}
              </button>
            ))}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto pr-1">
            {form.tab === 'tools' ? (
              <PermissionsEditor form={form} setForm={setForm} />
            ) : form.tab === 'yaml' ? (
              <>
                {form.fmBroken && (
                  <div className="mb-3">
                    <Alert tone="amber">Frontmatter в файле не распознан как YAML — проверьте кавычки. Двоеточие с пробелом внутри значения («конвейер: уточняющие») требует кавычек: description: «…конвейер: уточняющие…».</Alert>
                  </div>
                )}
                <Field label="Frontmatter (YAML)" hint="model и остальные ключи — как в agents/<имя>.md. Ключи title, description, mode подставляются из полей на вкладке «Основная»; permissions редактируются на вкладке «Тулзы».">
                  <TextArea mono value={form.frontmatter} onChange={e => setForm({ ...form, frontmatter: e.target.value })} rows={16} spellCheck={false} placeholder={'model: local-12600/qwen3.8'} />
                </Field>
              </>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t.opencode.agentName} hint="^[a-z0-9_-]+$"><TextInput mono value={form.name} disabled={!isNew} onChange={e => setForm({ ...form, name: e.target.value.toLowerCase() })} /></Field>
                  <Field label="Заголовок" hint="Показывается клиенту (assistant/Ассистент). Пусто = имя с заглавной буквы.">
                    <TextInput value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="Ассистент" />
                  </Field>
                </div>
                <Field label="Описание" hint="Короткое описание — для выбора агента в клиенте. Если текст содержит «: », оберните значение в кавычки (иначе YAML сломается)." className="mt-3">
                  <TextInput value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Общие вопросы по 1С и базе знаний" />
                </Field>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <Field label="Режим" hint="primary — основной агент сессии; subagent — вызывается из других агентов; all — как в штатном OpenCode (без явного mode).">
                    <Segmented
                      value={form.mode}
                      onChange={(m) => setForm({ ...form, mode: m })}
                      options={[
                        { key: 'primary', label: 'primary' },
                        { key: 'subagent', label: 'subagent' },
                        { key: 'all', label: 'all' },
                      ]}
                    />
                  </Field>
                  <Field label="Модель" hint="Список — из конфига сервера (вкладка Конфиг → Модели). Пусто = модель по умолчанию OpenCode.">
                    <select
                      value={form.model}
                      onChange={e => setForm({ ...form, model: e.target.value })}
                      className={`w-full px-3 py-2 text-sm rounded-lg border bg-white dark:bg-slate-900 ${inputCls}`}
                    >
                      <option value="">— по умолчанию —</option>
                      {modelOptions.map(m => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                      {/* Если текущее значение не в списке — показываем его. */}
                      {form.model && !modelOptions.includes(form.model) && (
                        <option value={form.model}>{form.model}</option>
                      )}
                    </select>
                  </Field>
                </div>
                <TextArea mono value={form.body} onChange={e => setForm({ ...form, body: e.target.value })} rows={14} className="mt-3" spellCheck={false} placeholder="Системный промпт агента (Markdown)" />
              </>
            )}
          </div>

          <div className="flex justify-end gap-2 mt-4 shrink-0">
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

/// Блок «Разрешения тулзов» в форме агента: глобальный дефолт, встроенные
/// действия, MCP-серверы из opencode.jsonc, инструменты 1С и кастомные ключи.
/// Состояние — form.perms; при сохранении doSave генерирует блок permissions.
function PermissionsEditor({ form, setForm }: { form: AgentForm; setForm: (f: AgentForm) => void }) {
  const [newKey, setNewKey] = useState('');

  function setAction(action: string, effect: PermEffect) {
    setForm({ ...form, perms: { ...form.perms, actions: { ...form.perms.actions, [action]: effect } } });
  }
  function addCustom() {
    const k = newKey.trim();
    if (!k || form.perms.actions[k]) return;
    setAction(k, 'default');
    setNewKey('');
  }

  /// Строка секции: название (жирное) + action (mono, приглушённый) → сегмент.
  function permRow(label: string, action: string, effect: PermEffect, hint?: string, onChange?: (v: PermEffect) => void) {
    return (
      <div className="flex items-center justify-between gap-3 py-1.5" title={hint}>
        <div className="min-w-0">
          <span className="text-sm font-medium">{label}</span>
          <span className={`ml-2 text-xs ${monoCls} text-slate-400 dark:text-slate-500`}>{action}</span>
        </div>
        <Segmented<PermEffect>
          value={effect}
          onChange={(v) => (onChange || ((x: PermEffect) => setAction(action, x)))(v)}
          options={[
            { key: 'default', label: 'Default' },
            { key: 'allow', label: 'Allow' },
            { key: 'ask', label: 'Ask' },
            { key: 'deny', label: 'Deny' },
          ]}
        />
      </div>
    );
  }

  /// Глобальный дефолт — отдельное поле form.perms.global, не actions.
  function setGlobal(effect: PermEffect) {
    setForm({ ...form, perms: { ...form.perms, global: effect } });
  }

  // Кастомные ключи — всё, что не встроено и не глобальный «*».
  const customActions = Object.keys(form.perms.actions).filter(a => a !== '*' && !BUILTIN_ACTIONS.includes(a));

  return (
    <div className="mt-3 border border-slate-200 dark:border-slate-800 rounded-lg p-3">
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">{t.opencode.permsHint}</p>

      {permRow(t.opencode.permAllTools, '*', form.perms.global, t.opencode.permAllHint, setGlobal)}
      <div className="border-t border-slate-100 dark:border-slate-800/70 my-1" />
      {BUILTIN_ACTIONS.map(a => permRow(a, a, form.perms.actions[a] || 'default'))}

      <div className="border-t border-slate-100 dark:border-slate-800/70 my-2 pt-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">{t.opencode.permMcpServers}</span>
        {form.mcpNames.length === 0 && (
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">{t.opencode.permNoMcp}</p>
        )}
        {form.mcpNames.map(n => permRow(n, `${n}_*`, form.perms.actions[`${n}_*`] || 'default'))}
      </div>

      <div className="border-t border-slate-100 dark:border-slate-800/70 my-2 pt-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">{t.opencode.permOnecTools}</span>
        {form.onecTools.length === 0 && (
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">Каталог инструментов пуст — «Синхронизировать» во вкладке Инструменты.</p>
        )}
        {form.onecTools.map(n => permRow(n, `onec_${n}`, form.perms.actions[`onec_${n}`] || 'default', t.opencode.permOnecHint))}
      </div>

      <div className="border-t border-slate-100 dark:border-slate-800/70 my-2 pt-2">
        {customActions.map(a => permRow(a, a, form.perms.actions[a] || 'default'))}
        <div className="flex gap-2 mt-1.5">
          <TextInput value={newKey} onChange={e => setNewKey(e.target.value)} placeholder={t.opencode.permCustomPlaceholder}
            onKeyDown={e => { if (e.key === 'Enter') addCustom(); }} className="flex-1" />
          <Btn variant="outline" onClick={addCustom}><Plus size={14} /> {t.opencode.permAddKey}</Btn>
        </div>
      </div>
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
  const [pluginStale, setPluginStale] = useState(false);
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
      if (me) { setPluginGenerated(!!me.plugin_generated); setPluginStale(!!me.plugin_stale); setDepsInstalled(!!me.deps_installed); }
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
        {pluginStale && <span title={t.opencode.tokenStale}><Badge tone="red">{t.opencode.tokenStale}</Badge></span>}
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

type OcSession = {
  id: string; title?: string | null; agent?: string | null; model?: string | null; provider?: string | null;
  created?: number | null; updated?: number | null; idle?: number | null; viewed?: number | null;
  outcome?: string | null; active: boolean;
  tokens_in?: number | null; tokens_out?: number | null; cost?: number | null;
  user?: string | null; base?: string | null;
};

function fmtTs(ms?: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function SessionsTab({ serverId }: { serverId: string }) {
  const [oc, setOc] = useState<OcSession[]>([]);
  const [ocErr, setOcErr] = useState('');
  const [ocLoading, setOcLoading] = useState(false);
  const [filter, setFilter] = useState<'active' | 'all'>('all');
  const [search, setSearch] = useState('');
  const [viewing, setViewing] = useState<OcSession | null>(null);

  // Реестр шлюза (JWT 1С) — нижняя секция.
  const [all, setAll] = useState<{ session_id: string; server: string; user?: string | null; base?: string | null; has_jwt: boolean; expires_at: number }[]>([]);
  const [err, setErr] = useState('');

  const loadOc = useCallback(async () => {
    setOcLoading(true);
    try {
      const r = await api.getOpencodeServerSessions(serverId);
      setOc(r.sessions);
      setOcErr('');
    } catch (e) { setOcErr(errText(e, 'Ошибка')); }
    finally { setOcLoading(false); }
  }, [serverId]);

  const load = useCallback(async () => {
    try {
      const r = await api.getOpencodeSessions();
      setAll(r.sessions);
    } catch (e) { setErr(errText(e, 'Ошибка')); }
  }, []);

  // Фильтр по выбранному серверу (server — id сервера из реестра шлюза).
  const sessions = all.filter(s => s.server === serverId);

  useEffect(() => { loadOc(); load(); }, [loadOc, load]);

  async function doDrop(id: string) {
    try { await api.dropOpencodeSession(id); load(); }
    catch (e) { setErr(errText(e, 'Ошибка')); }
  }

  const q = search.trim().toLowerCase();
  const shownOc = oc.filter(s =>
    (filter === 'all' || s.active) &&
    (!q || (s.title || '').toLowerCase().includes(q) || (s.user || '').toLowerCase().includes(q) || (s.base || '').toLowerCase().includes(q)));

  function statusBadge(s: OcSession) {
    if (s.outcome === 'failed') return <Badge tone="red">{t.opencode.ocFailed}</Badge>;
    if (s.active) return <Badge tone="green">{t.opencode.ocActive}</Badge>;
    return <Badge tone="neutral">{t.opencode.ocClosed}</Badge>;
  }

  return (
    <div>
      {ocErr && <div className="mb-3"><Alert tone="red">{ocErr}</Alert></div>}
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">{t.opencode.ocSessionsHint}</p>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <Segmented value={filter} onChange={(v) => setFilter(v as 'active' | 'all')} options={[
          { key: 'active', label: t.opencode.ocActiveOnly },
          { key: 'all', label: t.opencode.ocAllSessions },
        ]} />
        <div className="flex-1 min-w-[180px] max-w-xs">
          <TextInput value={search} onChange={e => setSearch(e.target.value)} placeholder={t.common.filter} />
        </div>
        <Btn variant="outline" onClick={loadOc} disabled={ocLoading}><RefreshCw size={15} className={ocLoading ? 'animate-spin' : ''} /> {t.common.refresh}</Btn>
      </div>
      <TableShell colSpan={9} empty={shownOc.length === 0 ? { text: t.opencode.ocNoSessions } : null}
        head={<><Th>{t.opencode.ocSessionTitle}</Th><Th>{t.opencode.ocSessionUser}</Th><Th>{t.opencode.ocSessionBase}</Th><Th>{t.opencode.ocSessionAgent}</Th><Th>{t.opencode.ocSessionModel}</Th><Th>{t.opencode.ocSessionUpdated}</Th><Th>{t.opencode.ocSessionStatus}</Th><Th right>{t.opencode.ocSessionTokens}</Th><Th right>{t.common.actions}</Th></>}>
        {shownOc.map(s => (
          <Row key={s.id} className="cursor-pointer" >
            <Td>
              <button type="button" onClick={() => setViewing(s)} className="text-sm font-medium text-slate-800 dark:text-slate-100 hover:underline cursor-pointer text-left">
                {s.title || <span className={monoCls + ' text-xs'}>{s.id.slice(0, 24)}…</span>}
              </button>
            </Td>
            <Td><span className="text-sm">{s.user || '—'}</span></Td>
            <Td>{s.base ? <Badge tone="sky">{s.base}</Badge> : '—'}</Td>
            <Td><span className="text-sm">{s.agent || '—'}</span></Td>
            <Td><span className={monoCls + ' text-xs'}>{s.model || '—'}</span></Td>
            <Td><span className="text-xs text-slate-500 dark:text-slate-400">{fmtTs(s.updated ?? s.idle)}</span></Td>
            <Td>{statusBadge(s)}</Td>
            <Td className="text-right"><span className={monoCls + ' text-xs text-slate-500 dark:text-slate-400'}>{s.tokens_in ? `${s.tokens_in} / ${s.tokens_out ?? 0}` : '—'}</span></Td>
            <Td className="text-right"><IconBtn title={t.opencode.ocViewDialog} onClick={() => setViewing(s)}><MessageSquare size={14} /></IconBtn></Td>
          </Row>
        ))}
      </TableShell>

      {viewing && <SessionDialogModal serverId={serverId} session={viewing} onClose={() => setViewing(null)} />}

      {/* Реестр шлюза (JWT 1С) */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-1">{t.opencode.ocGatewayRegistry}</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">{t.opencode.ocGatewayRegistryHint}</p>
        {err && <div className="mb-2"><Alert tone="red">{err}</Alert></div>}
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
    </div>
  );
}

function SessionDialogModal({ serverId, session, onClose }: { serverId: string; session: OcSession; onClose: () => void }) {
  const [msgs, setMsgs] = useState<{ role: 'user' | 'assistant'; text: string; time?: number | null; agent?: string | null; model?: string | null }[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let cancelled = false;
    setMsgs(null);
    api.getOpencodeServerSessionMessages(serverId, session.id)
      .then(r => { if (!cancelled) setMsgs(r.messages); })
      .catch(e => { if (!cancelled) setErr(errText(e, 'Ошибка')); });
    return () => { cancelled = true; };
  }, [serverId, session.id]);

  return (
    <Modal title={`${session.title || session.id.slice(0, 24)}…`} onClose={onClose} wide fill>
      {err && <Alert tone="red">{err}</Alert>}
      {!msgs && !err && <p className="text-sm text-slate-500 dark:text-slate-400">{t.opencode.ocLoadingMessages}</p>}
      {msgs && msgs.length === 0 && <p className="text-sm text-slate-500 dark:text-slate-400">{t.opencode.ocNoMessages}</p>}
      {msgs && msgs.length > 0 && (
        <div className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-1">
          {msgs.map((m, i) => (
            <div key={i} className={`rounded-lg border px-3 py-2 ${m.role === 'user' ? 'border-blue-200 bg-blue-50 dark:border-blue-900/60 dark:bg-blue-950/30' : 'border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950/40'}`}>
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-xs font-semibold ${m.role === 'user' ? 'text-blue-700 dark:text-blue-300' : 'text-slate-600 dark:text-slate-300'}`}>
                  {m.role === 'user' ? (session.user || 'Пользователь') : (m.agent || 'assistant')}
                </span>
                {m.model && <span className={monoCls + ' text-[10px] text-slate-400'}>{m.model}</span>}
                <span className="text-[10px] text-slate-400 ml-auto">{fmtTs(m.time)}</span>
              </div>
              <pre className="whitespace-pre-wrap break-words text-sm text-slate-800 dark:text-slate-200 font-sans m-0">{m.text}</pre>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
