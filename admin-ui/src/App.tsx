import { useEffect, useState } from 'react';
import { Route, Routes, NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Server, Brain, FileJson, Package, Users as UsersIcon, ScrollText, Code, KeyRound, LogOut, Bot, UserCog,
} from 'lucide-react';
import { getToken, setToken, api } from './api/client';
import type { Me } from './types';
import Dashboard from './pages/Dashboard';
import McpServers from './pages/McpServers';
import Skills from './pages/Skills';
import Configs from './pages/Configs';
import ClientVersions from './pages/ClientVersions';
import Clients from './pages/Clients';
import Logs from './pages/Logs';
import BslLs from './pages/BslLs';
import AgentStudio from './pages/AgentStudio';
import Users from './pages/Users';

const AGENT_SECTIONS = ['agent-studio', 'agent-agents', 'agent-skills', 'agent-patterns', 'agent-backend', 'env'];

function canSee(me: Me | null, section: string): boolean {
  if (!me) return true;
  if (me.sections.includes(section)) return true;
  // Studio umbrella: visible when any inner subsection is granted.
  if (section === 'agent-studio') return AGENT_SECTIONS.some(s => me.sections.includes(s));
  return false;
}

const nav = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, section: 'dashboard' },
  { to: '/mcp-servers', label: 'MCP Servers', icon: Server, section: 'mcp-servers' },
  { to: '/agent-studio', label: 'AI Agent Studio', icon: Bot, section: 'agent-studio' },
  { to: '/skills', label: 'Skills', icon: Brain, section: 'skills' },
  { to: '/bsl-ls', label: 'BSL LS', icon: Code, section: 'bsl-ls' },
  { to: '/configs', label: 'Configs', icon: FileJson, section: 'configs' },
  { to: '/client-versions', label: 'Client Versions', icon: Package, section: 'client-versions' },
  { to: '/clients', label: 'Clients', icon: UsersIcon, section: 'clients' },
  { to: '/logs', label: 'Logs', icon: ScrollText, section: 'logs' },
  { to: '/users', label: 'Users', icon: UserCog, section: 'users' },
];

export default function App() {
  // null = probing access (covers auth-disabled servers and stored tokens).
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [showPw, setShowPw] = useState(false);

  useEffect(() => {
    const probe = async () => {
      try {
        const m = await api.getMe();
        setMe(m);
        setAuthed(true);
      } catch {
        setToken(null);
        setMe(null);
        setAuthed(false);
      }
    };
    probe();
    const onToken = async () => {
      if (!getToken()) {
        setMe(null);
        setAuthed(false);
        return;
      }
      try {
        setMe(await api.getMe());
        setAuthed(true);
      } catch {
        setToken(null);
        setMe(null);
        setAuthed(false);
      }
    };
    window.addEventListener('ai1c:token', onToken);
    return () => window.removeEventListener('ai1c:token', onToken);
  }, []);

  if (authed === null) {
    return (
      <div className="flex h-dvh items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-500">Connecting…</p>
      </div>
    );
  }
  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  const visibleNav = nav.filter(n => canSee(me, n.section));

  return (
    <div className="flex h-dvh bg-gray-50">
      <aside className="w-60 bg-gray-100 border-r border-gray-200 flex flex-col shrink-0">
        <div className="p-4 border-b border-gray-200">
          <h1 className="text-lg font-bold text-gray-800">AI 1C</h1>
          <p className="text-xs text-gray-500">Enterprise Server</p>
        </div>
        <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
          {visibleNav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive ? 'bg-blue-50 text-blue-500 font-medium' : 'text-gray-600 hover:bg-gray-200'
                }`
              }
            >
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="p-2 border-t border-gray-200 space-y-1">
          {me && !me.system && (
            <div className="px-3 py-1 text-xs text-gray-500">
              {me.username} <span className="text-gray-400">({me.role})</span>
            </div>
          )}
          {me && !me.system && (
            <button onClick={() => setShowPw(true)}
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-200 w-full transition-colors">
              <KeyRound size={18} /> Change password
            </button>
          )}
          <button onClick={() => setToken(null)}
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-200 w-full transition-colors">
            <LogOut size={18} /> Logout
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto p-6">
        <Routes>
          <Route path="/" element={<Guard me={me} section="dashboard"><Dashboard /></Guard>} />
          <Route path="/mcp-servers" element={<Guard me={me} section="mcp-servers"><McpServers /></Guard>} />
          <Route path="/skills" element={<Guard me={me} section="skills"><Skills /></Guard>} />
          <Route path="/configs" element={<Guard me={me} section="configs"><Configs /></Guard>} />
          <Route path="/client-versions" element={<Guard me={me} section="client-versions"><ClientVersions /></Guard>} />
          <Route path="/clients" element={<Guard me={me} section="clients"><Clients /></Guard>} />
          <Route path="/bsl-ls" element={<Guard me={me} section="bsl-ls"><BslLs /></Guard>} />
          <Route path="/agent-studio" element={<Guard me={me} section="agent-studio" anyOf={['agent-agents', 'agent-skills', 'agent-patterns', 'agent-backend', 'env']}><AgentStudio me={me} /></Guard>} />
          <Route path="/logs" element={<Guard me={me} section="logs"><Logs /></Guard>} />
          <Route path="/users" element={<Guard me={me} section="users"><Users /></Guard>} />
        </Routes>
      </main>
      {showPw && <PasswordModal onClose={() => setShowPw(false)} />}
    </div>
  );
}

function Guard({ me, section, anyOf, children }: {
  me: Me | null; section: string; anyOf?: string[]; children: React.ReactNode;
}) {
  if (me && !me.sections.includes(section) && !(anyOf || []).some(s => me.sections.includes(s))) {
    return (
      <div className="bg-gray-100 border border-gray-200 rounded-xl p-8 text-center">
        <p className="text-sm text-gray-500">No access to this section (role: {me.role}).</p>
      </div>
    );
  }
  return <>{children}</>;
}

function PasswordModal({ onClose }: { onClose: () => void }) {
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api.changePassword(oldPw, newPw);
      setDone(true);
      setTimeout(onClose, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-100 rounded-xl shadow-xl w-full max-w-sm mx-4" onClick={e => e.stopPropagation()}>
        <form onSubmit={submit} className="p-6 space-y-4">
          <h3 className="text-lg font-semibold text-gray-800">Change password</h3>
          <input type="password" value={oldPw} onChange={e => setOldPw(e.target.value)} placeholder="Old password"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} placeholder="New password (8+ chars)"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          {error && <p className="text-xs text-red-600">{error}</p>}
          {done && <p className="text-xs text-green-600">Password changed</p>}
          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
            <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">Save</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const r = await api.login(username.trim(), password, remember);
      setToken(r.token);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    }
  }

  return (
    <div className="flex h-dvh items-center justify-center bg-gray-50">
      <form onSubmit={submit} className="bg-gray-100 border border-gray-200 rounded-xl p-8 w-full max-w-sm shadow-lg">
        <div className="flex items-center gap-3 mb-5">
          <KeyRound size={22} className="text-blue-600" />
          <h1 className="text-lg font-bold text-gray-800">AI 1C Admin</h1>
        </div>
        <div className="space-y-3">
          <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="Username"
            autoFocus autoComplete="username"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password"
            autoComplete="current-password"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <label className="flex items-center gap-2 text-xs text-gray-600">
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} className="rounded" />
            Remember me (7 days, otherwise 12 hours)
          </label>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button type="submit" className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors">
            Sign in
          </button>
        </div>
      </form>
    </div>
  );
}
