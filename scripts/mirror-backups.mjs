import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const environment = process.argv[2] ?? 'production';
assert(['production', 'staging'].includes(environment));
const origin = environment === 'production' ? 'https://todo.tamesystems.org' : 'https://staging.todo.tamesystems.org';
const secrets = JSON.parse(await readFile(`.wrangler/${environment}-secrets.json`, 'utf8'));
const destination = `/Users/lukasmurdock/Documents/Todoflare Recovery/${environment}`;
const headers = { Authorization: `Bearer ${secrets.BACKUP_ADMIN_TOKEN}` };
async function get(route) {
 const response = await fetch(origin + route, { headers, signal: AbortSignal.timeout(30000) });
 assert.equal(response.status, 200, 'Private backup export unavailable');
 return response;
}
const latest = new Map(); let cursor;
do {
 const route = new URL('/api/admin/backups/objects', origin); if (cursor) route.searchParams.set('cursor', cursor);
 const page = await (await get(route.pathname + route.search)).json();
 for (const object of page.objects) {
  const match = /^(accounts\/\d{16}|columns\/[A-Za-z0-9_-]{1,128})\/(\d{13}(?:-[A-Za-z0-9-]+)?\.json)$/.exec(object.key);
  if (match && (!latest.has(match[1]) || object.key > latest.get(match[1]))) latest.set(match[1], object.key);
 }
 if (!page.truncated) break;
 assert(page.cursor && page.cursor !== cursor, 'Invalid backup pagination'); cursor = page.cursor;
} while (cursor);
assert(latest.size > 0, 'No usable private backups discovered');
let copied = 0; const payloads = new Map();
function verify(text) {
 const payload = JSON.parse(text); const { checksum, ...base } = payload;
 assert.equal(checksum, createHash('sha256').update(JSON.stringify(base)).digest('hex'), 'Independent backup checksum mismatch');
 return payload;
}
await mkdir(destination, { recursive: true, mode: 0o700 });
for (const [group, key] of latest) {
 const file = path.join(destination, key);
 let payload;
 try { payload = verify(await readFile(file, 'utf8')); }
 catch {
  const route = new URL('/api/admin/backups/download', origin); route.searchParams.set('key', key);
  const text = await (await get(route.pathname + route.search)).text(); payload = verify(text);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, text, { mode: 0o600 }); copied++;
 }
 assert(payload.schemaVersion === 1, 'Unsupported independent backup schema');
 assert((group.startsWith('accounts/') ? payload.accountId : payload.columnId) === group.split('/')[1], 'Independent backup identity mismatch');
 await chmod(file, 0o600); payloads.set(group, payload);
}
for (const [group, payload] of payloads) if (group.startsWith('accounts/')) {
 for (const id of payload.columnIds) assert(payloads.has(`columns/${id}`), 'Independent account recovery inventory is incomplete');
}
await writeFile(path.join(destination, 'mirror-status.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), copied, snapshots: latest.size, accounts: [...latest.keys()].filter(key => key.startsWith('accounts/')).length }), { mode: 0o600 });
console.log(`Verified ${latest.size} independent backup snapshots; copied ${copied} new snapshots.`);
