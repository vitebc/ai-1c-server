import type { BslLsState, Client, ClientVersion, ConfigProfile, FsBrowseResult, LogEntry, McpServer, ServerStatus, Skill } from '../types';

const BASE = import.meta.env.VITE_API_BASE || '';

const TOKEN_KEY = 'ai1c_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
  window.dispatchEvent(new Event('ai1c:token'));
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options?.headers as Record<string, string>) || {}),
  };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api/admin${path}`, { ...options, headers });
  if (res.status === 401) {
    setToken(null);
    throw new Error('Unauthorized: invalid or missing API token');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `API error: ${res.status}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
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
  restartMcpServer: (id: string) =>
    request<{ id: string; running: boolean }>(`/mcp-servers/${id}/restart`, { method: 'POST' }),
  exportMcpConfig: (format: string, base?: string) =>
    request<unknown>(`/mcp-servers/export?format=${format}${base ? `&base=${encodeURIComponent(base)}` : ''}`),

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
  getBslLs: () => request<BslLsState>('/bsl-ls'),
  updateBslLs: (data: { config: { java_path: string; jar_path: string; port: number; enabled: boolean } }) =>
    request<BslLsState>('/bsl-ls/config', { method: 'POST', body: JSON.stringify(data) }),
  restartBslLs: () => request<BslLsState>('/bsl-ls/restart', { method: 'POST' }),
  stopBslLs: () => request<BslLsState>('/bsl-ls/stop', { method: 'POST' }),
    getLogs: (params?: { level?: string; limit?: number; search?: string }) => {    const q = new URLSearchParams();
    if (params?.level) q.set('level', params.level);
    if (params?.limit) q.set('limit', String(params.limit));
    if (params?.search) q.set('search', params.search);
    const qs = q.toString();
    return request<LogEntry[]>(`/logs${qs ? `?${qs}` : ''}`);
  },
  clearLogs: () => request<{ ok: boolean }>('/logs/clear', { method: 'POST' }),
  getBslLsLogs: () => request<string[]>('/bsl-ls/logs'),
  clearBslLsLogs: () => request<void>('/bsl-ls/logs/clear', { method: 'POST' }),
  browseFs: (path?: string) =>
    request<FsBrowseResult>(`/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  reindex: () => request<void>('/reindex', { method: 'POST' }),
};
