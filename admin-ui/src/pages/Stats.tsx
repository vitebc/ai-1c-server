import { useCallback, useEffect, useState } from 'react';
import { BarChart3, Users, Database, Bot, Clock, Zap, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import type { StatsRequest, StatsSummary } from '../types';
import { t } from '../i18n';
import { PageHeader, Card, CardBody, CardTitle, Badge, Btn, Select } from '../components/ui';

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export default function Stats() {
  // Фильтры
  const [fUser, setFUser] = useState('');
  const [fBase, setFBase] = useState('');
  const [fAgent, setFAgent] = useState('');
  const [fFrom, setFFrom] = useState(daysAgo(1));
  const [fTo, setFTo] = useState(new Date().toISOString().slice(0, 10));

  // Данные для фильтров
  const [userIds, setUserIds] = useState<string[]>([]);
  const [baseNames, setBaseNames] = useState<string[]>([]);
  const [agents, setAgents] = useState<string[]>([]);

  // Результаты
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [requests, setRequests] = useState<StatsRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const pageSize = 50;
  const [loading, setLoading] = useState(false);

  const loadDistinct = useCallback(async () => {
    try {
      const r = await api.getStatsDistinct();
      if (r.ok && r.data) {
        setUserIds(r.data.user_ids || []);
        setBaseNames(r.data.base_names || []);
        setAgents(r.data.agents || []);
      }
    } catch { /* ignore */ }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { from: fFrom, to: `${fTo}T23:59:59` };
      if (fUser) params.user_id = fUser;
      if (fBase) params.base_name = fBase;
      if (fAgent) params.agent = fAgent;

      const [sum, req] = await Promise.all([
        api.getStatsSummary(params),
        api.getStatsRequests({ ...params, limit: String(pageSize), offset: String(page * pageSize) }),
      ]);
      if (sum.ok && sum.data) setSummary(sum.data);
      if (req.ok && req.data) {
        setRequests(req.data.items || []);
        setTotal(req.data.total || 0);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [fUser, fBase, fAgent, fFrom, fTo, page]);

  useEffect(() => { loadDistinct(); }, [loadDistinct]);
  useEffect(() => { load(); }, [load]);

  const resetFilters = () => {
    setFUser(''); setFBase(''); setFAgent('');
    setFFrom(daysAgo(1)); setFTo(new Date().toISOString().slice(0, 10));
    setPage(0);
  };

  const statCards = [
    { label: t.stats.totalRequests, value: summary?.total_requests ?? 0, icon: BarChart3, chip: 'bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-300' },
    { label: t.stats.activeUsers, value: summary?.by_user.length ?? 0, icon: Users, chip: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-300' },
    { label: t.stats.avgElapsed, value: `${summary?.avg_elapsed_s ?? 0}s`, icon: Clock, chip: 'bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-300' },
    { label: t.stats.totalTokens, value: (summary?.total_tokens ?? 0).toLocaleString(), icon: Zap, chip: 'bg-purple-50 text-purple-600 dark:bg-purple-950 dark:text-purple-300' },
  ];

  return (
    <div>
      <PageHeader title={t.stats.title} />

      {/* Фильтры */}
      <Card className="mb-4">
        <CardBody>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <div>
              <label className="block text-[12px] font-medium text-slate-500 dark:text-slate-400 mb-1">{t.stats.filterUser}</label>
              <Select value={fUser} onChange={e => { setFUser(e.target.value); setPage(0); }}>
                <option value="">{t.common.all}</option>
                {userIds.map(u => <option key={u} value={u}>{u}</option>)}
              </Select>
            </div>
            <div>
              <label className="block text-[12px] font-medium text-slate-500 dark:text-slate-400 mb-1">{t.stats.filterBase}</label>
              <Select value={fBase} onChange={e => { setFBase(e.target.value); setPage(0); }}>
                <option value="">{t.common.all}</option>
                {baseNames.map(b => <option key={b} value={b}>{b}</option>)}
              </Select>
            </div>
            <div>
              <label className="block text-[12px] font-medium text-slate-500 dark:text-slate-400 mb-1">{t.stats.filterAgent}</label>
              <Select value={fAgent} onChange={e => { setFAgent(e.target.value); setPage(0); }}>
                <option value="">{t.common.all}</option>
                {agents.map(a => <option key={a} value={a}>{a}</option>)}
              </Select>
            </div>
            <div>
              <label className="block text-[12px] font-medium text-slate-500 dark:text-slate-400 mb-1">{t.stats.filterFrom}</label>
              <input type="date" value={fFrom} onChange={e => { setFFrom(e.target.value); setPage(0); }}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-[13px] text-slate-700 dark:text-slate-200" />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-slate-500 dark:text-slate-400 mb-1">{t.stats.filterTo}</label>
              <input type="date" value={fTo} onChange={e => { setFTo(e.target.value); setPage(0); }}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-[13px] text-slate-700 dark:text-slate-200" />
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 mt-3 pt-3 border-t border-slate-200 dark:border-slate-800">
            <Btn variant="ghost" onClick={resetFilters} className="!text-xs">{t.stats.reset}</Btn>
            <Btn variant="outline" onClick={() => { loadDistinct(); load(); }} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> {t.common.refresh}
            </Btn>
            <Btn variant="primary" onClick={load} disabled={loading}>
              {t.stats.apply}
            </Btn>
          </div>
        </CardBody>
      </Card>

      {/* Сводные карточки */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        {statCards.map(c => (
          <Card key={c.label}>
            <CardBody className="flex items-center gap-3">
              <div className={`p-2.5 rounded-lg ${c.chip}`}><c.icon size={20} /></div>
              <div className="min-w-0">
                <p className="text-[11px] text-slate-400 dark:text-slate-500 uppercase tracking-wide">{c.label}</p>
                <p className="text-xl font-semibold text-slate-800 dark:text-slate-100">{c.value}</p>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      {/* Мини-таблицы: по пользователям / базам / агентам */}
      {summary && (summary.by_user.length > 0 || summary.by_base.length > 0 || summary.by_agent.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-4">
          <Card>
            <CardBody>
              <CardTitle>{t.stats.byUser}</CardTitle>
              <table className="w-full text-[12px]">
                <thead><tr className="text-left text-slate-400 dark:text-slate-500">
                  <th className="pb-1">{t.stats.user}</th><th className="pb-1 text-right">Запросов</th><th className="pb-1 text-right">Токенов</th>
                </tr></thead>
                <tbody>
                  {summary.by_user.slice(0, 8).map(r => (
                    <tr key={r.user_id} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="py-1 font-mono">{r.user_id}</td>
                      <td className="py-1 text-right">{r.count}</td>
                      <td className="py-1 text-right">{r.tokens.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <CardTitle>{t.stats.byBase}</CardTitle>
              <table className="w-full text-[12px]">
                <thead><tr className="text-left text-slate-400 dark:text-slate-500">
                  <th className="pb-1">{t.stats.base}</th><th className="pb-1 text-right">Запросов</th>
                </tr></thead>
                <tbody>
                  {summary.by_base.slice(0, 8).map(r => (
                    <tr key={r.base_name} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="py-1 font-mono flex items-center gap-1"><Database size={12} className="text-slate-400" />{r.base_name}</td>
                      <td className="py-1 text-right">{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <CardTitle>{t.stats.byAgent}</CardTitle>
              <table className="w-full text-[12px]">
                <thead><tr className="text-left text-slate-400 dark:text-slate-500">
                  <th className="pb-1">{t.stats.agent}</th><th className="pb-1 text-right">Запросов</th>
                </tr></thead>
                <tbody>
                  {summary.by_agent.slice(0, 8).map(r => (
                    <tr key={r.agent} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="py-1 font-mono flex items-center gap-1"><Bot size={12} className="text-slate-400" />{r.agent}</td>
                      <td className="py-1 text-right">{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          </Card>
        </div>
      )}

      {/* Таблица запросов */}
      <Card>
        <CardBody className="overflow-x-auto">
          <CardTitle>{t.stats.requestsTable} ({total})</CardTitle>
          <div className="overflow-x-auto -mx-4 px-4">
          {requests.length === 0 ? (
            <p className="text-[13px] text-slate-400 dark:text-slate-500 p-4">{t.stats.noData}</p>
          ) : (
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-slate-400 dark:text-slate-500 border-b border-slate-200 dark:border-slate-700">
                  <th className="px-3 py-2">{t.stats.time}</th>
                  <th className="px-3 py-2">{t.stats.user}</th>
                  <th className="px-3 py-2">{t.stats.base}</th>
                  <th className="px-3 py-2">{t.stats.agent}</th>
                  <th className="px-3 py-2">{t.stats.model}</th>
                  <th className="px-3 py-2">{t.stats.question}</th>
                  <th className="px-3 py-2">{t.stats.status}</th>
                  <th className="px-3 py-2 text-right">{t.stats.tokens}</th>
                  <th className="px-3 py-2 text-right">{t.stats.elapsed}</th>
                </tr>
              </thead>
              <tbody>
                {requests.map(r => (
                  <tr key={r.id} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td className="px-3 py-2 whitespace-nowrap font-mono text-[11px]">
                      {r.created_at ? new Date(r.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                    </td>
                    <td className="px-3 py-2 font-mono">{r.user_id}</td>
                    <td className="px-3 py-2 font-mono">{r.base_name || '—'}</td>
                    <td className="px-3 py-2 font-mono">{r.agent || '—'}</td>
                    <td className="px-3 py-2 font-mono text-[11px] max-w-[140px] truncate" title={r.model || ''}>{r.model || '—'}</td>
                    <td className="px-3 py-2 max-w-[200px] truncate" title={r.question}>{r.question}</td>
                    <td className="px-3 py-2">
                      <Badge tone={r.status === 'ok' ? 'green' : 'red'}>{r.status}</Badge>
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{r.total_tokens.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right font-mono">{r.elapsed_s}s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          </div>
        </CardBody>
      </Card>

      {/* Пагинация */}
      {total > pageSize && (
        <div className="flex items-center justify-between mt-3">
          <Btn variant="ghost" disabled={page === 0} onClick={() => setPage(p => p - 1)} className="!text-xs">
            ← {t.stats.prevPage}
          </Btn>
          <span className="text-[12px] text-slate-400 dark:text-slate-500">
            Стр. {page + 1} из {Math.ceil(total / pageSize)}
          </span>
          <Btn variant="ghost" disabled={(page + 1) * pageSize >= total} onClick={() => setPage(p => p + 1)} className="!text-xs">
            {t.stats.nextPage} →
          </Btn>
        </div>
      )}
    </div>
  );
}
