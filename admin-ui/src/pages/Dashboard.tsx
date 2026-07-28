import { useEffect, useState } from 'react';
import { Server, Brain, FileJson, Users } from 'lucide-react';
import { api } from '../api/client';
import type { ServerStatus } from '../types';

export default function Dashboard() {
  const [status, setStatus] = useState<ServerStatus[]>([]);
  const [counts, setCounts] = useState({ servers: 0, skills: 0, configs: 0, clients: 0 });

  useEffect(() => {
    Promise.all([
      api.getStatus().then(setStatus),
      api.getMcpServers().then(s => setCounts(c => ({ ...c, servers: s.length }))),
      api.getSkills().then(s => setCounts(c => ({ ...c, skills: s.length }))),
      api.getConfigProfiles().then(c => setCounts(c2 => ({ ...c2, configs: c.length }))),
      api.getClients().then(c => setCounts(c2 => ({ ...c2, clients: c.length }))),
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
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
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
      </div>
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
    </div>
  );
}
