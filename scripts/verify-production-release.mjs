import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { api, captureProductionSnapshot } from './production-snapshot.mjs';
const frozen = !process.argv.includes('--live');
const baseline = JSON.parse(await readFile('.wrangler/production-preflight/snapshot.json', 'utf8'));
assert.equal(baseline.schemaVersion, 1, 'Take a fresh production preflight snapshot');
// A new version reaches the edge gradually: one response in the new write
// mode does not mean the next request reaches it. Wait for several in a row,
// as the staging drill does.
for (let attempt = 0, matched = 0; matched < 5; attempt++) {
 if (attempt === 60) throw new Error('Production write mode did not propagate');
 matched = (await api('/api/clock')).readOnlyMode === frozen ? matched + 1 : 0;
 if (matched < 5) await new Promise(resolve => setTimeout(resolve, matched > 0 ? 500 : 2000));
}
assert.equal((await api('/api/clock')).autoBackupEnabled, true);
await api('/api/account', 'GET', undefined, false, 401);
await api('/api/admin/staging/lose-account', 'POST', {}, true, 404);
await api('/api/auth/legacy/sign-in', 'POST', { accountId: Object.keys(baseline.accounts)[0] }, false, frozen ? 503 : 404);
const after = await captureProductionSnapshot();
assert.deepEqual(Object.keys(after.accounts), Object.keys(baseline.accounts), 'Production account inventory changed');
for (const [id, before] of Object.entries(baseline.accounts)) {
 const current = after.accounts[id];
 for (const field of ['account', 'sharedIndex', 'trash', 'columnIds']) assert.deepEqual(current[field], before[field], 'Production account data changed');
 assert.deepEqual(current.auth.user, before.auth.user, 'Production auth identity changed');
 assert.deepEqual(current.auth.account, before.auth.account, 'Production provider credentials changed');
 // Passkey sign-in stays available during a freeze and can increase counters.
 assert.equal(current.auth.passkey.length, before.auth.passkey.length, 'Production passkey inventory changed');
 for (let i = 0; i < before.auth.passkey.length; i++) {
  const { counter: oldCounter, ...oldKey } = before.auth.passkey[i];
  const { counter: newCounter, ...newKey } = current.auth.passkey[i];
  assert.deepEqual(newKey, oldKey, 'Production passkey changed'); assert(newCounter >= oldCounter, 'Production passkey counter regressed');
 }
 for (const headers of [{ Authorization: `Bearer ${id}` }, { 'X-Account-ID': id }]) {
  const response = await fetch('https://todo.tamesystems.org/api/account', { headers, signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 401, 'Retired Account ID transport still authenticates');
 }
}
assert.deepEqual(Object.keys(after.columns).sort(), Object.keys(baseline.columns).sort(), 'Production document inventory changed');
for (const [id, before] of Object.entries(baseline.columns)) {
 const current = after.columns[id]; assert.deepEqual(current.meta, before.meta, 'Production metadata changed');
 const a = new Y.Doc(); const b = new Y.Doc();
 try {
  if (before.yjs) Y.applyUpdate(a, Uint8Array.from(before.yjs));
  if (current.yjs) Y.applyUpdate(b, Uint8Array.from(current.yjs));
  assert.deepEqual(Y.encodeStateAsUpdate(b), Y.encodeStateAsUpdate(a), 'Production document changed');
 } finally { a.destroy(); b.destroy(); }
}
if (frozen) {
 await api('/api/column', 'POST', {}, false, 503);
 const run = await api('/api/admin/backups/run', 'POST', {});
 assert.equal(run.skipped, false); assert.equal(run.failed, 0); assert.equal(run.invalidAccounts, 0); assert.equal(run.rawCopies, 0);
 assert.equal(run.accountsBackedUp, Object.keys(after.accounts).length); assert.equal(run.backedUp, run.columnsDiscovered);
 const stamp = JSON.parse(await readFile('dist/production-build.json', 'utf8'));
 const independent = JSON.stringify({ ...after, backupRun: run });
 const directory = '/Users/lukasmurdock/Documents/Todoflare Recovery/releases';
 await mkdir(directory, { recursive: true, mode: 0o700 });
 await writeFile(`${directory}/${Date.now()}-verified.json`, independent, { mode: 0o600 });
 const checkpoint = { verified: true, verifiedAt: Date.now(), accountCount: Object.keys(after.accounts).length, columnCount: Object.keys(after.columns).length, buildHashes: stamp.hashes, configHash: stamp.hashes['dist/todoflare_prod/wrangler.json'], workerHash: stamp.hashes['dist/todoflare_prod/index.js'], snapshotSha256: createHash('sha256').update(independent).digest('hex') };
 await writeFile('.wrangler/production-release-checkpoint.json', JSON.stringify(checkpoint, null, 2));
}
console.log({ frozen, accountsPreserved: Object.keys(after.accounts).length, documentsPreserved: Object.keys(after.columns).length, credentialsPreserved: true, legacyLoginRemoved: true, automaticBackupsEnabled: true });
