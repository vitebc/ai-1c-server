import { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, KeyRound, Check } from 'lucide-react';
import { api } from '../api/client';
import type { UserDto } from '../types';

const ROLES = ['admin', 'operator', 'viewer'];

const ALL_SECTIONS = [
  'dashboard', 'mcp-servers', 'agent-studio', 'skills', 'bsl-ls', 'configs',
  'client-versions', 'clients', 'logs', 'settings', 'fs', 'env', 'users', 'auth-manage',
];

const ROLE_BASE: Record<string, string[]> = {
  admin: ALL_SECTIONS,
  operator: ['dashboard', 'mcp-servers', 'agent-studio', 'skills', 'bsl-ls', 'configs', 'client-versions', 'clients', 'logs', 'settings', 'fs', 'env'],
  viewer: ['dashboard', 'mcp-servers', 'agent-studio', 'skills', 'bsl-ls', 'configs', 'client-versions', 'clients', 'logs'],
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
    if (!confirm(`Delete user "${u.username}"? They will lose access immediately.`)) return;
    if (!confirm(`Type-confirm: really delete "${u.username}"?`)) return;
    try {
      await api.deleteUser(u.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  async function resetPw(u: UserDto) {
    if (!confirm(`Reset password for "${u.username}"? The old password stops working immediately.`)) return;
    try {
      const r = await api.resetUserPassword(u.id);
      setNewPw(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed');
    }
  }

  async function toggleEnabled(u: UserDto) {
    const action = u.enabled ? 'disable' : 'enable';
    if (!confirm(`${action === 'disable' ? 'Disable' : 'Enable'} user "${u.username}"?`)) return;
    try {
      await api.updateUser(u.id, { enabled: !u.enabled });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    }
  }

  async function changeRole(u: UserDto, role: string) {
    if (!confirm(`Change role of "${u.username}" to ${role}?`)) return;
    try {
      await api.updateUser(u.id, { role });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-800">Users</h2>
        <button onClick={() => setShowNew(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
          <Plus size={16} /> New User
        </button>
      </div>

      {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">{error}</p>}

      {showNew && <NewUserForm onClose={() => setShowNew(false)} onSaved={load} onError={setError} />}
      {setPwFor && (
        <SetPasswordForm user={setPwFor} onClose={() => setSetPwFor(null)} onSaved={load} onError={setError} />
      )}
      {editSections && (
        <SectionsEditor user={editSections} onClose={() => setEditSections(null)} onSaved={load} onError={setError} />
      )}
      {newPw && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setNewPw(null)}>
          <div className="bg-gray-100 rounded-xl shadow-xl w-full max-w-sm mx-4 p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-800 mb-2">New password for {newPw.username}</h3>
            <p className="text-xs text-red-600 mb-3">Shown once — copy it now.</p>
            <code className="block text-sm font-mono text-gray-800 bg-gray-50 border border-gray-200 rounded px-3 py-2 mb-4 break-all">{newPw.password}</code>
            <button onClick={() => setNewPw(null)} className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">Close</button>
          </div>
        </div>
      )}

      <div className="bg-gray-100 rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="text-left px-4 py-3 font-medium text-gray-600">Username</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Role</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Sections</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Enabled</th>
              <th className="text-right px-4 py-3 font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map(u => (
              <tr key={u.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-xs font-medium text-gray-800">{u.username}</td>
                <td className="px-4 py-3">
                  <select value={u.role} onChange={e => changeRole(u, e.target.value)}
                    className="text-xs px-2 py-1 border border-gray-300 rounded-lg bg-gray-50 text-gray-700">
                    {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </td>
                <td className="px-4 py-3 text-gray-600 text-[11px] max-w-[280px]">
                  {u.sections
                    ? Object.entries(u.sections).map(([k, v]) => `${v ? '+' : '−'}${k}`).join(' ')
                    : <span className="text-gray-400">role defaults ({ROLE_BASE[u.role]?.length || 0})</span>}
                  <button onClick={() => setEditSections(u)} className="ml-2 text-blue-500 hover:underline">edit</button>
                </td>
                <td className="px-4 py-3">
                  <button onClick={() => toggleEnabled(u)}
                    className={`text-xs px-2 py-0.5 rounded-full ${u.enabled ? 'bg-green-50 text-green-500' : 'bg-gray-200 text-gray-400'}`}>
                    {u.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <button title="Set password manually" onClick={() => setSetPwFor(u)} className="p-1.5 text-gray-400 hover:text-blue-600"><Pencil size={16} /></button>
                  <button title="Reset password (random)" onClick={() => resetPw(u)} className="p-1.5 text-gray-400 hover:text-yellow-600"><KeyRound size={16} /></button>
                  <button title="Delete" onClick={() => remove(u)} className="p-1.5 text-gray-400 hover:text-red-600"><Trash2 size={16} /></button>
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">No users</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NewUserForm({ onClose, onSaved, onError }: { onClose: () => void; onSaved: () => void; onError: (e: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('viewer');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.createUser({ username: username.trim(), password, role });
      onSaved();
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Create failed');
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-100 rounded-xl shadow-xl w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
        <form onSubmit={submit} className="p-6 space-y-4">
          <h3 className="text-lg font-semibold text-gray-800">New user</h3>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Username (a-z 0-9 _ . -, 3+ chars)</label>
            <input type="text" value={username} onChange={e => setUsername(e.target.value)} required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password (8+ chars)</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
            <select value={role} onChange={e => setRole(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-gray-100 text-gray-800">
              {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
            <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">Create</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SetPasswordForm({ user, onClose, onSaved, onError }: {
  user: UserDto; onClose: () => void; onSaved: () => void; onError: (e: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!confirm(`Set new password for "${user.username}"? The old password stops working immediately.`)) return;
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
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-100 rounded-xl shadow-xl w-full max-w-sm mx-4" onClick={e => e.stopPropagation()}>
        <form onSubmit={submit} className="p-6 space-y-4">
          <h3 className="text-lg font-semibold text-gray-800">Set password: {user.username}</h3>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)}
            placeholder="New password (8+ chars)" autoFocus
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          {done && <p className="text-xs text-green-600">Password set</p>}
          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
            <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">Save</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SectionsEditor({ user, onClose, onSaved, onError }: {  user: UserDto; onClose: () => void; onSaved: () => void; onError: (e: string) => void;
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
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-100 rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="p-6 space-y-3">
          <h3 className="text-lg font-semibold text-gray-800">Sections for {user.username} <span className="text-xs text-gray-500 font-normal">(role: {user.role})</span></h3>
          <p className="text-[11px] text-gray-500">Default = role matrix. Viewer stays read-only even when a section is allowed.</p>
          {ALL_SECTIONS.map(sec => (
            <div key={sec} className="flex items-center justify-between py-1 border-b border-gray-100">
              <span className="font-mono text-xs text-gray-700">{sec}</span>
              <div className="flex gap-1">
                {(['default', 'allow', 'deny'] as const).map(v => (
                  <button key={v} onClick={() => setState(s => ({ ...s, [sec]: v }))}
                    className={`px-2.5 py-1 text-[11px] rounded-lg ${state[sec] === v
                      ? v === 'deny' ? 'bg-red-500 text-white' : v === 'allow' ? 'bg-green-600 text-white' : 'bg-blue-600 text-white'
                      : 'bg-gray-200 text-gray-500 hover:bg-gray-300'}`}>
                    {v === 'default' ? `default (${ROLE_BASE[user.role]?.includes(sec) ? 'on' : 'off'})` : v}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="flex justify-end gap-3 pt-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
            <button onClick={save} className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
              {saved ? <><Check size={14} /> Saved</> : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
