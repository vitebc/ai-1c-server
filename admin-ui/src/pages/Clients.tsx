import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Client } from '../types';

export default function Clients() {
  const [items, setItems] = useState<Client[]>([]);

  useEffect(() => { api.getClients().then(setItems); }, []);

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-800 mb-6">Clients</h2>
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="text-left px-4 py-3 font-medium text-gray-600">ID</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Name</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Version</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Last Seen</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-xs text-gray-600">{item.id}</td>
                <td className="px-4 py-3 font-medium text-gray-800">{item.name || '-'}</td>
                <td className="px-4 py-3 text-gray-600">{item.version || '-'}</td>
                <td className="px-4 py-3 text-gray-600 text-xs">{item.last_seen || '-'}</td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">No clients registered</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
