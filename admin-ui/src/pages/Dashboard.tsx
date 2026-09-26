import { useEffect, useState } from 'react';
import { Server, Brain, FileJson, Users, Code, KeyRound, Copy, Check, RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react';
import { api } from '../api/client';
import { copyText } from '../clipboard';
import type { BslLsState, ServerStatus } from '../types';
import { t } from '../i18n';
import { PageHeader, Card, CardBody, CardTitle, Badge, StatusDot, Btn, Alert } from '../components/ui';

export default function Dashboard() {
  const [status, setStatus] = useState<ServerStatus[]>([]);
  const [counts, setCounts] = useState({ servers: 0, skills: 0, configs: 0, clients: 0 });
  const [bsl, setBsl] = useState<BslLsState | null>(null);

  useEffect(() => {
    Promise.all([
      api.getStatus().then(setStatus).catch(() => {}),
      api.getMcpServers().then(s => setCounts(c => ({ ...c, servers: s.length }))).catch(() => {}),
      api.getSkills().then(s => setCounts(c => ({ ...c, skills: s.length }))).catch(() => {}),
      api.getConfigProfiles().then(c => setCounts(c2 => ({ ...c2, configs: c.length }))).catch(() => {}),
      api.getClients().then(c => setCounts(c2 => ({ ...c2, clients: c.length }))).catch(() => {}),
      api.getBslLs().then(setBsl).catch(() => {}),
    ]);
  }, []);

  const cards = [
    { label: t.dash.mcpServers, value: counts.servers, icon: Server, chip: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300' },
    { label: t.dash.skills, value: counts.skills, icon: Brain, chip: 'bg-violet-50 text-violet-600 dark:bg-violet-950 dark:text-violet-300' },
    { label: t.dash.configs, value: counts.configs, icon: FileJson, chip: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-300' },
    { label: t.dash.clients, value: counts.clients, icon: Users, chip: 'bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-300' },
  ];

  return (
    <div>
      <PageHeader title={t.dash.title} />
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
        {cards.map(c => (
          <Card key={c.label}><CardBody className="flex items-center gap-3">
            <div className={`p-2.5 rounded-lg ${c.chip}`}>
              <c.icon size={20} />
            </div>
            <div className="min-w-0">
              <p className="text-xl font-bold tabular-nums text-slate-900 dark:text-slate-100">{c.value}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{c.label}</p>
            </div>
          </CardBody></Card>
        ))}
        <Card><CardBody className="flex items-center gap-3">
          <div className={`p-2.5 rounded-lg ${bsl?.status === 'running' ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-300' : bsl?.status === 'error' ? 'bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-300' : 'bg-slate-100 text-slate-400 dark:bg-slate-800'}`}>
            <Code size={20} />
          </div>
          <div className="min-w-0">
            <p className="text-xl font-bold text-slate-900 dark:text-slate-100">
              {bsl?.status === 'running' ? t.common.running : bsl?.status === 'error' ? t.common.error : t.common.stopped}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">BSL LS</p>
          </div>
        </CardBody></Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <Card><CardBody>
          <CardTitle>{t.dash.mcpStatus}</CardTitle>
          {status.length === 0 ? (
            <p className="text-[13px] text-slate-400">{t.dash.noServers}</p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {status.map(s => (
                <div key={s.id} className="flex items-center justify-between py-1.5 gap-3">
                  <span className="text-[13px] text-slate-700 dark:text-slate-300 truncate">{s.name}</span>
                  <Badge tone={s.status === 'running' ? 'green' : s.status === 'error' ? 'red' : 'neutral'}>
                    <StatusDot status={s.status} />{s.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardBody></Card>
        <Card><CardBody>
          <CardTitle>{t.dash.bsl}</CardTitle>
          <div className="flex items-center justify-between py-1.5">
            <span className="text-[13px] text-slate-500">{t.bsl.status}</span>
            <Badge tone={bsl?.status === 'running' ? 'green' : bsl?.status === 'error' ? 'red' : 'neutral'}>
              <StatusDot status={bsl?.status} />{bsl?.status || '—'}
            </Badge>
          </div>
          {bsl?.pid != null && (
            <div className="flex items-center justify-between py-1.5 border-t border-slate-100 dark:border-slate-800 mt-1">
              <span className="text-[13px] text-slate-500">{t.dash.pid}</span>
              <span className="text-[13px] font-mono text-slate-700 dark:text-slate-300">{bsl.pid}</span>
            </div>
          )}
          {bsl?.error && (
            <div className="mt-2"><Alert tone="red"><span className="font-mono">{bsl.error}</span></Alert></div>
          )}
        </CardBody></Card>
      </div>

      <ApiAccess />
    </div>
  );
}

function ApiAccess() {
  const [required, setRequired] = useState(false);
  const [token, setTokenState] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);

  async function load() {
    try {
      const me = await api.getMe();
      if (!me.sections.includes('auth-manage')) {
        setVisible(false);
        return;
      }
      setVisible(true);
      const info = await api.getAuthToken();
      setRequired(info.auth_required);
      setTokenState(info.token);
    } catch { /* ignore */ }
  }

  useEffect(() => { load(); }, []);

  if (!visible) return null;

  async function toggle() {
    setBusy(true);
    try {
      await api.putSetting('auth_required', required ? '0' : '1');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    if (!confirm(t.dash.confirmRegen)) return;
    setBusy(true);
    try {
      const res = await api.rotateToken();
      setTokenState(res.token);
      setRevealed(true);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!token) return;
    setCopyError(false);
    try {
      await copyText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <Card><CardBody>
      <div className="flex items-center justify-between gap-3 mb-2">
        <h3 className="text-sm font-semibold flex items-center gap-2 text-slate-800 dark:text-slate-200">
          {required ? <ShieldCheck size={17} className="text-emerald-500" /> : <ShieldOff size={17} className="text-slate-400" />}
          {t.dash.tokenTitle}
        </h3>
        <Btn variant={required ? 'success-outline' : 'outline'} onClick={toggle} disabled={busy} className="!py-1.5 !text-xs">
          {required ? t.dash.tokenOn : t.dash.tokenOff}
        </Btn>
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
        {required ? t.dash.tokenOnHint : t.dash.tokenOffHint}
      </p>
      <div className="flex items-center gap-2">
        <KeyRound size={15} className="text-slate-400 shrink-0" />
        <code className="flex-1 min-w-0 text-xs font-mono truncate rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300">
          {token ? (revealed ? token : '••••••••••••••••') : t.dash.legacyToken}
        </code>
        {token && (
          <Btn variant="outline" onClick={() => setRevealed(r => !r)} className="!py-1.5 !text-xs">
            {revealed ? t.common.hide : t.common.show}
          </Btn>
        )}
        {token && (
          <button onClick={copy} title={copyError ? 'Ошибка копирования — выделите вручную' : t.common.copy}
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer">
            {copied ? <Check size={15} className="text-emerald-500" /> : <Copy size={15} className={copyError ? 'text-red-500' : ''} />}
          </button>
        )}
        <Btn variant="outline" onClick={regenerate} disabled={busy} className="!py-1.5 !text-xs">
          <RefreshCw size={13} /> {token ? t.dash.regenerate : t.dash.generate}
        </Btn>
      </div>
    </CardBody></Card>
  );
}
