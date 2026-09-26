import { useEffect, useState } from 'react';
import { Folder, File, ChevronUp, Eye, EyeOff } from 'lucide-react';
import { api } from '../api/client';
import type { FsBrowseResult } from '../types';
import { t } from '../i18n';
import { Btn, IconBtn, Alert } from '../components/ui';

export default function FileBrowser({ initialPath, onPick, onClose, dirsOnly, title }: {
  initialPath?: string;
  onPick: (p: string) => void;
  onClose: () => void;
  /** Pick directories instead of files (config source roots). */
  dirsOnly?: boolean;
  title?: string;
}) {
  const [data, setData] = useState<FsBrowseResult | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [showHidden, setShowHidden] = useState(true);

  function load(path?: string, hidden = showHidden) {
    setError('');
    setSelected(null);
    api.browseFs(path, hidden).then(setData).catch(e => setError(e instanceof Error ? e.message : 'Не удалось получить список'));
  }

  useEffect(() => { load(initialPath, true); }, [initialPath]);

  function toggleHidden() {
    const next = !showHidden;
    setShowHidden(next);
    load(data?.path, next);
  }

  function clickEntry(path: string, isDir: boolean) {
    if (isDir) {
      if (dirsOnly) setSelected(path);
      else load(path);
    } else if (!dirsOnly) {
      setSelected(path);
    }
  }

  return (
    <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-[2px] flex items-center justify-center z-[60] p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl w-full max-w-xl mx-4 max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-4 border-b border-slate-200 dark:border-slate-800">
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-2">
            {title || (dirsOnly ? 'Выбрать папку' : 'Выбрать файл')}
          </h4>
          <div className="flex items-center gap-2">
            {data?.parent && (
              <IconBtn title="Вверх" onClick={() => load(data.parent!)}>
                <ChevronUp size={16} />
              </IconBtn>
            )}
            <code className="flex-1 text-xs font-mono text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg px-2 py-1.5 truncate">
              {data?.path || '…'}
            </code>
            <IconBtn
              title={showHidden ? 'Скрыть скрытые файлы' : 'Показать скрытые файлы'}
              onClick={toggleHidden}
              className={showHidden ? '!text-indigo-600 dark:!text-indigo-300' : ''}
            >
              {showHidden ? <Eye size={16} /> : <EyeOff size={16} />}
            </IconBtn>
          </div>
          {error && <div className="mt-2"><Alert tone="red">{error}</Alert></div>}
        </div>
        <div className="flex-1 overflow-y-auto p-2 min-h-[200px]">
          {data?.entries.map(e => {
            const disabled = dirsOnly && !e.is_dir;
            return (
              <button
                key={e.path}
                type="button"
                disabled={disabled}
                onClick={() => clickEntry(e.path, e.is_dir)}
                onDoubleClick={() => e.is_dir && load(e.path)}
                className={`flex items-center gap-2 w-full text-left px-3 py-1.5 rounded-lg text-sm transition-colors cursor-pointer disabled:opacity-40 ${
                  selected === e.path
                    ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'
                    : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
              >
                {e.is_dir
                  ? <Folder size={16} className="text-amber-500 shrink-0" />
                  : <File size={16} className="text-slate-400 shrink-0" />}
                <span className={`flex-1 truncate font-mono text-xs ${e.name.startsWith('.') ? 'opacity-50' : ''}`}>{e.name}</span>
                {!e.is_dir && e.size != null && (
                  <span className="text-[11px] text-slate-400 shrink-0">{formatSize(e.size)}</span>
                )}
              </button>
            );
          })}
          {data && data.entries.length === 0 && (
            <p className="text-sm text-slate-400 text-center py-8">Пустая папка</p>
          )}
        </div>
        <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
          <code className="flex-1 text-xs font-mono text-slate-500 dark:text-slate-400 truncate">
            {selected || (dirsOnly ? 'Кликните папку (двойной клик — войти)' : 'Файл не выбран')}
          </code>
          <div className="flex gap-2 shrink-0">
            {dirsOnly && data?.path && (
              <Btn variant="outline" type="button" onClick={() => onPick(data.path)}>
                Использовать эту папку
              </Btn>
            )}
            <Btn variant="ghost" type="button" onClick={onClose}>{t.common.cancel}</Btn>
            <Btn variant="primary" type="button" onClick={() => selected && onPick(selected)} disabled={!selected}>
              Выбрать
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
