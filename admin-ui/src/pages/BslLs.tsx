import { useEffect, useRef, useState } from 'react';
import { Play, Square, RefreshCw, Terminal, AlertCircle, Download, CheckCircle, XCircle, Coffee } from 'lucide-react';
import { api, authFetch } from '../api/client';
import type { BslLsState } from '../types';
import { t } from '../i18n';
import { PageHeader, Card, CardBody, CardTitle, Btn, Field, TextInput, Alert, Badge } from '../components/ui';

interface VersionInfo {
  java: string | null;
  bsl_ls_current: string | null;
  bsl_ls_latest: { version: string; jar_url: string | null; published_at: string } | null;
}

export default function BslLs() {
  const [state, setState] = useState<BslLsState | null>(null);
  const [ver, setVer] = useState<VersionInfo | null>(null);
  const [loadingVer, setLoadingVer] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [dlResult, setDlResult] = useState<string | null>(null);
  const [installingJava, setInstallingJava] = useState(false);
  const [javaInstallResult, setJavaInstallResult] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const logsRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [javaPath, setJavaPath] = useState('java');
  const [jarPath, setJarPath] = useState('bsl-language-server.jar');
  const [port, setPort] = useState('8025');
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    load().then(() => checkVersions());
    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (autoScroll && logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  async function fetchLogs() {
    try {
      const r = await authFetch('/bsl-ls/logs');
      const data = await r.json();
      setLogs(Array.isArray(data) ? data : []);
    } catch {}
  }

  async function clearLogs() {
    try {
      await authFetch('/bsl-ls/logs/clear', { method: 'POST' });
      setLogs([]);
    } catch {}
  }

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
      const r = await authFetch('/bsl-ls/versions');
      const data = await r.json();
      setVer(data);
    } catch (e: any) {
      setDlResult(`Error: ${e.message}`);
    } finally {
      setLoadingVer(false);
    }
  }

  async function downloadBslLs() {
    setDownloading(true);
    setDlResult(null);
    try {
      const r = await authFetch('/bsl-ls/download/latest', { method: 'POST' });
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
      const r = await authFetch('/bsl-ls/install-java', { method: 'POST' });
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
      <PageHeader
        title={t.bsl.title}
        right={<>
          <Btn variant="outline" onClick={load}>
            <RefreshCw size={15} /> {t.common.refresh}
          </Btn>
          {isRunning ? (
            <Btn variant="danger-outline" onClick={handleStop}>
              <Square size={15} /> {t.bsl.stop}
            </Btn>
          ) : (
            <Btn variant="success-outline" onClick={startBslLs} disabled={saving}>
              <Play size={15} /> {saving ? t.common.starting : t.bsl.start}
            </Btn>
          )}
          <Btn variant="outline" onClick={handleRestart}>
            <RefreshCw size={15} /> {t.bsl.restart}
          </Btn>
        </>}
      />

      {isError && state?.error && (
        <div className="mb-4">
          <Alert tone="red">
            <span className="flex items-start gap-2">
              <AlertCircle size={16} className="shrink-0 mt-px" />
              <span>
                <span className="block font-medium text-[13px]">{t.bsl.failTitle}</span>
                <span className="block font-mono mt-1">{state.error}</span>
              </span>
            </span>
          </Alert>
        </div>
      )}

      {dlResult && (
        <div className="mb-4">
          <Alert tone={dlResult.startsWith('Error') ? 'red' : 'green'}>
            <span className="flex items-start gap-2">
              {dlResult.startsWith('Error') ? <XCircle size={16} className="shrink-0 mt-px" /> : <CheckCircle size={16} className="shrink-0 mt-px" />}
              <span>{dlResult}</span>
            </span>
          </Alert>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 mb-4">
        <Card>
          <CardBody>
            <CardTitle>{t.bsl.status}</CardTitle>
            <div className="space-y-1">
              <div className="flex items-center justify-between py-2 border-b border-slate-200 dark:border-slate-800">
                <span className="text-[13px] text-slate-500 dark:text-slate-400">{t.common.status}</span>
                <Badge tone={isRunning ? 'green' : isError ? 'red' : 'neutral'}>
                  {state?.status || t.common.stopped}
                </Badge>
              </div>
              {isRunning && state?.pid && (
                <div className="flex items-center justify-between py-2 border-b border-slate-200 dark:border-slate-800">
                  <span className="text-[13px] text-slate-500 dark:text-slate-400">{t.bsl.pidLabel}</span>
                  <span className="text-[13px] font-mono text-slate-700 dark:text-slate-200">{state.pid}</span>
                </div>
              )}
              <div className="flex items-center justify-between py-2">
                <span className="text-[13px] text-slate-500 dark:text-slate-400">{t.bsl.wsUrl}</span>
                <span className="text-[13px] font-mono text-slate-700 dark:text-slate-200">ws://server:{port}/lsp</span>
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <CardTitle>{t.bsl.config}</CardTitle>
            <div className="space-y-3">
              <Field label={t.bsl.javaPath}>
                <TextInput value={javaPath} onChange={e => setJavaPath(e.target.value)} mono />
              </Field>
              <Field label={t.bsl.jarPath}>
                <TextInput value={jarPath} onChange={e => setJarPath(e.target.value)} mono />
              </Field>
              <Field label={t.bsl.port}>
                <TextInput type="number" value={port} onChange={e => setPort(e.target.value)} mono />
              </Field>
              <label className="flex items-center gap-2 text-[13px] text-slate-700 dark:text-slate-300 cursor-pointer">
                <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="rounded accent-indigo-600" />
                {t.bsl.autostart}
              </label>
              <Btn variant="primary" onClick={handleSave} disabled={saving} className="w-full justify-center">
                {saving ? t.common.saving : t.bsl.saveApply}
              </Btn>
            </div>
          </CardBody>
        </Card>
      </div>

      <Card className="mb-4">
        <CardBody>
          <CardTitle right={
            <Btn variant="outline" onClick={checkVersions} disabled={loadingVer}>
              <RefreshCw size={15} className={loadingVer ? 'animate-spin' : ''} /> {t.bsl.check}
            </Btn>
          }>{t.bsl.versions}</CardTitle>
          <div className="grid grid-cols-2 gap-3">
            <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-4">
              <p className="text-[11px] text-slate-400 dark:text-slate-500 uppercase tracking-wide mb-1">{t.bsl.java}</p>
              {ver?.java ? (
                <p className="text-[13px] text-slate-700 dark:text-slate-200 font-mono">{ver.java}</p>
              ) : (
                <p className="text-[13px] text-red-600 dark:text-red-400">{t.bsl.notFound}</p>
              )}
            </div>
            <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-4">
              <p className="text-[11px] text-slate-400 dark:text-slate-500 uppercase tracking-wide mb-1">BSL LS</p>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[13px] text-slate-700 dark:text-slate-200 font-mono">
                    {t.bsl.current}: {ver?.bsl_ls_current ? `v${ver.bsl_ls_current}` : '—'}
                  </p>
                  {ver?.bsl_ls_latest ? (
                    <p className="text-xs mt-0.5">
                      <span className="text-slate-400 dark:text-slate-500">{t.bsl.latest}: v{ver.bsl_ls_latest.version} </span>
                      {ver.bsl_ls_latest.jar_url && ver.bsl_ls_current !== ver.bsl_ls_latest.version && (
                        <span className="text-amber-600 dark:text-amber-400 font-medium">{t.bsl.updateAvail}</span>
                      )}
                      {ver.bsl_ls_current === ver.bsl_ls_latest.version && (
                        <span className="text-emerald-600 dark:text-emerald-400">{t.bsl.upToDate}</span>
                      )}
                    </p>
                  ) : (
                    <p className="text-xs text-slate-400 dark:text-slate-500">{loadingVer ? t.common.loading : ''}</p>
                  )}
                </div>
                {ver?.bsl_ls_latest?.jar_url && (
                  <Btn variant="primary" onClick={downloadBslLs} disabled={downloading} className="!text-xs !py-1.5">
                    <Download size={14} /> {downloading ? t.bsl.downloading : t.bsl.download}
                  </Btn>
                )}
              </div>
            </div>
          </div>

          <div className="mt-3 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
            <p className="text-[11px] text-slate-400 dark:text-slate-500 uppercase tracking-wide mb-2">{t.bsl.javaJdk}</p>
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-[13px] text-slate-700 dark:text-slate-200 font-mono">{ver?.java || t.bsl.notFound}</p>
                <p className="text-xs text-slate-400 dark:text-slate-500">{t.bsl.javaJdkHint}</p>
              </div>
              <Btn variant="primary" onClick={handleInstallJava} disabled={installingJava} className="!text-xs !py-1.5">
                <Coffee size={14} /> {installingJava ? t.bsl.installing : t.bsl.installJava}
              </Btn>
            </div>
            {javaInstallResult && (
              <p className={`mt-2 text-xs ${javaInstallResult.startsWith('Error') ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                {javaInstallResult.startsWith('Error') ? <XCircle size={12} className="inline mr-1" /> : <CheckCircle size={12} className="inline mr-1" />}
                {javaInstallResult}
              </p>
            )}
          </div>
        </CardBody>
      </Card>

      <div className="rounded-xl border border-slate-800 bg-slate-950 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800">
          <div className="flex items-center gap-2 text-slate-400">
            <Terminal size={14} />
            <span className="text-xs">{t.bsl.logsTitle}</span>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
              <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} className="rounded accent-indigo-600" />
              {t.bsl.autoscroll}
            </label>
            <button onClick={clearLogs} className="text-xs text-slate-500 hover:text-slate-300 transition-colors cursor-pointer">{t.logs.clear}</button>
          </div>
        </div>
        <div ref={logsRef} className="h-64 overflow-y-auto p-4 font-mono text-xs leading-relaxed">
          {logs.length === 0 ? (
            <p className="text-slate-600 italic">{t.bsl.noLogs}</p>
          ) : (
            logs.map((line, i) => (
              <div key={i} className={
                line.includes('ERROR') || line.includes('Error') || line.includes('Exception')
                  ? 'text-red-400'
                  : line.includes('WARN') || line.includes('WARNING')
                  ? 'text-amber-400'
                  : 'text-emerald-400'
              }>
                {line}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
