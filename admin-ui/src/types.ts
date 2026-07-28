export interface McpServer {
  id: string;
  name: string;
  description: string | null;
  server_type: string;
  transport: string;
  command: string | null;
  args: string | null;
  env: string | null;
  url: string | null;
  enabled: boolean;
  config: string | null;
  created_at: string;
  updated_at: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string | null;
  server_id: string | null;
  tool_name: string;
  tool_schema: string;
  category: string | null;
  version: string | null;
  enabled: boolean;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConfigProfile {
  id: string;
  name: string;
  path: string;
  active: boolean;
  last_indexed: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientVersion {
  id: string;
  version: string;
  platform: string;
  url: string;
  checksum: string;
  changelog: string | null;
  required: boolean;
  created_at: string;
}

export interface Client {
  id: string;
  name: string | null;
  version: string | null;
  last_seen: string | null;
  config_override: string | null;
}

export interface ServerStatus {
  id: string;
  name: string;
  status: string;
}

export interface BslLsConfig {
  java_path: string;
  jar_path: string;
  port: number;
  enabled: boolean;
}

export interface BslLsState {
  status: string;
  pid: number | null;
  error: string | null;
  config: BslLsConfig;
}

export interface BslLsRelease {
  version: string;
  jar_url: string | null;
  published_at: string;
}
