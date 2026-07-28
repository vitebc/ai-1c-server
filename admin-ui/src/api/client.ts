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
  getStatus: () => request<unknown>('/status'),
  getMcpServers: () => request<unknown[]>('/mcp-servers'),
  getSkills: () => request<unknown[]>('/skills'),
  getConfigProfiles: () => request<unknown[]>('/config-profiles'),
  getClientVersions: () => request<unknown[]>('/client-versions'),
  getClients: () => request<unknown[]>('/clients'),
  getLogs: () => request<unknown[]>('/logs'),
  reindex: () => request<void>('/reindex', { method: 'POST' }),
};
