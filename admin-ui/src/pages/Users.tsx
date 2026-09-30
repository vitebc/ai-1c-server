import { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, KeyRound, Check } from 'lucide-react';
import { api } from '../api/client';
import type { UserDto } from '../types';
import { t } from '../i18n';
import { errText } from '../errors';
import { PageHeader, TableShell, Th, Td, Row, Badge, IconBtn, Btn, Modal, Field, TextInput, Select, Alert, Confirm } from '../components/ui';

const ROLES = ['admin', 'operator', 'viewer', 'prompter'];

const SECTION_GROUPS: { title: string; items: { key: string; label: string }[] }[] = [
  { title: 'Общее', items: [{ key: 'dashboard', label: 'dashboard — main page' }] },
  { title: 'MCP', items: [
      { key: 'mcp-servers', label: 'mcp-servers — MCP servers' },
      { key: 'models', label: 'models — провайдеры моделей' },
    ] },
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
  operator: ['dashboard', 'mcp-servers', 'models', 'agent-studio', 'agent-agents', 'agent-skills', 'agent-patterns', 'agent-backend', 'skills', 'bsl-ls', 'configs', 'client-versions', 'clients', 'logs', 'settings', 'fs', 'env'],
  viewer: ['dashboard', 'mcp-servers', 'models', 'agent-agents', 'agent-skills', 'agent-patterns', 'skills', 'bsl-ls', 'configs', 'client-versions', 'clients', 'logs'],
  prompter: ['dashboard', 'mcp-servers', 'models', 'agent-agents', 'agent-skills', 'agent-patterns', 'skills', 'bsl-ls', 'configs', 'client-versions', 'clients', 'logs'],
};

export default function Users() {
  const [items, setItems] = useState<UserDto[]>([]);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [editSections, setEditSections] = useState<UserDto | null>(null);
  const [newPw, setNewPw] = useState<{ username: string; password: string } | null>(null);
  const [setPwFor, setSetPwFor] = useState<UserDto | null>(null);
  const [selfName, setSelfName] = useState('');
  const [selfRole, setSelfRole] = useState('');
  const [roleBase, setRoleBase] = useState<Record<string, string[]>>(ROLE_BASE);
  const [pendingAction, setPendingAction] = useState<{ kind: 'delete' | 'resetPw' | 'toggle' | 'role'; user: UserDto; role?: string } | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      setItems(await api.getUsers());
      api.getMe().then(m => { setSelfName(m.username); setSelfRole(m.role); }).catch(() => {});
      api.getRoles().then(r => setRoleBase({ ...ROLE_BASE, ...r.roles, admin: ALL_SECTIONS })).catch(() => {});
    } catch (e) {
      setError(errText(e, 'Ошибка загрузки'));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function doRemove(u: UserDto) {
    try {
      await api.deleteUser(u.id);
      await load();
    } catch (e) {
      setError(errText(e, 'Ошибка удаления'));
    }
  }

  async function doResetPw(u: UserDto) {
    try {
      const r = await api.resetUserPassword(u.id);
      setNewPw(r);
    } catch (e) {
      setError(errText(e, 'Ошибка сброса пароля'));
    }
  }

  async function doToggleEnabled(u: UserDto) {
    try {
      await api.updateUser(u.id, { enabled: !u.enabled });
      await load();
    } catch (e) {
      setError(errText(e, 'Ошибка сохранения'));
    }
  }

  async function doChangeRole(u: UserDto, role: string) {
    try {
      await api.updateUser(u.id, { role });
      await load();
    } catch (e) {
      setError(errText(e, 'Ошибка сохранения'));
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

      {pendingAction && (
        <Confirm
          title={
            pendingAction.kind === 'delete' ? t.users.deleteConfirm(pendingAction.user.username) :
            pendingAction.kind === 'resetPw' ? t.users.resetConfirm(pendingAction.user.username) :
            pendingAction.kind === 'toggle' ? t.users.toggleConfirm(pendingAction.user.enabled ? 'disable' : 'enable', pendingAction.user.username) :
            t.users.roleConfirm(pendingAction.user.username, pendingAction.role || '')
          }
          message={pendingAction.kind === 'delete' ? t.users.deleteConfirm2(pendingAction.user.username) : undefined}
          danger={pendingAction.kind === 'delete'}
          double={pendingAction.kind === 'delete'}
          confirmLabel={t.common.confirm}
          onClose={() => setPendingAction(null)}
          onConfirm={() => {
            const a = pendingAction;
            setPendingAction(null);
            if (a.kind === 'delete') doRemove(a.user);
            else if (a.kind === 'resetPw') doResetPw(a.user);
            else if (a.kind === 'toggle') doToggleEnabled(a.user);
            else if (a.kind === 'role' && a.role) doChangeRole(a.user, a.role);
          }}
        />
      )}
      {showNew && <NewUserForm onClose={() => setShowNew(false)} onSaved={load} onError={setError} />}
      {selfRole === 'admin' && (
        <RolesMatrix roleBase={roleBase} canEdit={selfRole === 'admin'} onChanged={load} onError={setError} />
      )}
      {setPwFor && (
        <SetPasswordForm user={setPwFor} onClose={() => setSetPwFor(null)} onSaved={load} onError={setError} />
      )}
      {editSections && (
        <SectionsEditor user={editSections} base={roleBase} onClose={() => setEditSections(null)} onSaved={load} onError={setError} />
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
              <Select value={u.role} onChange={e => setPendingAction({ kind: 'role', user: u, role: e.target.value })} disabled={u.username === selfName} title={u.username === selfName ? t.users.selfLock : undefined} className="!w-auto text-xs !py-1 !px-2">
                {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </Select>
            </Td>
            <Td className="text-[11px] max-w-[280px]">
              <span className="text-slate-600 dark:text-slate-300">
                {u.sections
                  ? Object.entries(u.sections).map(([k, v]) => `${v ? '+' : '−'}${k}`).join(' ')
                  : <span className="text-slate-400 dark:text-slate-500">role defaults ({roleBase[u.role]?.length || 0})</span>}
              </span>
              <button onClick={() => setEditSections(u)} disabled={u.username === selfName && selfRole !== 'admin'} title={u.username === selfName && selfRole !== 'admin' ? t.users.selfLock : undefined} className="ml-2 text-blue-600 hover:underline dark:text-blue-400 cursor-pointer disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed">{t.common.edit}</button>
            </Td>
            <Td>
              <button onClick={() => setPendingAction({ kind: 'toggle', user: u })} disabled={u.username === selfName} title={u.username === selfName ? t.users.selfLock : undefined} className="cursor-pointer disabled:cursor-not-allowed">
                <Badge tone={u.enabled ? 'green' : 'neutral'}>
                  {u.enabled ? t.common.enabled : t.common.disabled}
                </Badge>
              </button>
            </Td>
            <Td className="text-right whitespace-nowrap">
              <IconBtn title={t.users.setPwConfirm(u.username)} onClick={() => setSetPwFor(u)}><Pencil size={15} /></IconBtn>
              <IconBtn title={t.users.resetConfirm(u.username)} onClick={() => setPendingAction({ kind: 'resetPw', user: u })}><KeyRound size={15} /></IconBtn>
              <IconBtn title={t.common.delete} onClick={() => setPendingAction({ kind: 'delete', user: u })} className="hover:!text-red-600"><Trash2 size={15} /></IconBtn>
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
  const [confirmCreate, setConfirmCreate] = useState(false);

  async function doCreate() {
    try {
      await api.createUser({ username: username.trim(), password, role });
      onSaved();
      onClose();
    } catch (err) {
      onError(errText(err, 'Ошибка создания'));
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setConfirmCreate(true);
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
      {confirmCreate && (
        <Confirm title={t.users.createConfirm(username.trim(), role)} confirmLabel={t.common.create}
          onClose={() => setConfirmCreate(false)}
          onConfirm={() => { doCreate(); }} />
      )}
    </Modal>
  );
}

function SetPasswordForm({ user, onClose, onSaved, onError }: {
  user: UserDto; onClose: () => void; onSaved: () => void; onError: (e: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [confirmSet, setConfirmSet] = useState(false);

  async function doSet() {
    try {
      await api.setUserPassword(user.id, password);
      setDone(true);
      setTimeout(() => { onSaved(); onClose(); }, 800);
    } catch (err) {
      onError(errText(err, 'Ошибка сохранения'));
      onClose();
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setConfirmSet(true);
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
      {confirmSet && (
        <Confirm title={t.users.setPwConfirm(user.username)} confirmLabel={t.common.confirm}
          onClose={() => setConfirmSet(false)}
          onConfirm={() => { doSet(); }} />
      )}
    </Modal>
  );
}

function RolesMatrix({ roleBase, canEdit, onChanged, onError }: {
  roleBase: Record<string, string[]>; canEdit: boolean;
  onChanged: () => void; onError: (e: string) => void;
}) {
  const editable = ['operator', 'viewer', 'prompter'];
  const [draft, setDraft] = useState<Record<string, string[]> | null>(null);
  const [saved, setSaved] = useState(false);
  const shown = draft || roleBase;

  const toggle = (role: string, sec: string) =>
    setDraft(d => {
      const base = d || roleBase;
      const cur = base[role] || [];
      const next = cur.includes(sec) ? cur.filter(s => s !== sec) : [...cur, sec];
      return { ...base, [role]: next };
    });

  async function save() {
    if (!draft) return;
    try {
      const roles: Record<string, string[]> = {};
      for (const r of editable) roles[r] = [...(draft[r] || [])].sort();
      await api.updateRoles(roles);
      setSaved(true);
      setDraft(null);
      setTimeout(() => { setSaved(false); onChanged(); }, 800);
    } catch (err) {
      onError(errText(err, 'Ошибка сохранения'));
    }
  }

  const dirty = draft !== null
    && editable.some(r => [...(draft[r] || [])].sort().join() !== [...(roleBase[r] || [])].sort().join());

  return (
    <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 p-4 mb-4">
      <div className="flex items-center justify-between gap-3 mb-1">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200">{t.users.rolesTitle}</h3>
        {canEdit
          ? <Btn variant="primary" onClick={save} disabled={!dirty}>{saved ? <><Check size={14} /> OK</> : t.common.save}</Btn>
          : <span className="text-[11px] text-slate-400">{t.users.rolesAdminOnly}</span>}
      </div>
      <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-3">{t.users.rolesHint}</p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {editable.map(role => (
          <div key={role}>
            <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">
              {role} <span className="normal-case font-normal">({(shown[role] || []).length})</span>
            </p>
            <div className="space-y-px max-h-56 overflow-y-auto pr-1">
              {ALL_SECTIONS.map(sec => (
                <label key={sec} className={`flex items-center gap-2 text-xs px-1 py-0.5 rounded ${canEdit ? 'cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800' : 'opacity-70'} text-slate-700 dark:text-slate-300`}>
                  <input type="checkbox" disabled={!canEdit}
                    checked={(shown[role] || []).includes(sec)}
                    onChange={() => toggle(role, sec)} className="rounded accent-blue-600" />
                  <span className="font-mono truncate" title={sec}>{sec}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionsEditor({ user, base, onClose, onSaved, onError }: { user: UserDto; base: Record<string, string[]>; onClose: () => void; onSaved: () => void; onError: (e: string) => void;
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
    const allowed = new Set(base[user.role] || []);
    const overrides: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(state)) {
      if (!allowed.has(k)) continue;
      if (v === 'allow') overrides[k] = true;
      if (v === 'deny') overrides[k] = false;
    }
    try {
      await api.updateUser(user.id, { sections: Object.keys(overrides).length ? overrides : null });
      setSaved(true);
      setTimeout(() => { onSaved(); onClose(); }, 800);
    } catch (err) {
      onError(errText(err, 'Ошибка сохранения'));
    }
  }

  return (
    <Modal title={`${t.users.sections}: ${user.username} (${user.role})`} onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-[11px] text-slate-500 dark:text-slate-400">{t.users.perUserHint(user.role)}</p>
        {SECTION_GROUPS.map(g => {
          const items = g.items.filter(i => (base[user.role] || []).includes(i.key));
          if (!items.length) return null;
          return (
          <div key={g.title}>
            <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mt-2 mb-1">{g.title}</p>
            {items.map(({ key: sec, label }) => (
              <div key={sec} className="flex items-center justify-between gap-3 py-1 border-b border-slate-100 dark:border-slate-800/70">
                <span className="font-mono text-xs text-slate-700 dark:text-slate-300" title={sec}>{label}</span>
                <div className="flex gap-1 shrink-0">
                  {(['default', 'allow', 'deny'] as const).map(v => (
                    <button key={v} onClick={() => setState(s => ({ ...s, [sec]: v }))}
                      className={`px-2.5 py-1 text-[11px] rounded-lg cursor-pointer transition-colors ${state[sec] === v
                        ? v === 'deny' ? 'bg-red-500 text-white' : v === 'allow' ? 'bg-emerald-600 text-white' : 'bg-blue-600 text-white'
                        : 'bg-slate-200 text-slate-500 hover:bg-slate-300 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'}`}>
                      {v === 'default' ? `default (${base[user.role]?.includes(sec) ? t.common.on : t.common.off})` : v}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          );
        })}
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
