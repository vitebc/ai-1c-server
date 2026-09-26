import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Trash2, Pause, Play } from 'lucide-react';
import { api } from '../api/client';
import type { LogEntry } from '../types';
import { t } from '../i18n';
import { PageHeader, Btn, Select, TextInput, Segmented } from '../components/ui';

const LEVELS = ['all', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];

const LEVEL_STYLE: Record<string, string> = {
  ERROR: 'text-red-500 dark:text-red-400',
  WARN: 'text-amber-600 dark:text-amber-400',
  INFO: 'text-emerald-600 dark:text-emerald-400',
  DEBUG: 'text-blue-500 dark:text-blue-300',
  TRACE: 'text-slate-400',
};

export default function Logs() {
  const [tab, setTab] = useState<'server' | 'bsl'>('server');
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [bslLines, setBslLines] = useState<string[]>([]);
  const [level, setLevel] = useState('all');
  const [target, setTarget] = useState('all');
  const [targets, setTargets] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [auto, setAuto] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      if (tab === 'server') {
        const [data, tg] = await Promise.all([
          api.getLogs({
            level: level === 'all' ? undefined : level,
            limit: 300,
            search: search || undefined,
            target: target === 'all' ? undefined : target,
          }),
          api.getLogTargets().catch(() => null),
        ]);
        setEntries(data);
        if (tg) {
          setTargets(prev => {
            const seen = new Set([...tg.targets, ...data.map(e => e.target)]);
            const merged = [...seen].filter(x => x.startsWith('ai_1c_server')).sort();
            return merged.length ? merged : prev;
          });
        } else {
          setTargets(prev => {
            const seen = new Set([...prev, ...data.map(e => e.target)]);
            return [...seen].filter(x => x.startsWith('ai_1c_server')).sort();
          });
        }
      } else {
        setBslLines(await api.getBslLsLogs());
      }
    } catch { /* сервер может перезапускаться */ }
  }, [tab, level, search, target]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [auto, load]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries, bslLines]);

  async function handleClear() {
    if (!confirm(t.logs.clearConfirm)) return;
    if (tab === 'server') await api.clearLogs();
    else await api.clearBslLsLogs();
    load();
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    setSearch(searchInput);
  }

  return (
    <div>
      <PageHeader
        title={t.logs.title}
        right={<>
          <Btn variant="outline" onClick={() => setAuto(a => !a)} title={auto ? 'Приостановить автообновление' : 'Продолжить автообновление'}>
            {auto ? <Pause size={15} /> : <Play size={15} />} {auto ? t.logs.live : t.logs.paused}
          </Btn>
          <Btn variant="outline" onClick={load}><RefreshCw size={15} /> {t.common.refresh}</Btn>
          <Btn variant="outline" onClick={handleClear}><Trash2 size={15} /> {t.logs.clear}</Btn>
        </>}
      />

      <div className="flex gap-2 mb-3 flex-wrap items-center">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[{ key: 'server', label: t.logs.server }, { key: 'bsl', label: 'BSL LS' }]}
        />
        {tab === 'server' && (
          <>
            <Select value={level} onChange={e => setLevel(e.target.value)} className="!w-auto">
              {LEVELS.map(l => <option key={l} value={l}>{l === 'all' ? t.logs.allLevels : l}</option>)}
            </Select>
            <Select value={target} onChange={e => setTarget(e.target.value)} title="Фильтр по модулю" className="!w-auto max-w-[220px]">
              <option value="all">{t.logs.allModules}</option>
              {targets.map(x => <option key={x} value={x}>{x.replace(/^ai_1c_server::/, '')}</option>)}
            </Select>
            <form onSubmit={submitSearch} className="flex-1 min-w-[180px]">
              <TextInput value={searchInput} onChange={e => setSearchInput(e.target.value)} placeholder={`${t.common.search} (Enter)`} />
            </form>
          </>
        )}
      </div>

      <div className="rounded-xl border border-slate-200 bg-slate-950 font-mono text-xs p-4 h-[60vh] overflow-y-auto dark:border-slate-800">
        {tab === 'server' ? (
          entries.length === 0
            ? <p className="text-slate-500 italic">{t.logs.noEntries}</p>
            : entries.map((e, i) => (
              <div key={i} className="flex gap-2 py-px leading-relaxed break-all">
                <span className="text-slate-500 shrink-0 tabular-nums">{e.ts.slice(11, 23)}</span>
                <span className={`shrink-0 w-12 font-bold ${LEVEL_STYLE[e.level] || 'text-slate-400'}`}>{e.level}</span>
                <span className="text-slate-500 shrink-0 max-w-[220px] truncate" title={e.target}>{e.target}</span>
                <span className="text-slate-200">{e.msg}</span>
              </div>
            ))
        ) : (
          bslLines.length === 0
            ? <p className="text-slate-500 italic">{t.logs.bslEmpty}</p>
            : bslLines.map((l, i) => <div key={i} className="text-slate-200 py-px leading-relaxed break-all">{l}</div>)
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
