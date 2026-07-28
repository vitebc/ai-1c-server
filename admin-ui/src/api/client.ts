import type { Client, ClientVersion, ConfigProfile, McpServer, ServerStatus, Skill } from '../types';

const BASE = import.meta.env.VITE_API_BASE || '';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api/admin${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export const api = {
  getStatus: () => request<ServerStatus[]>('/status'),

  getMcpServers: () => request<McpServer[]>('/mcp-servers'),
  getMcpServer: (id: string) => request<McpServer>(`/mcp-servers/${id}`),
  createMcpServer: (data: Partial<McpServer>) =>
    request<McpServer>('/mcp-servers', { method: 'POST', body: JSON.stringify(data) }),
  updateMcpServer: (id: string, data: Partial<McpServer>) =>
    request<McpServer>(`/mcp-servers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteMcpServer: (id: string) => request<void>(`/mcp-servers/${id}`, { method: 'DELETE' }),

  getSkills: () => request<Skill[]>('/skills'),
  getSkill: (id: string) => request<Skill>(`/skills/${id}`),
  createSkill: (data: Partial<Skill>) =>
    request<Skill>('/skills', { method: 'POST', body: JSON.stringify(data) }),
  updateSkill: (id: string, data: Partial<Skill>) =>
    request<Skill>(`/skills/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteSkill: (id: string) => request<void>(`/skills/${id}`, { method: 'DELETE' }),

  getConfigProfiles: () => request<ConfigProfile[]>('/config-profiles'),
  getConfigProfile: (id: string) => request<ConfigProfile>(`/config-profiles/${id}`),
  createConfigProfile: (data: Partial<ConfigProfile>) =>
    request<ConfigProfile>('/config-profiles', { method: 'POST', body: JSON.stringify(data) }),
  updateConfigProfile: (id: string, data: Partial<ConfigProfile>) =>
    request<ConfigProfile>(`/config-profiles/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteConfigProfile: (id: string) => request<void>(`/config-profiles/${id}`, { method: 'DELETE' }),

  getClientVersions: () => request<ClientVersion[]>('/client-versions'),
  getClientVersion: (id: string) => request<ClientVersion>(`/client-versions/${id}`),
  createClientVersion: (data: Partial<ClientVersion>) =>
    request<ClientVersion>('/client-versions', { method: 'POST', body: JSON.stringify(data) }),
  updateClientVersion: (id: string, data: Partial<ClientVersion>) =>
    request<ClientVersion>(`/client-versions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteClientVersion: (id: string) => request<void>(`/client-versions/${id}`, { method: 'DELETE' }),

  getClients: () => request<Client[]>('/clients'),
  getLogs: () => request<unknown[]>('/logs'),
  reindex: () => request<void>('/reindex', { method: 'POST' }),
};
