import { Route, Routes, NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Server, Brain, FileJson, Package, Users, ScrollText, Code,
} from 'lucide-react';
import Dashboard from './pages/Dashboard';
import McpServers from './pages/McpServers';
import Skills from './pages/Skills';
import Configs from './pages/Configs';
import ClientVersions from './pages/ClientVersions';
import Clients from './pages/Clients';
import Logs from './pages/Logs';
import BslLs from './pages/BslLs';

const nav = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/mcp-servers', label: 'MCP Servers', icon: Server },
  { to: '/skills', label: 'Skills', icon: Brain },
  { to: '/bsl-ls', label: 'BSL LS', icon: Code },
  { to: '/configs', label: 'Configs', icon: FileJson },
  { to: '/client-versions', label: 'Client Versions', icon: Package },
  { to: '/clients', label: 'Clients', icon: Users },
  { to: '/logs', label: 'Logs', icon: ScrollText },
];

export default function App() {
  return (
    <div className="flex h-dvh bg-gray-50">
      <aside className="w-60 bg-white border-r border-gray-200 flex flex-col shrink-0">
        <div className="p-4 border-b border-gray-200">
          <h1 className="text-lg font-bold text-gray-800">AI 1C</h1>
          <p className="text-xs text-gray-500">Enterprise Server</p>
        </div>
        <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'
                }`
              }
            >
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-y-auto p-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/mcp-servers" element={<McpServers />} />
          <Route path="/skills" element={<Skills />} />
          <Route path="/configs" element={<Configs />} />
          <Route path="/client-versions" element={<ClientVersions />} />
          <Route path="/clients" element={<Clients />} />
          <Route path="/bsl-ls" element={<BslLs />} />
          <Route path="/logs" element={<Logs />} />
        </Routes>
      </main>
    </div>
  );
}
