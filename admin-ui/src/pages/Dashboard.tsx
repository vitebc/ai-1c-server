import { useEffect, useState } from 'react';
import { Server, Brain, FileJson, Users, Code, KeyRound, Copy, Check, RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react';
import { api, setToken } from '../api/client';
import { copyText } from '../clipboard';
import type { BslLsState, ServerStatus } from '../types';

export default function Dashboard() {
  const [status, setStatus] = useState<ServerStatus[]>([]);
  const [counts, setCounts] = useState({ servers: 0, skills: 0, configs: 0, clients: 0 });
  const [bsl, setBsl] = useState<BslLsState | null>(null);

  useEffect(() => {
    Promise.all([
      api.getStatus().then(setStatus),
      api.getMcpServers().then(s => setCounts(c => ({ ...c, servers: s.length }))),
      api.getSkills().then(s => setCounts(c => ({ ...c, skills: s.length }))),
      api.getConfigProfiles().then(c => setCounts(c2 => ({ ...c2, configs: c.length }))),
      api.getClients().then(c => setCounts(c2 => ({ ...c2, clients: c.length }))),
      api.getBslLs().then(setBsl),
    ]);
  }, []);

  const cards = [
    { label: 'MCP Servers', value: counts.servers, icon: Server, color: 'bg-blue-500' },
    { label: 'Skills', value: counts.skills, icon: Brain, color: 'bg-purple-500' },
    { label: 'Config Profiles', value: counts.configs, icon: FileJson, color: 'bg-green-500' },
    { label: 'Clients', value: counts.clients, icon: Users, color: 'bg-orange-500' },
  ];

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-800 mb-6">Dashboard</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        {cards.map(c => (
          <div key={c.label} className="bg-gray-100 rounded-xl border border-gray-200 p-4 flex items-center gap-4">
            <div className={`${c.color} p-3 rounded-lg text-white`}>
              <c.icon size={24} />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-800">{c.value}</p>
              <p className="text-sm text-gray-500">{c.label}</p>
            </div>
          </div>
        ))}
        <div className="bg-gray-100 rounded-xl border border-gray-200 p-4 flex items-center gap-4">
          <div className={`p-3 rounded-lg text-white ${bsl?.status === 'running' ? 'bg-green-500' : bsl?.status === 'error' ? 'bg-red-500' : 'bg-gray-500'}`}>
            <Code size={24} />
          </div>
          <div>
            <p className={`text-2xl font-bold ${bsl?.status === 'running' ? 'text-green-500' : bsl?.status === 'error' ? 'text-red-500' : 'text-gray-800'}`}>
              {bsl?.status === 'running' ? 'Running' : bsl?.status === 'error' ? 'Error' : 'Stopped'}
            </p>
            <p className="text-sm text-gray-500">BSL LS</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="bg-gray-100 rounded-xl border border-gray-200 p-4">
          <h3 className="font-semibold text-gray-800 mb-3">MCP Server Status</h3>
        {status.length === 0 ? (
          <p className="text-sm text-gray-400">No servers configured</p>
        ) : (
          <div className="space-y-2">
            {status.map(s => (
              <div key={s.id} className="flex items-center justify-between py-1">
                <span className="text-sm text-gray-700">{s.name}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${
                   s.status === 'running' ? 'bg-green-50 text-green-500' :
                   s.status === 'error' ? 'bg-red-50 text-red-500' :
                   'bg-gray-200 text-gray-400'
                }`}>
                  {s.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
        <div className="bg-gray-100 rounded-xl border border-gray-200 p-4">
          <h3 className="font-semibold text-gray-800 mb-3">BSL Language Server</h3>
          <div className="flex items-center justify-between py-1">
            <span className="text-sm text-gray-700">Status</span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${
              bsl?.status === 'running' ? 'bg-green-50 text-green-500' :
              bsl?.status === 'error' ? 'bg-red-50 text-red-500' :
              'bg-gray-200 text-gray-400'
            }`}>
              {bsl?.status || 'unknown'}
            </span>
          </div>
          {bsl?.pid && (
            <div className="flex items-center justify-between py-1 border-t border-gray-200 mt-1">
              <span className="text-sm text-gray-500">PID</span>
              <span className="text-sm font-mono text-gray-700">{bsl.pid}</span>
            </div>
          )}
          {bsl?.error && (
            <div className="mt-2 p-2 bg-red-50 border border-red-300 rounded-lg">
              <p className="text-xs text-red-400 font-mono">{bsl.error}</p>
            </div>
          )}
        </div>
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
    } catch {
      /* unreachable while probing */
    }
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
    if (!confirm('Generate a new API token? The old one stops working immediately.')) return;
    setBusy(true);
    try {
      const res = await api.rotateToken();
      setToken(res.token);
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
    <div className="bg-gray-100 rounded-xl border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-gray-800 flex items-center gap-2">
          {required ? <ShieldCheck size={18} className="text-green-500" /> : <ShieldOff size={18} className="text-gray-400" />}
          MCP Token Auth
        </h3>
        <button onClick={toggle} disabled={busy}
          className={`px-3 py-1.5 text-xs rounded-lg transition-colors disabled:opacity-40 ${required ? 'bg-green-50 text-green-500 border border-green-200' : 'bg-gray-200 text-gray-500 border border-gray-300'}`}>
          {required ? 'Token ON' : 'Token OFF'}
        </button>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        {required
          ? 'Machine MCP clients must send Authorization: Bearer. Token is auto-embedded into MCP export presets. Admin UI always needs login/password.'
          : 'MCP gateway is open to LAN. Admin UI still requires login/password.'}
      </p>
      <div className="flex items-center gap-2">
        <KeyRound size={16} className="text-gray-400 shrink-0" />
        <code className="flex-1 text-xs font-mono text-gray-600 bg-gray-50 border border-gray-200 rounded px-2 py-1.5 truncate">
          {token ? (revealed ? token : '••••••••••••••••') : 'legacy token — press Regenerate to display it here'}
        </code>
        {token && (
          <button onClick={() => setRevealed(r => !r)} className="px-3 py-1.5 text-xs text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-200 transition-colors">
            {revealed ? 'Hide' : 'Show'}
          </button>
        )}
        {token && (
          <button onClick={copy} className="p-1.5 text-gray-500 hover:text-gray-800 hover:bg-gray-200 rounded-lg transition-colors" title={copyError ? 'Copy failed — select manually' : 'Copy token'}>
            {copied ? <Check size={16} className="text-green-600" /> : <Copy size={16} className={copyError ? 'text-red-500' : ''} />}
          </button>
        )}
        <button onClick={regenerate} disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-200 disabled:opacity-40 transition-colors">
          <RefreshCw size={14} /> {token ? 'Regenerate' : 'Generate'}
        </button>
      </div>
    </div>
  );
}
