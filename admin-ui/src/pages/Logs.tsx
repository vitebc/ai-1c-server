import { RefreshCw } from 'lucide-react';

export default function Logs() {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-800">Logs</h2>
        <button className="flex items-center gap-2 px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
          <RefreshCw size={16} /> Refresh
        </button>
      </div>
      <div className="bg-gray-900 text-green-400 font-mono text-xs p-4 rounded-xl border border-gray-200 min-h-[300px]">
        <p className="text-gray-500 italic">Server logs will appear here</p>
      </div>
    </div>
  );
}
