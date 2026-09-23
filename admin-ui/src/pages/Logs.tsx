import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Trash2, Pause, Play } from 'lucide-react';
import { api } from '../api/client';
import type { LogEntry } from '../types';

const LEVELS = ['all', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];

const LEVEL_STYLE: Record<string, string> = {
  ERROR: 'text-red-400',
  WARN: 'text-yellow-400',
  INFO: 'text-green-400',
  DEBUG: 'text-blue-400',
  TRACE: 'text-gray-500',
};

export default function Logs() {
  const [tab, setTab] = useState<'server' | 'bsl'>('server');
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [bslLines, setBslLines] = useState<string[]>([]);
  const [level, setLevel] = useState('all');
  const [target, setTarget] = useState('all');
  const [targets, setTargets] = useState<string[]>([]);  const [search, setSearch] = useState('');
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
          // Merge server-side distinct list with targets seen in this page,
          // so the dropdown never loses the current selection.
          setTargets(prev => {
            const seen = new Set([...tg.targets, ...data.map(e => e.target)]);
            const merged = [...seen].filter(t => t.startsWith('ai_1c_server')).sort();
            return merged.length ? merged : prev;
          });
        } else {
          setTargets(prev => {
            const seen = new Set([...prev, ...data.map(e => e.target)]);
            return [...seen].filter(t => t.startsWith('ai_1c_server')).sort();
          });
        }
      } else {
        setBslLines(await api.getBslLsLogs());
      }
    } catch {
      /* server may be restarting */
    }
  }, [tab, level, search, target]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [auto, load]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries, bslLines]);

  async function handleClear() {
    if (!confirm('Clear logs?')) return;
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
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold text-gray-800">Logs</h2>
        <div className="flex items-center gap-2">
          <button onClick={() => setAuto(a => !a)} title={auto ? 'Pause auto-refresh' : 'Resume auto-refresh'}
            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-200 transition-colors">
            {auto ? <Pause size={16} /> : <Play size={16} />} {auto ? 'Live' : 'Paused'}
          </button>
          <button onClick={load}
            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-200 transition-colors">
            <RefreshCw size={16} /> Refresh
          </button>
          <button onClick={handleClear}
            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-200 transition-colors">
            <Trash2 size={16} /> Clear
          </button>
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        {(['server', 'bsl'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-1.5 text-sm rounded-lg transition-colors ${tab === t ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 border border-gray-200 hover:bg-gray-200'}`}>
            {t === 'server' ? 'Server' : 'BSL LS'}
          </button>
        ))}
        {tab === 'server' && (
          <>
            <select value={level} onChange={e => setLevel(e.target.value)}
              className="ml-2 px-3 py-1.5 text-sm bg-gray-100 text-gray-700 border border-gray-200 rounded-lg focus:outline-none">
              {LEVELS.map(l => <option key={l} value={l}>{l === 'all' ? 'All levels' : l}</option>)}
            </select>
            <select value={target} onChange={e => setTarget(e.target.value)} title="Filter by module (prefix match)"
              className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 border border-gray-200 rounded-lg focus:outline-none max-w-[220px]">
              <option value="all">All modules</option>
              {targets.map(t => <option key={t} value={t}>{t.replace(/^ai_1c_server::/, '')}</option>)}
            </select>
            <form onSubmit={submitSearch} className="flex-1">
              <input value={searchInput} onChange={e => setSearchInput(e.target.value)}
                placeholder="Search… (Enter)"
                className="w-full px-3 py-1.5 text-sm bg-gray-100 text-gray-700 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </form>
          </>
        )}
      </div>

      <div className="bg-gray-900 font-mono text-xs p-4 rounded-xl border border-gray-200 h-[60vh] overflow-y-auto">
        {tab === 'server' ? (
          entries.length === 0
            ? <p className="text-gray-500 italic">No log entries</p>
            : entries.map((e, i) => (
              <div key={i} className="flex gap-2 py-px leading-relaxed break-all">
                <span className="text-gray-500 shrink-0">{e.ts.slice(11, 23)}</span>
                <span className={`shrink-0 w-12 font-bold ${LEVEL_STYLE[e.level] || 'text-gray-400'}`}>{e.level}</span>
                <span className="text-gray-500 shrink-0 max-w-[220px] truncate" title={e.target}>{e.target}</span>
                <span className="text-gray-200">{e.msg}</span>
              </div>
            ))
        ) : (
          bslLines.length === 0
            ? <p className="text-gray-500 italic">BSL LS log is empty</p>
            : bslLines.map((l, i) => <div key={i} className="text-gray-200 py-px leading-relaxed break-all">{l}</div>)
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
