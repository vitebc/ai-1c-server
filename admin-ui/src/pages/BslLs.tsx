import { useEffect, useState } from 'react';
import { Play, Square, RefreshCw, Terminal, AlertCircle, Download, CheckCircle, XCircle, Coffee } from 'lucide-react';
import { api } from '../api/client';
import type { BslLsState } from '../types';

interface VersionInfo {
  java: string | null;
  bsl_ls_latest: { version: string; jar_url: string | null; published_at: string } | null;
}

const BASE = import.meta.env.VITE_API_BASE || '';

export default function BslLs() {
  const [state, setState] = useState<BslLsState | null>(null);
  const [ver, setVer] = useState<VersionInfo | null>(null);
  const [loadingVer, setLoadingVer] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [dlResult, setDlResult] = useState<string | null>(null);
  const [installingJava, setInstallingJava] = useState(false);
  const [javaInstallResult, setJavaInstallResult] = useState<string | null>(null);
  const [javaPath, setJavaPath] = useState('java');
  const [jarPath, setJarPath] = useState('bsl-language-server.jar');
  const [port, setPort] = useState('8025');
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    load().then(() => checkVersions());
  }, []);

  async function load() {
    const s = await api.getBslLs();
    setState(s);
    setJavaPath(s.config.java_path);
    setJarPath(s.config.jar_path);
    setPort(String(s.config.port));
    setEnabled(s.config.enabled);
  }

  async function checkVersions() {
    setLoadingVer(true);
    setDlResult(null);
    try {
      const r = await fetch(`${BASE}/api/admin/bsl-ls/versions`);
      const data = await r.json();
      setVer(data);
    } finally {
      setLoadingVer(false);
    }
  }

  async function downloadBslLs() {
    setDownloading(true);
    setDlResult(null);
    try {
      const r = await fetch(`${BASE}/api/admin/bsl-ls/download/latest`, { method: 'POST' });
      const data = await r.json();
      if (data.error) {
        setDlResult(`Error: ${data.error}`);
      } else {
        setDlResult(`Downloaded v${data.version} → ${data.path}`);
        load();
      }
    } catch (e: any) {
      setDlResult(`Error: ${e.message}`);
    } finally {
      setDownloading(false);
    }
  }

  async function startBslLs() {
    setSaving(true);
    setEnabled(true);
    try {
      const result = await api.updateBslLs({
        config: { java_path: javaPath, jar_path: jarPath, port: Number(port), enabled: true },
      });
      setState(result);
    } finally {
      setSaving(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const result = await api.updateBslLs({
        config: { java_path: javaPath, jar_path: jarPath, port: Number(port), enabled },
      });
      setState(result);
    } finally {
      setSaving(false);
    }
  }

  async function handleInstallJava() {
    setInstallingJava(true);
    setJavaInstallResult(null);
    try {
      const r = await fetch(`${BASE}/api/admin/bsl-ls/install-java`, { method: 'POST' });
      const data = await r.json();
      if (data.ok) {
        setJavaInstallResult(`Java ${data.version} installed → ${data.java_path}`);
        load();
        checkVersions();
      } else {
        setJavaInstallResult(`Error: ${data.error}`);
      }
    } catch (e: any) {
      setJavaInstallResult(`Error: ${e.message}`);
    } finally {
      setInstallingJava(false);
    }
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
  const isError = state?.status === 'error';

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-800">BSL Language Server</h2>
        <div className="flex gap-2">
          <button onClick={load} className="flex items-center gap-2 px-3 py-2 text-sm text-gray-400 border border-gray-300 rounded-lg hover:bg-gray-200">
            <RefreshCw size={16} /> Refresh
          </button>
          {isRunning ? (
            <button onClick={handleStop} className="flex items-center gap-2 px-3 py-2 text-sm text-red-500 border border-red-300 rounded-lg hover:bg-red-50">
              <Square size={16} /> Stop
            </button>
          ) : (
            <button onClick={startBslLs} disabled={saving}
              className="flex items-center gap-2 px-3 py-2 text-sm text-green-500 border border-green-300 rounded-lg hover:bg-green-50 disabled:opacity-50">
              <Play size={16} /> {saving ? 'Starting...' : 'Start'}
            </button>
          )}
          <button onClick={handleRestart} className="flex items-center gap-2 px-3 py-2 text-sm text-blue-500 border border-blue-300 rounded-lg hover:bg-blue-50">
            <RefreshCw size={16} /> Restart
          </button>
        </div>
      </div>

      {isError && state?.error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-300 rounded-xl flex items-start gap-3">
          <AlertCircle size={20} className="text-red-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-red-500">BSL LS failed to start</p>
            <p className="text-sm text-red-400 mt-1 font-mono">{state.error}</p>
          </div>
        </div>
      )}

      {dlResult && (
        <div className={`mb-6 p-4 rounded-xl flex items-start gap-3 ${dlResult.startsWith('Error') ? 'bg-red-50 border border-red-300' : 'bg-green-50 border border-green-300'}`}>
          {dlResult.startsWith('Error') ? <XCircle size={20} className="text-red-500 shrink-0 mt-0.5" /> : <CheckCircle size={20} className="text-green-500 shrink-0 mt-0.5" />}
          <p className={`text-sm ${dlResult.startsWith('Error') ? 'text-red-400' : 'text-green-500'}`}>{dlResult}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="bg-gray-100 rounded-xl border border-gray-200 p-6">
          <h3 className="font-semibold text-gray-800 mb-4">Status</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between py-2 border-b border-gray-200">
              <span className="text-sm text-gray-500">Status</span>
              <span className={`text-sm px-2 py-0.5 rounded-full ${
                isRunning ? 'bg-green-50 text-green-500' :
                isError ? 'bg-red-50 text-red-500' :
                'bg-gray-200 text-gray-400'
              }`}>
                {state?.status || 'unknown'}
              </span>
            </div>
            {isRunning && state?.pid && (
              <div className="flex items-center justify-between py-2 border-b border-gray-200">
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

        <div className="bg-gray-100 rounded-xl border border-gray-200 p-6">
          <h3 className="font-semibold text-gray-800 mb-4">Configuration</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Java Path</label>
              <input type="text" value={javaPath} onChange={e => setJavaPath(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">JAR Path</label>
              <input type="text" value={jarPath} onChange={e => setJarPath(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Port</label>
              <input type="number" value={port} onChange={e => setPort(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="rounded" />
              Auto-start on server boot
            </label>
            <button onClick={handleSave}
              className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-500 transition-colors">
              Save & Apply
            </button>
          </div>
        </div>
      </div>

      <div className="bg-gray-100 rounded-xl border border-gray-200 p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-800">Versions & Updates</h3>
          <button onClick={checkVersions} disabled={loadingVer}
            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-400 border border-gray-300 rounded-lg hover:bg-gray-200 disabled:opacity-50">
            <RefreshCw size={16} className={loadingVer ? 'animate-spin' : ''} /> Check
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-4 border border-gray-200 rounded-lg">
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Java</p>
            {ver?.java ? (
              <p className="text-sm text-gray-700 font-mono">{ver.java}</p>
            ) : (
              <p className="text-sm text-red-500">Not detected</p>
            )}
          </div>
          <div className="p-4 border border-gray-200 rounded-lg">
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">BSL LS — Latest Release</p>
            {ver?.bsl_ls_latest ? (
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm text-gray-700 font-mono">v{ver.bsl_ls_latest.version}</p>
                  <p className="text-xs text-gray-400">{ver.bsl_ls_latest.published_at?.slice(0, 10)}</p>
                </div>
                <button onClick={downloadBslLs} disabled={downloading || !ver.bsl_ls_latest.jar_url}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-50">
                  <Download size={14} /> {downloading ? 'Downloading...' : 'Download'}
                </button>
              </div>
            ) : (
              <p className="text-sm text-gray-400">
                {loadingVer ? 'Checking...' : 'Click "Check" to see version'}
              </p>
            )}
          </div>
        </div>

        <div className="mt-4 p-4 border border-gray-200 rounded-lg">
          <p className="text-xs text-gray-400 uppercase tracking-wide mb-2">Java JDK</p>
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm text-gray-700 font-mono">{ver?.java || 'Not detected'}</p>
              <p className="text-xs text-gray-400">Auto-download and install JDK 17</p>
            </div>
            <button onClick={handleInstallJava} disabled={installingJava}
              className="flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-50">
              <Coffee size={14} /> {installingJava ? 'Installing...' : 'Install Java'}
            </button>
          </div>
          {javaInstallResult && (
            <p className={`mt-2 text-xs ${javaInstallResult.startsWith('Error') ? 'text-red-500' : 'text-green-500'}`}>
              {javaInstallResult.startsWith('Error') ? <XCircle size={12} className="inline mr-1" /> : <CheckCircle size={12} className="inline mr-1" />}
              {javaInstallResult}
            </p>
          )}
        </div>
      </div>

      <div className="bg-gray-900 text-green-400 font-mono text-xs p-4 rounded-xl border border-gray-200 min-h-[200px]">
        <div className="flex items-center gap-2 text-gray-400 mb-2">
          <Terminal size={14} />
          <span>BSL LS stderr output will appear here</span>
        </div>
      </div>
    </div>
  );
}
