import { useEffect, useState } from 'react';
import { Play, Square, RefreshCw, Terminal } from 'lucide-react';
import { api } from '../api/client';
import type { BslLsState } from '../types';

export default function BslLs() {
  const [state, setState] = useState<BslLsState | null>(null);
  const [javaPath, setJavaPath] = useState('java');
  const [jarPath, setJarPath] = useState('bsl-language-server.jar');
  const [port, setPort] = useState('8025');
  const [enabled, setEnabled] = useState(false);

  useEffect(() => { load(); }, []);

  function load() {
    api.getBslLs().then(s => {
      setState(s);
      setJavaPath(s.config.java_path);
      setJarPath(s.config.jar_path);
      setPort(String(s.config.port));
      setEnabled(s.config.enabled);
    });
  }

  async function handleSave() {
    const result = await api.updateBslLs({
      config: { java_path: javaPath, jar_path: jarPath, port: Number(port), enabled },
    });
    setState(result);
  }

  async function handleRestart() {
    const result = await api.restartBslLs();
    setState(result);
  }

  async function handleStop() {
    const result = await api.stopBslLs();
    setState(result);
  }

  const isRunning = state?.status === 'running';

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-800">BSL Language Server</h2>
        <div className="flex gap-2">
          <button onClick={load} className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50">
            <RefreshCw size={16} /> Refresh
          </button>
          {isRunning ? (
            <button onClick={handleStop} className="flex items-center gap-2 px-3 py-2 text-sm text-red-600 border border-red-300 rounded-lg hover:bg-red-50">
              <Square size={16} /> Stop
            </button>
          ) : (
            <button onClick={handleSave} className="flex items-center gap-2 px-3 py-2 text-sm text-green-600 border border-green-300 rounded-lg hover:bg-green-50">
              <Play size={16} /> Start
            </button>
          )}
          <button onClick={handleRestart} className="flex items-center gap-2 px-3 py-2 text-sm text-blue-600 border border-blue-300 rounded-lg hover:bg-blue-50">
            <RefreshCw size={16} /> Restart
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="font-semibold text-gray-800 mb-4">Status</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between py-2 border-b border-gray-100">
              <span className="text-sm text-gray-500">Status</span>
              <span className={`text-sm px-2 py-0.5 rounded-full ${
                isRunning ? 'bg-green-100 text-green-700' :
                state?.status === 'stopped' ? 'bg-gray-100 text-gray-500' :
                'bg-red-100 text-red-700'
              }`}>
                {state?.status || 'unknown'}
              </span>
            </div>
            {state?.pid && (
              <div className="flex items-center justify-between py-2 border-b border-gray-100">
                <span className="text-sm text-gray-500">Process ID</span>
                <span className="text-sm font-mono text-gray-700">{state.pid}</span>
              </div>
            )}
            <div className="flex items-center justify-between py-2">
              <span className="text-sm text-gray-500">WebSocket URL</span>
              <span className="text-sm font-mono text-gray-700">ws://server:{port}/lsp</span>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="font-semibold text-gray-800 mb-4">Configuration</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Java Path</label>
              <input type="text" value={javaPath} onChange={e => setJavaPath(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">JAR Path</label>
              <input type="text" value={jarPath} onChange={e => setJarPath(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Port</label>
              <input type="number" value={port} onChange={e => setPort(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="rounded" />
              Auto-start on server boot
            </label>
            <button onClick={handleSave}
              className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors">
              Save & Apply
            </button>
          </div>
        </div>
      </div>

      <div className="mt-6 bg-gray-900 text-green-400 font-mono text-xs p-4 rounded-xl border border-gray-200 min-h-[200px]">
        <div className="flex items-center gap-2 text-gray-400 mb-2">
          <Terminal size={14} />
          <span>BSL LS logs will appear here</span>
        </div>
      </div>
    </div>
  );
}
