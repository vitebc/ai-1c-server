import type { BslLsState, Client, ClientVersion, ConfigProfile, FsBrowseResult, LogEntry, McpServer, ServerStatus, Skill } from '../types';
import type {
  AgentItem, SkillFileItem, PatternItem, AgentOverview,
  AgentBackendStatus, EnvEntry, LiveAgents, LiveSkills, LiveTools,
  Me, UserDto,
} from '../types';

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

/** Raw fetch with the stored Bearer token attached (for blobs/uploads).
 *  Same 401 handling as `request`: clears the token and throws. */
export async function authFetch(path: string, options?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {
    ...((options?.headers as Record<string, string>) || {}),
  };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api/admin${path}`, { ...options, headers });
  if (res.status === 401) {
    setToken(null);
    throw new Error('Unauthorized: session expired, please log in again');
  }
  return res;
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
  getMcpStats: (id: string) =>
    request<{ id: string; text: string; raw: unknown }>(`/mcp-servers/${id}/stats`),
  getMcpTools: (id: string) =>
    request<{ id: string; tools: { name: string; description?: string; inputSchema?: unknown }[] }>(`/mcp-servers/${id}/tools`),
  reindexMcp: (id: string) =>
    request<{ job_id: string; server_id: string }>(
      `/mcp-servers/${id}/reindex`, { method: 'POST' }),
  getReindexJob: (jobId: string) =>
    request<{
      job_id: string; server_id: string; server_name: string; state: string;
      progress: number; message: string; roots: string[]; neighbors: string[];
      deleted: string[]; error: string | null; started_at: string; finished_at: string | null;
    }>(`/mcp-servers/reindex/job/${jobId}`),
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
  getSettings: () => request<{ key: string; value: string | null }[]>('/settings'),
  putSetting: (key: string, value: string) =>
    request<{ key: string; value: string | null }>('/settings', { method: 'PUT', body: JSON.stringify({ key, value }) }),
  getAuthToken: () => request<{ token: string | null; auth_required: boolean }>('/auth/token'),
  rotateToken: () => request<{ token: string }>('/auth/rotate', { method: 'POST' }),

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
    getLogs: (params?: { level?: string; limit?: number; search?: string; target?: string }) => {    const q = new URLSearchParams();
    if (params?.level) q.set('level', params.level);
    if (params?.limit) q.set('limit', String(params.limit));
    if (params?.search) q.set('search', params.search);
    if (params?.target) q.set('target', params.target);
    const qs = q.toString();
    return request<LogEntry[]>(`/logs${qs ? `?${qs}` : ''}`);
  },
  getLogTargets: () => request<{ targets: string[] }>('/logs/targets'),
  clearLogs: () => request<{ ok: boolean }>('/logs/clear', { method: 'POST' }),
  getBslLsLogs: () => request<string[]>('/bsl-ls/logs'),
  clearBslLsLogs: () => request<void>('/bsl-ls/logs/clear', { method: 'POST' }),
  browseFs: (path?: string, showHidden = true) => {
    const q = new URLSearchParams();
    if (path) q.set('path', path);
    q.set('show_hidden', String(showHidden));
    return request<FsBrowseResult>(`/fs/browse?${q.toString()}`);
  },
  reindex: () => request<void>('/reindex', { method: 'POST' }),

  getAgentOverview: () => request<AgentOverview>('/agent-files'),
  getAgentTools: () => request<string[]>('/agent-files/tools'),
  createAgent: (data: Partial<AgentItem>) =>
    request<AgentItem>('/agent-files/agents', { method: 'POST', body: JSON.stringify(data) }),
  updateAgent: (name: string, data: Partial<AgentItem>) =>
    request<AgentItem>(`/agent-files/agents/${name}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAgent: (name: string) => request<void>(`/agent-files/agents/${name}`, { method: 'DELETE' }),
  createAgentSkill: (data: Partial<SkillFileItem>) =>
    request<SkillFileItem>('/agent-files/skills', { method: 'POST', body: JSON.stringify(data) }),
  updateAgentSkill: (name: string, data: Partial<SkillFileItem>) =>
    request<SkillFileItem>(`/agent-files/skills/${name}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAgentSkill: (name: string) => request<void>(`/agent-files/skills/${name}`, { method: 'DELETE' }),
  createPattern: (data: Partial<PatternItem>) =>
    request<PatternItem>('/agent-files/patterns', { method: 'POST', body: JSON.stringify(data) }),
  updatePattern: (name: string, data: Partial<PatternItem>) =>
    request<PatternItem>(`/agent-files/patterns/${name}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePattern: (name: string) => request<void>(`/agent-files/patterns/${name}`, { method: 'DELETE' }),

  getAgentBackendStatus: () => request<AgentBackendStatus>('/agent-backend/status'),
  agentBackendUp: (services: string[], profiles: string[]) =>
    request<{ ok: boolean; output: string }>('/agent-backend/up', { method: 'POST', body: JSON.stringify({ services, profiles }) }),
  agentBackendStop: (services: string[]) =>
    request<{ ok: boolean; output: string }>('/agent-backend/stop', { method: 'POST', body: JSON.stringify({ services }) }),
  agentBackendRestart: (services: string[]) =>
    request<{ ok: boolean; output: string }>('/agent-backend/restart', { method: 'POST', body: JSON.stringify({ services }) }),
  getAgentBackendLogs: (service?: string, tail?: number, timestamps?: boolean) => {
    const q = new URLSearchParams();
    if (service) q.set('service', service);
    if (tail) q.set('tail', String(tail));
    if (timestamps) q.set('timestamps', 'true');
    const qs = q.toString();
    return request<{ service: string | null; log: string }>(`/agent-backend/logs${qs ? `?${qs}` : ''}`);
  },
  getAgentEnv: () => request<EnvEntry[]>('/agent-backend/env'),
  putAgentEnv: (key: string, value: string) =>
    request<{ ok: boolean; key: string; restart_required: boolean }>('/agent-backend/env', { method: 'PUT', body: JSON.stringify({ key, value }) }),
  getLiveAgents: () => request<LiveAgents>('/agent-backend/live/agents'),
  getLiveSkills: (agent?: string) =>
    request<LiveSkills>(`/agent-backend/live/skills${agent ? `?agent=${encodeURIComponent(agent)}` : ''}`),
  getLiveTools: () =>
    request<LiveTools>('/agent-backend/live/tools'),

  login: (username: string, password: string, remember?: boolean) =>
    request<{ token: string; username: string; role: string; sections: string[] }>(
      '/auth/login', { method: 'POST', body: JSON.stringify({ username, password, remember: !!remember }) }),
  getMe: () => request<Me>('/auth/me'),
  changePassword: (old_password: string, new_password: string) =>
    request<{ ok: boolean }>('/auth/password', { method: 'POST', body: JSON.stringify({ old_password, new_password }) }),
  getUsers: () => request<UserDto[]>('/users'),
  createUser: (data: { username: string; password: string; role: string }) =>
    request<UserDto>('/users', { method: 'POST', body: JSON.stringify(data) }),
  updateUser: (id: string, data: { role?: string; enabled?: boolean; sections?: Record<string, boolean> | null }) =>
    request<{ ok: boolean }>(`/users/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  resetUserPassword: (id: string) =>
    request<{ username: string; password: string }>(`/users/${id}/reset-password`, { method: 'POST' }),
  setUserPassword: (id: string, password: string) =>
    request<{ ok: boolean; username: string }>(`/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password }) }),
  deleteUser: (id: string) => request<void>(`/users/${id}`, { method: 'DELETE' }),
};
