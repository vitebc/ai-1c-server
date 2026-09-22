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
  instruction: string | null;
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
  parent_id: string | null;
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

export interface LogEntry {
  ts: string;
  level: string;
  target: string;
  msg: string;
}

export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number | null;
}

export interface FsBrowseResult {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

export interface BslLsConfig {
  java_path: string;
  jar_path: string;
  port: number;
  enabled: boolean;
  data_dir: string;
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

export interface AgentItem {
  name: string;
  title: string;
  description: string;
  tools: string[];
  skills: string[];
  mcp: string;
  model: string;
  body: string;
  error: string | null;
}

export interface SkillFileItem {
  name: string;
  description: string;
  tools: string[];
  body: string;
  error: string | null;
}

export interface PatternItem {
  name: string;
  description: string;
  body: string;
  error: string | null;
}

export interface AgentOverview {
  root: string;
  root_exists: boolean;
  agents: AgentItem[];
  skills: SkillFileItem[];
  patterns: PatternItem[];
}

export interface ComposeService {
  name: string;
  state: string;
  health: string | null;
}

export interface AgentBackendStatus {
  root: string;
  root_exists: boolean;
  compose_available: boolean;
  services: ComposeService[];
  backend_reachable: boolean;
  backend_health: unknown;
  backend_url: string;
}

export interface EnvEntry {
  key: string;
  value: string | null;
  masked: boolean;
  present: boolean;
}

export interface LiveAgents {
  reachable: boolean;
  error?: string;
  data?: {
    default: string;
    agents: { name: string; title: string; description: string; tools: string[]; skills: string[] }[];
    errors: string[];
  };
}

export interface LiveSkills {
  reachable: boolean;
  error?: string;
  data?: {
    skills: { name: string; description: string; tools: string[] }[];
    errors: string[];
  };
}
