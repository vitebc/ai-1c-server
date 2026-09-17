import { useEffect, useState } from 'react';
import { Folder, File, ChevronUp, Eye, EyeOff } from 'lucide-react';
import { api } from '../api/client';
import type { FsBrowseResult } from '../types';

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
    api.browseFs(path, hidden).then(setData).catch(e => setError(e instanceof Error ? e.message : 'Failed to list'));
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
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60]" onClick={onClose}>
      <div className="bg-gray-100 rounded-xl shadow-xl w-full max-w-xl mx-4 max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b border-gray-200">
          <h4 className="text-sm font-semibold text-gray-800 mb-2">
            {title || (dirsOnly ? 'Select folder' : 'Select binary')}
          </h4>
          <div className="flex items-center gap-2">
            {data?.parent && (
              <button type="button" onClick={() => load(data.parent!)} title="Up"
                className="p-1.5 text-gray-500 hover:text-gray-800 hover:bg-gray-200 rounded transition-colors">
                <ChevronUp size={16} />
              </button>
            )}
            <code className="flex-1 text-xs font-mono text-gray-600 bg-gray-50 border border-gray-200 rounded px-2 py-1.5 truncate">
              {data?.path || '…'}
            </code>
            <button type="button" onClick={toggleHidden} title={showHidden ? 'Hide dotfiles' : 'Show dotfiles'}
              className={`p-1.5 rounded transition-colors ${showHidden ? 'text-blue-500 bg-blue-50' : 'text-gray-500 hover:text-gray-800 hover:bg-gray-200'}`}>
              {showHidden ? <Eye size={16} /> : <EyeOff size={16} />}
            </button>
          </div>
          {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
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
                className={`flex items-center gap-2 w-full text-left px-3 py-1.5 rounded-lg text-sm transition-colors disabled:opacity-40 ${
                  selected === e.path ? 'bg-blue-100 text-blue-700' : 'text-gray-700 hover:bg-gray-200'
                }`}
              >
                {e.is_dir
                  ? <Folder size={16} className="text-yellow-600 shrink-0" />
                  : <File size={16} className="text-gray-400 shrink-0" />}
                <span className={`flex-1 truncate font-mono text-xs ${e.name.startsWith('.') ? 'opacity-50' : ''}`}>{e.name}</span>
                {!e.is_dir && e.size != null && (
                  <span className="text-[11px] text-gray-400 shrink-0">{formatSize(e.size)}</span>
                )}
              </button>
            );
          })}
          {data && data.entries.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-8">Empty directory</p>
          )}
        </div>
        <div className="p-4 border-t border-gray-200 flex items-center justify-between gap-3">
          <code className="flex-1 text-xs font-mono text-gray-600 truncate">
            {selected || (dirsOnly ? 'Click a folder (double-click to enter)' : 'No file selected')}
          </code>
          <div className="flex gap-2 shrink-0">
            {dirsOnly && data?.path && (
              <button type="button" onClick={() => onPick(data.path)}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm hover:bg-gray-300 transition-colors">
                Use this folder
              </button>
            )}
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors">Cancel</button>
            <button type="button" onClick={() => selected && onPick(selected)} disabled={!selected}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-40 transition-colors">
              Select
            </button>
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
