import { Inbox } from 'lucide-react';
import type { ReactNode } from 'react';

// Единые примитивы плотной dev-консоли: светлая/тёмная через dark: вариант Tailwind.

export function PageHeader({ title, hint, right }: { title: string; hint?: string; right?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 mb-5">
      <div className="min-w-0">
        <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">{title}</h2>
        {hint && <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{hint}</p>}
      </div>
      {right && <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">{right}</div>}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgb(15_23_42/0.05)] dark:border-slate-800 dark:bg-slate-900 ${className}`}>
      {children}
    </div>
  );
}

export function CardBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`p-4 ${className}`}>{children}</div>;
}

export function CardTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3">
      <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200">{children}</h3>
      {right}
    </div>
  );
}

type BtnVariant = 'primary' | 'ghost' | 'outline' | 'danger-outline' | 'success-outline';
export function Btn({ variant = 'outline', className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant }) {
  const base = 'inline-flex items-center gap-1.5 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-40 cursor-pointer px-3 py-2';
  const styles: Record<BtnVariant, string> = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400',
    ghost: 'text-slate-500 hover:text-slate-800 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800',
    outline: 'border border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
    'danger-outline': 'border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950',
    'success-outline': 'border border-emerald-300 text-emerald-600 hover:bg-emerald-50 dark:border-emerald-900 dark:text-emerald-400 dark:hover:bg-emerald-950',
  };
  return <button {...props} className={`${base} ${styles[variant]} ${className}`} />;
}

export function IconBtn({ title, onClick, className = '', children }: { title: string; onClick?: () => void; className?: string; children: ReactNode }) {
  return (
    <button title={title} onClick={onClick}
      className={`p-1.5 rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200 cursor-pointer ${className}`}>
      {children}
    </button>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'green' | 'red' | 'blue' | 'amber' | 'purple'; children: ReactNode }) {
  const map: Record<string, string> = {
    neutral: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
    green: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400',
    red: 'bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400',
    blue: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300',
    amber: 'bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-400',
    purple: 'bg-violet-50 text-violet-600 dark:bg-violet-950 dark:text-violet-300',
  };
  return <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${map[tone]}`}>{children}</span>;
}

export function StatusDot({ status }: { status?: string | null }) {
  const s = (status || '').toLowerCase();
  const color = s === 'running' || s === 'enabled' || s === 'active'
    ? 'bg-emerald-500'
    : s === 'error' || s === 'failed' ? 'bg-red-500'
    : s === 'disabled' || s === 'inactive' || s === 'stopped' ? 'bg-slate-400'
    : 'bg-amber-400';
  return <span className={`inline-block size-1.5 rounded-full ${color}`} />;
}

export function TableShell({ head, children, empty, colSpan }: { head: ReactNode; children: ReactNode; empty?: { text: string } | null; colSpan: number }) {
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60">
              {head}
            </tr>
          </thead>
          <tbody>
            {children}
            {empty && (
              <tr><td colSpan={colSpan} className="px-4 py-10 text-center">
                <Inbox size={22} className="mx-auto mb-2 text-slate-300 dark:text-slate-600" />
                <p className="text-sm text-slate-400">{empty.text}</p>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function Th({ children, right, className = '' }: { children: ReactNode; right?: boolean; className?: string }) {
  return <th className={`${right ? 'text-right' : 'text-left'} px-4 py-2.5 font-medium text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 ${className}`}>{children}</th>;
}

export function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`px-4 py-2.5 align-middle ${className}`}>{children}</td>;
}

export function Row({ children }: { children: ReactNode }) {
  return <tr className="border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-slate-800/70 dark:hover:bg-slate-800/40">{children}</tr>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div>
      <label className="block text-[13px] font-medium text-slate-700 dark:text-slate-300 mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-slate-400 mt-1">{hint}</p>}
    </div>
  );
}

export const inputCls = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-500';
export const monoCls = 'font-mono';

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  const { mono, className = '', ...rest } = props;
  return <input {...rest} className={`${inputCls} ${mono ? monoCls : ''} ${className}`} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  const { mono, className = '', ...rest } = props;
  return <textarea {...rest} className={`${inputCls} ${mono ? monoCls : ''} ${className}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', ...rest } = props;
  return <select {...rest} className={`${inputCls} ${className}`} />;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-[2px] flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className={`bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} max-h-[90vh] overflow-y-auto`} onClick={e => e.stopPropagation()}>
        <div className="p-5">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100 mb-4">{title}</h3>
          {children}
        </div>
      </div>
    </div>
  );
}

export function Alert({ tone, children }: { tone: 'red' | 'green' | 'blue' | 'amber'; children: ReactNode }) {
  const map = {
    red: 'bg-red-50 border-red-200 text-red-700 dark:bg-red-950 dark:border-red-900 dark:text-red-300',
    green: 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-950 dark:border-emerald-900 dark:text-emerald-300',
    blue: 'bg-indigo-50 border-indigo-200 text-indigo-700 dark:bg-indigo-950 dark:border-indigo-900 dark:text-indigo-300',
    amber: 'bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-950 dark:border-amber-900 dark:text-amber-300',
  };
  return <div className={`text-xs border rounded-lg px-3 py-2 ${map[tone]}`}>{children}</div>;
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-slate-200 dark:bg-slate-800 ${className}`} />;
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { key: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1 p-1 rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900">
      {options.map(o => (
        <button key={o.key} onClick={() => onChange(o.key)}
          className={`px-3 py-1.5 text-[13px] rounded-md transition-colors cursor-pointer ${value === o.key ? 'bg-indigo-600 text-white dark:bg-indigo-500' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
