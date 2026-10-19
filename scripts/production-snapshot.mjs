import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const origin = 'https://todo.tamesystems.org';
const { BACKUP_ADMIN_TOKEN: token } = JSON.parse(await readFile('.wrangler/production-secrets.json', 'utf8'));
export async function api(path, method = 'GET', body, admin = true, expected = 200) {
 const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(30000), headers: { ...(admin ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), Origin: origin }, body: body === undefined ? undefined : JSON.stringify(body) });
 assert.equal(response.status, expected, `Production verification request failed: ${method} ${path} returned ${response.status}, expected ${expected}`);
 return response.status === 200 ? response.json() : null;
}
async function download(key) {
 const payload = await api('/api/admin/backups/download?key=' + encodeURIComponent(key));
 const { checksum, ...base } = payload;
 assert.equal(checksum, createHash('sha256').update(JSON.stringify(base)).digest('hex'), 'Production backup checksum mismatch');
 return payload;
}
export async function captureProductionSnapshot() {
 const inventory = spawnSync('./node_modules/.bin/wrangler', ['kv', 'key', 'list', '--namespace-id', 'b2a26a39720746e2b67d8a07ee1a2d68', '--remote'], { encoding: 'utf8' });
 assert.equal(inventory.status, 0, 'Remote account inventory unavailable');
 const ids = JSON.parse(inventory.stdout).filter(key => /^account:\d{16}$/.test(key.name)).map(key => key.name.slice(8)).sort();
 assert(ids.length > 0, 'Production inventory is unexpectedly empty');
 const accounts = {};
 for (const id of ids) {
  const copy = await api('/api/admin/backups/account', 'POST', { accountId: id });
  assert(copy.success);
  const payload = await download(copy.key); assert.equal(payload.accountId, id);
  accounts[id] = payload;
 }
 const latest = new Map(); let cursor;
 do {
  const page = await api('/api/admin/backups/objects' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
  for (const object of page.objects) if (object.key.startsWith('columns/')) {
   const id = object.key.split('/')[1];
   if (!latest.has(id) || object.key > latest.get(id)) latest.set(id, object.key);
  }
  if (!page.truncated) break;
  assert(page.cursor && page.cursor !== cursor, 'Invalid production backup pagination'); cursor = page.cursor;
 } while (cursor);
 const columns = {};
 for (const id of new Set(Object.values(accounts).flatMap(a => a.columnIds))) {
  assert(latest.has(id), 'Incomplete production recovery inventory');
  const payload = await download(latest.get(id)); assert.equal(payload.columnId, id); columns[id] = payload;
 }
 return { schemaVersion: 1, capturedAt: new Date().toISOString(), accounts, columns };
}
