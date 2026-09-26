import { useEffect, useState } from 'react';
import { Route, Routes, NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Server, Brain, FileJson, Package, Users as UsersIcon, ScrollText, Code, KeyRound, LogOut, Bot, UserCog, Sun, Moon,
} from 'lucide-react';
import { getToken, setToken, api } from './api/client';
import type { Me } from './types';
import { t } from './i18n';
import { ThemeProvider, useTheme } from './theme';
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
import { Btn, Modal, TextInput } from './components/ui';

const AGENT_SECTIONS = ['agent-studio', 'agent-agents', 'agent-skills', 'agent-patterns', 'agent-backend', 'env'];

function canSee(me: Me | null, section: string): boolean {
  if (!me) return true;
  if (me.sections.includes(section)) return true;
  if (section === 'agent-studio') return AGENT_SECTIONS.some(s => me.sections.includes(s));
  return false;
}

const nav = [
  { to: '/', label: t.nav.dashboard, icon: LayoutDashboard, section: 'dashboard' },
  { to: '/mcp-servers', label: t.nav.mcp, icon: Server, section: 'mcp-servers' },
  { to: '/agent-studio', label: t.nav.studio, icon: Bot, section: 'agent-studio' },
  { to: '/skills', label: t.nav.skills, icon: Brain, section: 'skills' },
  { to: '/bsl-ls', label: t.nav.bsl, icon: Code, section: 'bsl-ls' },
  { to: '/configs', label: t.nav.configs, icon: FileJson, section: 'configs' },
  { to: '/client-versions', label: t.nav.versions, icon: Package, section: 'client-versions' },
  { to: '/clients', label: t.nav.clients, icon: UsersIcon, section: 'clients' },
  { to: '/logs', label: t.nav.logs, icon: ScrollText, section: 'logs' },
  { to: '/users', label: t.nav.users, icon: UserCog, section: 'users' },
];

function Shell() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [showPw, setShowPw] = useState(false);
  const { theme, toggle } = useTheme();

  useEffect(() => {
    const probe = async () => {
      try {
        setMe(await api.getMe());
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
      <div className="flex h-dvh items-center justify-center bg-slate-100 dark:bg-slate-950">
        <p className="text-sm text-slate-500">{t.common.loading}</p>
      </div>
    );
  }
  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  const visibleNav = nav.filter(n => canSee(me, n.section));

  return (
    <div className="flex h-dvh bg-slate-100 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <aside className="w-60 shrink-0 flex flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="px-4 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
          <div>
            <h1 className="text-[15px] font-bold tracking-tight">{t.app.title}</h1>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">{t.app.subtitle}</p>
          </div>
          <button onClick={toggle} title={theme === 'dark' ? t.theme.light : t.theme.dark}
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100 transition-colors cursor-pointer">
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </button>
        </div>
        <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
          {visibleNav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] transition-colors ${
                  isActive
                    ? 'bg-indigo-50 text-indigo-700 font-medium dark:bg-indigo-950 dark:text-indigo-300'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200'
                }`
              }
            >
              <Icon size={17} className="shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="p-2 border-t border-slate-200 dark:border-slate-800 space-y-0.5">
          {me && !me.system && (
            <div className="px-3 py-1 text-xs text-slate-500 dark:text-slate-400">
              {me.username} <span className="opacity-70">({me.role})</span>
            </div>
          )}
          {me && !me.system && (
            <button onClick={() => setShowPw(true)}
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] text-slate-500 hover:bg-slate-100 w-full transition-colors dark:text-slate-400 dark:hover:bg-slate-800 cursor-pointer">
              <KeyRound size={17} /> {t.auth.changePw}
            </button>
          )}
          <button onClick={() => setToken(null)}
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] text-slate-500 hover:bg-slate-100 w-full transition-colors dark:text-slate-400 dark:hover:bg-slate-800 cursor-pointer">
            <LogOut size={17} /> {t.auth.logout}
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-[1200px] mx-auto p-6">
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
        </div>
      </main>
      {showPw && <PasswordModal onClose={() => setShowPw(false)} />}
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}

function Guard({ me, section, anyOf, children }: {
  me: Me | null; section: string; anyOf?: string[]; children: React.ReactNode;
}) {
  if (me && !me.sections.includes(section) && !(anyOf || []).some(s => me.sections.includes(s))) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center dark:border-slate-800 dark:bg-slate-900">
        <p className="text-sm text-slate-500">{t.auth.noAccess} (роль: {me.role}).</p>
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
      setError(err instanceof Error ? err.message : 'Ошибка');
    }
  }

  return (
    <Modal title={t.auth.changePw} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <TextInput type="password" value={oldPw} onChange={e => setOldPw(e.target.value)} placeholder={t.auth.oldPw} />
        <TextInput type="password" value={newPw} onChange={e => setNewPw(e.target.value)} placeholder={t.auth.newPw} />
        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        {done && <p className="text-xs text-emerald-600 dark:text-emerald-400">{t.auth.pwChanged}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="ghost" type="button" onClick={onClose}>{t.common.cancel}</Btn>
          <Btn variant="primary" type="submit">{t.common.save}</Btn>
        </div>
      </form>
    </Modal>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const { theme, toggle } = useTheme();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const r = await api.login(username.trim(), password, remember);
      setToken(r.token);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка входа');
    }
  }

  return (
    <div className="flex h-dvh items-center justify-center bg-slate-100 dark:bg-slate-950 p-4">
      <form onSubmit={submit} className="rounded-xl border border-slate-200 bg-white p-7 w-full max-w-sm shadow-lg dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <KeyRound size={20} className="text-indigo-600 dark:text-indigo-400" />
            <h1 className="text-base font-bold text-slate-900 dark:text-slate-100">{t.app.admin}</h1>
          </div>
          <button type="button" onClick={toggle} className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 cursor-pointer">
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
        <div className="space-y-3">
          <TextInput type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder={t.auth.username} autoFocus autoComplete="username" />
          <TextInput type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder={t.auth.password} autoComplete="current-password" />
          <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 cursor-pointer">
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} className="rounded accent-indigo-600" />
            {t.auth.remember}
          </label>
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          <Btn variant="primary" type="submit" className="w-full justify-center">{t.auth.signIn}</Btn>
        </div>
      </form>
    </div>
  );
}
