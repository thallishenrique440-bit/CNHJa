// STUB P-1.10 — substitui o SDK real durante o teste do webhook.
// Nunca abre conexao. Delega para o duplo publicado pelo teste em globalThis.__P110_DB__.
export function createClient(url, _key) {
  const created = globalThis.__P110_CLIENTS__;
  if (created) created.push(String(url));
  return new Proxy({}, {
    get(_t, prop) {
      const db = globalThis.__P110_DB__;
      if (!db) throw new Error('P-1.10 GUARD: uso do client antes de o duplo ser publicado.');
      const v = db[prop];
      return typeof v === 'function' ? v.bind(db) : v;
    }
  });
}
export class SupabaseClient {}
