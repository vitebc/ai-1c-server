import { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, KeyRound, Check } from 'lucide-react';
import { api } from '../api/client';
import type { UserDto } from '../types';
import { t } from '../i18n';
import { PageHeader, TableShell, Th, Td, Row, Badge, IconBtn, Btn, Modal, Field, TextInput, Select, Alert } from '../components/ui';

const ROLES = ['admin', 'operator', 'viewer'];

const SECTION_GROUPS: { title: string; items: { key: string; label: string }[] }[] = [
  { title: 'Общее', items: [{ key: 'dashboard', label: 'dashboard — main page' }] },
  { title: 'MCP', items: [{ key: 'mcp-servers', label: 'mcp-servers — MCP servers' }] },
  {
    title: 'AI Agent Studio', items: [
      { key: 'agent-studio', label: 'agent-studio — legacy umbrella (all tabs)' },
      { key: 'agent-agents', label: 'agent-agents — Agents tab' },
      { key: 'agent-skills', label: 'agent-skills — Agent Skills tab' },
      { key: 'agent-patterns', label: 'agent-patterns — Patterns tab' },
      { key: 'agent-backend', label: 'agent-backend — Backend tab (start/stop/logs)' },
      { key: 'env', label: 'env — Agent Studio Config (.env) tab' },
    ],
  },
  {
    title: 'Контент', items: [
      { key: 'skills', label: 'skills — server skills (sidebar)' },
      { key: 'bsl-ls', label: 'bsl-ls — BSL Language Server' },
      { key: 'configs', label: 'configs — config profiles' },
      { key: 'client-versions', label: 'client-versions — client releases' },
      { key: 'clients', label: 'clients — connected clients' },
    ],
  },
  {
    title: 'Система', items: [
      { key: 'logs', label: 'logs — server logs' },
      { key: 'settings', label: 'settings — server settings' },
      { key: 'fs', label: 'fs — file browser (pick binaries/paths)' },
      { key: 'users', label: 'users — user management (admin)' },
      { key: 'auth-manage', label: 'auth-manage — API token (admin)' },
    ],
  },
];

const ALL_SECTIONS = SECTION_GROUPS.flatMap(g => g.items.map(i => i.key));

const ROLE_BASE: Record<string, string[]> = {
  admin: ALL_SECTIONS,
  operator: ['dashboard', 'mcp-servers', 'agent-studio', 'agent-agents', 'agent-skills', 'agent-patterns', 'agent-backend', 'skills', 'bsl-ls', 'configs', 'client-versions', 'clients', 'logs', 'settings', 'fs', 'env'],
  viewer: ['dashboard', 'mcp-servers', 'agent-agents', 'agent-skills', 'agent-patterns', 'skills', 'bsl-ls', 'configs', 'client-versions', 'clients', 'logs'],
};

export default function Users() {
  const [items, setItems] = useState<UserDto[]>([]);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [editSections, setEditSections] = useState<UserDto | null>(null);
  const [newPw, setNewPw] = useState<{ username: string; password: string } | null>(null);
  const [setPwFor, setSetPwFor] = useState<UserDto | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      setItems(await api.getUsers());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function remove(u: UserDto) {
    if (!confirm(t.users.deleteConfirm(u.username))) return;
    if (!confirm(t.users.deleteConfirm2(u.username))) return;
    try {
      await api.deleteUser(u.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  async function resetPw(u: UserDto) {
    if (!confirm(t.users.resetConfirm(u.username))) return;
    try {
      const r = await api.resetUserPassword(u.id);
      setNewPw(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed');
    }
  }

  async function toggleEnabled(u: UserDto) {
    const action = u.enabled ? 'disable' : 'enable';
    if (!confirm(t.users.toggleConfirm(action, u.username))) return;
    try {
      await api.updateUser(u.id, { enabled: !u.enabled });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    }
  }

  async function changeRole(u: UserDto, role: string) {
    if (!confirm(t.users.roleConfirm(u.username, role))) return;
    try {
      await api.updateUser(u.id, { role });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    }
  }

  return (
    <div>
      <PageHeader
        title={t.users.title}
        hint={`${items.length}`}
        right={<Btn variant="primary" onClick={() => setShowNew(true)}><Plus size={15} /> {t.users.new}</Btn>}
      />

      {error && <div className="mb-4"><Alert tone="red">{error}</Alert></div>}

      {showNew && <NewUserForm onClose={() => setShowNew(false)} onSaved={load} onError={setError} />}
      {setPwFor && (
        <SetPasswordForm user={setPwFor} onClose={() => setSetPwFor(null)} onSaved={load} onError={setError} />
      )}
      {editSections && (
        <SectionsEditor user={editSections} onClose={() => setEditSections(null)} onSaved={load} onError={setError} />
      )}
      {newPw && (
        <Modal title={`${t.users.newPwTitle}: ${newPw.username}`} onClose={() => setNewPw(null)}>
          <p className="text-xs text-red-600 dark:text-red-400 mb-3">{t.users.shownOnce}</p>
          <code className="block text-sm font-mono text-slate-800 dark:text-slate-100 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 mb-4 break-all">{newPw.password}</code>
          <Btn variant="primary" onClick={() => setNewPw(null)} className="w-full justify-center">{t.common.close}</Btn>
        </Modal>
      )}

      <TableShell
        colSpan={5}
        empty={items.length === 0 ? { text: t.common.empty } : null}
        head={<><Th>{t.users.username}</Th><Th>{t.users.role}</Th><Th>{t.users.sections}</Th><Th>{t.common.status}</Th><Th right>{t.common.actions}</Th></>}
      >
        {items.map(u => (
          <Row key={u.id}>
            <Td><span className="font-mono text-xs font-medium text-slate-800 dark:text-slate-100">{u.username}</span></Td>
            <Td>
              <Select value={u.role} onChange={e => changeRole(u, e.target.value)} className="!w-auto text-xs !py-1 !px-2">
                {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </Select>
            </Td>
            <Td className="text-[11px] max-w-[280px]">
              <span className="text-slate-600 dark:text-slate-300">
                {u.sections
                  ? Object.entries(u.sections).map(([k, v]) => `${v ? '+' : '−'}${k}`).join(' ')
                  : <span className="text-slate-400 dark:text-slate-500">role defaults ({ROLE_BASE[u.role]?.length || 0})</span>}
              </span>
              <button onClick={() => setEditSections(u)} className="ml-2 text-indigo-600 hover:underline dark:text-indigo-400 cursor-pointer">{t.common.edit}</button>
            </Td>
            <Td>
              <button onClick={() => toggleEnabled(u)} className="cursor-pointer">
                <Badge tone={u.enabled ? 'green' : 'neutral'}>
                  {u.enabled ? t.common.enabled : t.common.disabled}
                </Badge>
              </button>
            </Td>
            <Td className="text-right whitespace-nowrap">
              <IconBtn title={t.users.setPwConfirm(u.username)} onClick={() => setSetPwFor(u)}><Pencil size={15} /></IconBtn>
              <IconBtn title={t.users.resetConfirm(u.username)} onClick={() => resetPw(u)}><KeyRound size={15} /></IconBtn>
              <IconBtn title={t.common.delete} onClick={() => remove(u)} className="hover:!text-red-600"><Trash2 size={15} /></IconBtn>
            </Td>
          </Row>
        ))}
      </TableShell>
    </div>
  );
}

function NewUserForm({ onClose, onSaved, onError }: { onClose: () => void; onSaved: () => void; onError: (e: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('viewer');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!confirm(t.users.createConfirm(username.trim(), role))) return;
    try {
      await api.createUser({ username: username.trim(), password, role });
      onSaved();
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Create failed');
    }
  }

  return (
    <Modal title={t.users.new} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label={t.users.username}>
          <TextInput type="text" value={username} onChange={e => setUsername(e.target.value)} required mono />
        </Field>
        <Field label={t.auth.password}>
          <TextInput type="password" value={password} onChange={e => setPassword(e.target.value)} required />
        </Field>
        <Field label={t.users.role}>
          <Select value={role} onChange={e => setRole(e.target.value)}>
            {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
          </Select>
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="ghost" type="button" onClick={onClose}>{t.common.cancel}</Btn>
          <Btn variant="primary" type="submit">{t.common.create}</Btn>
        </div>
      </form>
    </Modal>
  );
}

function SetPasswordForm({ user, onClose, onSaved, onError }: {
  user: UserDto; onClose: () => void; onSaved: () => void; onError: (e: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!confirm(t.users.setPwConfirm(user.username))) return;
    try {
      await api.setUserPassword(user.id, password);
      setDone(true);
      setTimeout(() => { onSaved(); onClose(); }, 800);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Save failed');
      onClose();
    }
  }

  return (
    <Modal title={`${t.users.newPwTitle}: ${user.username}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <TextInput type="password" value={password} onChange={e => setPassword(e.target.value)}
          placeholder={t.auth.newPw} autoFocus />
        {done && <Alert tone="green">OK</Alert>}
        <div className="flex justify-end gap-2">
          <Btn variant="ghost" type="button" onClick={onClose}>{t.common.cancel}</Btn>
          <Btn variant="primary" type="submit">{t.common.save}</Btn>
        </div>
      </form>
    </Modal>
  );
}

function SectionsEditor({ user, onClose, onSaved, onError }: { user: UserDto; onClose: () => void; onSaved: () => void; onError: (e: string) => void;
}) {
  // Per-section tri-state: default (role) / allow / deny.
  const [state, setState] = useState<Record<string, 'default' | 'allow' | 'deny'>>(() => {
    const s: Record<string, 'default' | 'allow' | 'deny'> = {};
    for (const sec of ALL_SECTIONS) {
      const v = user.sections?.[sec];
      s[sec] = v === true ? 'allow' : v === false ? 'deny' : 'default';
    }
    return s;
  });
  const [saved, setSaved] = useState(false);

  async function save() {
    const overrides: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(state)) {
      if (v === 'allow') overrides[k] = true;
      if (v === 'deny') overrides[k] = false;
    }
    try {
      await api.updateUser(user.id, { sections: Object.keys(overrides).length ? overrides : null });
      setSaved(true);
      setTimeout(() => { onSaved(); onClose(); }, 800);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  return (
    <Modal title={`${t.users.sections}: ${user.username} (${user.role})`} onClose={onClose} wide>
      <div className="space-y-3">
        {SECTION_GROUPS.map(g => (
          <div key={g.title}>
            <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mt-2 mb-1">{g.title}</p>
            {g.items.map(({ key: sec, label }) => (
              <div key={sec} className="flex items-center justify-between gap-3 py-1 border-b border-slate-100 dark:border-slate-800/70">
                <span className="font-mono text-xs text-slate-700 dark:text-slate-300" title={sec}>{label}</span>
                <div className="flex gap-1 shrink-0">
                  {(['default', 'allow', 'deny'] as const).map(v => (
                    <button key={v} onClick={() => setState(s => ({ ...s, [sec]: v }))}
                      className={`px-2.5 py-1 text-[11px] rounded-lg cursor-pointer transition-colors ${state[sec] === v
                        ? v === 'deny' ? 'bg-red-500 text-white' : v === 'allow' ? 'bg-emerald-600 text-white' : 'bg-indigo-600 text-white'
                        : 'bg-slate-200 text-slate-500 hover:bg-slate-300 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'}`}>
                      {v === 'default' ? `default (${ROLE_BASE[user.role]?.includes(sec) ? t.common.on : t.common.off})` : v}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
        <div className="flex justify-end gap-2 pt-2">
          <Btn variant="ghost" onClick={onClose}>{t.common.cancel}</Btn>
          <Btn variant="primary" onClick={save}>
            {saved ? <><Check size={14} /> OK</> : t.common.save}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}
