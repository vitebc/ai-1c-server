import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Eye, RotateCcw } from 'lucide-react';
import { api } from '../api/client';
import type { AgentChange } from '../types';
import { t } from '../i18n';
import { PageHeader, Card, CardBody, Badge, Btn, Select, Modal, Confirm } from '../components/ui';

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function actionLabel(a: string): string {
  const map: Record<string, string> = {
    create: t.studio.changeCreated,
    update: t.studio.changeUpdated,
    delete: t.studio.changeDeleted,
    revert: t.studio.changeReverted,
  };
  return map[a] || a;
}

function actionTone(a: string): 'green' | 'red' | 'amber' | 'blue' {
  if (a === 'create') return 'green';
  if (a === 'delete') return 'red';
  if (a === 'revert') return 'amber';
  return 'blue';
}

function entityTypeLabel(e: string): string {
  const map: Record<string, string> = { agent: 'Агент', skill: 'Скилл', pattern: 'Паттерн' };
  return map[e] || e;
}

function entityTone(e: string): 'blue' | 'green' | 'sky' {
  if (e === 'agent') return 'blue';
  if (e === 'skill') return 'green';
  return 'sky';
}

export default function AgentChanges() {
  // Filters
  const [fUser, setFUser] = useState('');
  const [fType, setFType] = useState('');
  const [fAction, setFAction] = useState('');
  const [fName, setFName] = useState('');

  // Data
  const [items, setItems] = useState<AgentChange[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const pageSize = 50;
  const [loading, setLoading] = useState(false);

  // Filter options
  const [users, setUsers] = useState<string[]>([]);

  // Diff modal
  const [diffItem, setDiffItem] = useState<AgentChange | null>(null);
  const [diffText, setDiffText] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);

  // Revert confirm
  const [revertItem, setRevertItem] = useState<AgentChange | null>(null);

  const loadDistinct = useCallback(async () => {
    try {
      const r = await api.getAgentChangesDistinct();
      setUsers(r.users || []);
    } catch { /* ignore */ }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { limit: String(pageSize), offset: String(page * pageSize) };
      if (fUser) params.user_id = fUser;
      if (fType) params.entity_type = fType;
      if (fAction) params.action = fAction;
      if (fName) params.entity_name = fName;
      const r = await api.getAgentChanges(params);
      setItems(r.items || []);
      setTotal(r.total || 0);
    } catch { /* ignore */ }
    setLoading(false);
  }, [fUser, fType, fAction, fName, page]);

  useEffect(() => { loadDistinct(); }, [loadDistinct]);
  useEffect(() => { load(); }, [load]);

  const showDiff = async (item: AgentChange) => {
    setDiffItem(item);
    setDiffLoading(true);
    setDiffText('');
    try {
      const r = await api.getAgentChangeDiff(item.id);
      setDiffText(r.diff || '(пусто)');
    } catch (e) {
      setDiffText(`Ошибка: ${e}`);
    }
    setDiffLoading(false);
  };

  const doRevert = async () => {
    if (!revertItem) return;
    try {
      await api.revertAgentChange(revertItem.id);
      setRevertItem(null);
      load(); // refresh
    } catch (e: any) {
      alert(`Ошибка отката: ${e.message || e}`);
    }
  };

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="space-y-4">
      <PageHeader
        title={t.studio.changesTitle}
        hint={t.studio.changesHint}
        right={
          <Btn variant="outline" onClick={load} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {t.common.refresh}
          </Btn>
        }
      />

      {/* Filters */}
      <Card>
        <CardBody className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-400">{t.studio.changeUser}</label>
            <Select value={fUser} onChange={(e) => { setFUser(e.target.value); setPage(0); }} className="w-40">
              <option value="">{t.common.all}</option>
              {users.map(u => <option key={u} value={u}>{u}</option>)}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-400">{t.studio.changeEntity}</label>
            <Select value={fType} onChange={(e) => { setFType(e.target.value); setPage(0); }} className="w-32">
              <option value="">{t.common.all}</option>
              <option value="agent">Агент</option>
              <option value="skill">Скилл</option>
              <option value="pattern">Паттерн</option>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-400">{t.studio.changeAction}</label>
            <Select value={fAction} onChange={(e) => { setFAction(e.target.value); setPage(0); }} className="w-32">
              <option value="">{t.common.all}</option>
              <option value="create">Создан</option>
              <option value="update">Изменён</option>
              <option value="delete">Удалён</option>
              <option value="revert">Откат</option>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-400">{t.common.search}</label>
            <input
              type="text"
              value={fName}
              onChange={(e) => { setFName(e.target.value); setPage(0); }}
              placeholder="Название…"
              className="px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-500 w-40"
            />
          </div>
        </CardBody>
      </Card>

      {/* Table */}
      <Card>
        <CardBody className="p-0 overflow-x-auto">
          {items.length === 0 && !loading ? (
            <div className="p-8 text-center text-slate-500">{t.studio.noChanges}</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-700 text-left text-xs text-slate-400 uppercase">
                  <th className="px-4 py-3">{t.studio.changeTime}</th>
                  <th className="px-4 py-3">{t.studio.changeUser}</th>
                  <th className="px-4 py-3">{t.studio.changeEntity}</th>
                  <th className="px-4 py-3">{t.studio.changeAction}</th>
                  <th className="px-4 py-3">{t.studio.changeCommit}</th>
                  <th className="px-4 py-3 text-right">{t.common.actions}</th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr key={item.id} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap">{fmtTime(item.timestamp)}</td>
                    <td className="px-4 py-3 text-slate-900 dark:text-slate-200">{item.username}</td>
                    <td className="px-4 py-3">
                      <Badge tone={entityTone(item.entity_type)}>{entityTypeLabel(item.entity_type)}</Badge>
                      <span className="ml-2 text-slate-900 dark:text-slate-200">{item.entity_name}</span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={actionTone(item.action)}>{actionLabel(item.action)}</Badge>
                    </td>
                    <td className="px-4 py-3 text-slate-400 font-mono text-xs">{item.git_commit_hash.slice(0, 8)}</td>
                    <td className="px-4 py-3 text-right space-x-1">
                      <Btn variant="ghost" onClick={() => showDiff(item)} title={t.studio.changeDiff}>
                        <Eye size={14} />
                      </Btn>
                      {item.action !== 'revert' && (
                        <Btn variant="ghost" onClick={() => setRevertItem(item)} title={t.studio.changeRevert}>
                          <RotateCcw size={14} />
                        </Btn>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-slate-500 dark:text-slate-400">
          <span>{total} записей</span>
          <div className="space-x-2">
            <Btn variant="outline" disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Назад</Btn>
            <span>Стр. {page + 1} / {totalPages}</span>
            <Btn variant="outline" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Вперёд →</Btn>
          </div>
        </div>
      )}

      {/* Diff modal */}
      {diffItem && (
        <Modal title={`${t.studio.changeDiff}: ${diffItem.entity_name}`} onClose={() => setDiffItem(null)} wide>
          <pre className="text-xs font-mono bg-slate-950 text-slate-200 rounded-lg p-4 overflow-auto max-h-[60vh] whitespace-pre-wrap">
            {diffLoading ? 'Загрузка…' : diffText}
          </pre>
        </Modal>
      )}

      {/* Revert confirm */}
      {revertItem && (
        <Confirm
          title={t.studio.changeRevert}
          message={t.studio.changeRevertConfirm(revertItem.entity_name)}
          confirmLabel={t.studio.changeRevert}
          danger
          onConfirm={doRevert}
          onClose={() => setRevertItem(null)}
        />
      )}
    </div>
  );
}
