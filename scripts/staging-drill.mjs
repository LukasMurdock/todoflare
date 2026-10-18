import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import * as Y from 'yjs';
const origin = 'https://staging.todo.tamesystems.org';
const { BACKUP_ADMIN_TOKEN: token } = JSON.parse(await readFile('.wrangler/staging-secrets.json', 'utf8'));
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const results = [];
// A full backup run grows with staging's synthetic accounts (82 columns took 205s).
const SCHEDULED_RUN_TIMEOUT_MS = 300_000;
async function api(path, method = 'GET', data, admin = false, expected = 200) {
  const response = await context.request.fetch(`${origin}${path}`, {
    method, data, timeout: path === '/api/admin/staging/scheduled' ? SCHEDULED_RUN_TIMEOUT_MS : 30000,
    headers: admin ? { Authorization: `Bearer ${token}` } : {},
  }).catch(error => { throw new Error(`${method} ${path} failed (${error.name}); request headers withheld`); });
  assert.equal(response.status(), expected, `${method} ${path}: ${await response.text()}`);
  return response.status() === 200 ? response.json() : null;
}
async function deploy(freeze) {
  const output = await new Promise((resolve, reject) => {
    const child = spawn('node', ['scripts/deploy-staging.mjs', ...(freeze ? ['--freeze'] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
    child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`Staging deploy failed: ${errors}`)));
  });
  await waitForWriteMode(freeze);
  return output.match(/Current Version ID: ([0-9a-f-]{36})/)?.[1];
}
// A successful upload precedes propagation, and for a while requests can reach
// isolates on either version. One matching response is not enough; do not
// continue until several consecutive requests report the requested write mode.
async function waitForWriteMode(freeze, consecutive = 5) {
  let matched = 0;
  for (let attempt = 0; attempt < 60; attempt++) {
    matched = (await api('/api/clock')).readOnlyMode === freeze ? matched + 1 : 0;
    if (matched >= consecutive) return;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`Staging write mode ${freeze ? 'frozen' : 'writable'} did not settle within 120 seconds`);
}
async function registerPasskey() {
    const encode = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), c => c.charCodeAt(0)).buffer;
    async function request(path, method = 'GET', data) {
      const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return res.json();
    }
    const provisional = await request('/api/auth/sign-in/anonymous', 'POST', {});
    const options = await request('/api/auth/passkey/generate-register-options?name=Staging%20drill');
    const credential = await navigator.credentials.create({ publicKey: { ...options, challenge: decode(options.challenge), user: { ...options.user, id: decode(options.user.id) }, excludeCredentials: options.excludeCredentials?.map(c => ({ ...c, id: decode(c.id) })) } });
    await request('/api/auth/passkey/verify-registration', 'POST', { name: 'Staging drill', response: { id: credential.id, rawId: encode(credential.rawId), type: credential.type, authenticatorAttachment: credential.authenticatorAttachment, response: { clientDataJSON: encode(credential.response.clientDataJSON), attestationObject: encode(credential.response.attestationObject), transports: credential.response.getTransports?.() ?? [] }, clientExtensionResults: credential.getClientExtensionResults() } });
    await request('/api/account', 'POST');
    return provisional.user.id;
}
try {
  const clock = await api('/api/clock');
  assert.equal(clock.readOnlyMode, false);
  assert.equal(clock.autoBackupEnabled, true);
  await api('/api/account', 'GET', undefined, false, 401);
  const bypass = await context.request.get(`${origin}/api/account`, { headers: { 'X-Todoflare-Test-Account': '1234567890123456' } });
  assert.equal(bypass.status(), 401);
  await api('/api/admin/staging/scheduled', 'POST', {}, false, 401);
  results.push('anonymous access, test auth bypass, and unauthenticated drill controls rejected');
  // Staging keeps production rate limits; repeated drills would otherwise exhaust
  // this workstation's hourly account-creation allowance.
  await api('/api/admin/staging/reset-rate-limits', 'POST', {}, false, 401);
  await api('/api/admin/staging/reset-rate-limits', 'POST', {}, true);
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.addInitScript(() => localStorage.setItem('todoflare-columns', JSON.stringify([{ id: 'staging-guest', value: [{ type: 'p', children: [{ text: 'Synthetic recovery draft' }] }] }])));
  await page.goto(origin);
  const accountId = await page.evaluate(registerPasskey);
  await api('/api/admin/staging/mark-drill', 'POST', {}, true);
  // Import a synthetic valid Yjs document using the supported account import API.
  const account = (await api('/api/account')).account;
  const doc = new Y.Doc(); doc.getText('staging-recovery').insert(0, 'Recover this synthetic content exactly');
  const seedId = crypto.randomUUID();
  await api('/api/account/import', 'POST', { schemaVersion: 2, exportedAt: Date.now(), complete: true, expectedColumnIds: [seedId], account: { ...account, columnOrder: [seedId] }, ownedColumns: [{ meta: { schemaVersion: 1, id: seedId, ownerId: accountId, sharedWith: [], publicId: null, createdAt: Date.now() }, yjs: Array.from(Y.encodeStateAsUpdate(doc)) }] });
  doc.destroy();
  const seeded = await api('/api/account/export');
  assert.equal(seeded.ownedColumns.length, 1);
  const columnId = seeded.ownedColumns[0].meta.id;
  const publicLink = await api(`/api/column/${columnId}/public`, 'POST', {});
  const collaboratorContext = await browser.newContext();
  const collaboratorPage = await collaboratorContext.newPage();
  const collaboratorCdp = await collaboratorContext.newCDPSession(collaboratorPage);
  await collaboratorCdp.send('WebAuthn.enable');
  await collaboratorCdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await collaboratorPage.addInitScript(() => localStorage.setItem('todoflare-columns', JSON.stringify([{ id: 'collaborator-guest', value: [{ type: 'p', children: [{ text: 'Synthetic collaborator' }] }] }])));
  await collaboratorPage.goto(origin);
  const collaboratorId = await collaboratorPage.evaluate(registerPasskey);
  await api(`/api/column/${columnId}/share`, 'POST', { targetAccountId: collaboratorId });
  const collaboratorBefore = await (await collaboratorContext.request.get(`${origin}/api/account`)).json();
  assert.equal(collaboratorBefore.sharedColumns[0].id, columnId);
  const extra = await api('/api/column', 'POST', {});
  await api(`/api/column/${extra.column.id}`, 'DELETE');
  const before = await api('/api/account');
  const exportedBefore = await api('/api/account/export');
  const snapshot = await api('/api/admin/backups/account', 'POST', { accountId }, true);
  assert.equal(snapshot.columnIds.length, 2);
  await api('/api/admin/backups/account/restore', 'POST', { accountId, key: snapshot.key }, true, 409);
  await api('/api/admin/staging/lose-account', 'POST', { accountId, key: snapshot.key }, true, 409);
  results.push('real passkey registration, synthetic content, public link, trash, full account backup, and writable-mode restore rejection passed');
  await api('/api/admin/staging/scheduled', 'POST', {}, true);
  const scheduledBefore = await api('/api/admin/backups/status', 'GET', undefined, true);
  assert(scheduledBefore.lastRun);
  results.push('actual scheduled handler completed and persisted backup status');
  console.log('Staging recovery drill: freezing writes.');
  const frozenVersion = await deploy(true);
  assert(frozenVersion);
  await api('/api/column', 'POST', {}, false, 503);
  for (const path of ['sign-in/anonymous', 'passkey/verify-registration', 'passkey/delete-passkey', 'recovery-code/generate', 'recovery-code/recover']) {
    await api(`/api/auth/${path}`, 'POST', {}, false, 503);
  }
  const frozenRun = await api('/api/admin/staging/scheduled', 'POST', {}, true);
  assert.equal(frozenRun.frozen, true, 'Scheduled run reached a writable isolate after the freeze settled');
  const scheduledFrozen = await api('/api/admin/backups/status', 'GET', undefined, true);
  assert.deepEqual(scheduledFrozen, scheduledBefore);
  await api('/api/admin/staging/lose-account', 'POST', { accountId, key: snapshot.key }, true);
  await api('/api/account', 'GET', undefined, false, 401);
  results.push('write, credential, and cron freezes verified; synthetic roots and auth credentials deleted; old session rejected');
  const restored = await api('/api/admin/backups/account/restore', 'POST', { accountId, key: snapshot.key }, true);
  assert.equal(restored.success, true);
  assert.equal(restored.restoredColumns.length, 2);
  // Existing sessions are intentionally invalidated. Use the original passkey.
  await context.clearCookies();
  await page.reload();
  await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/api/auth/passkey/verify-authentication') && r.status() === 200),
    page.getByRole('button', { name: 'Sign in with a passkey' }).click(),
  ]);
  const after = await api('/api/account');
  assert.deepEqual(after.account, before.account);
  assert.deepEqual(after.deletedColumns, before.deletedColumns);
  assert.deepEqual(after.ownedColumns, before.ownedColumns);
  const exportedAfter = await api('/api/account/export');
  assert.deepEqual(exportedAfter.ownedColumns.map(c => c.meta), exportedBefore.ownedColumns.map(c => c.meta));
  for (const column of exportedAfter.ownedColumns) {
    const copy = new Y.Doc(); Y.applyUpdate(copy, Uint8Array.from(column.yjs));
    assert.equal(copy.getText('staging-recovery').toString(), 'Recover this synthetic content exactly'); copy.destroy();
  }
  await api(`/api/p/${publicLink.publicId}`);
  const collaboratorAfter = await (await collaboratorContext.request.get(`${origin}/api/account`)).json();
  assert.deepEqual(collaboratorAfter, collaboratorBefore);
  results.push('original passkey signed in after recovery; account order, metadata, content, trash timestamps, collaborator access, and public link recovered');
  console.log('Staging recovery drill: thawing writes.');
  await deploy(false);
  // Park both browsers so the app cannot open the next column in its editor and
  // write to it between the rollback snapshots. Requests keep their sessions.
  await Promise.all([page.goto('about:blank'), collaboratorPage.goto('about:blank')]);
  await api('/api/column', 'POST', {});
  results.push('writes resumed after thaw');
  const rollbackData = await api('/api/account/export');
  console.log('Staging recovery drill: rehearsing rollback to the frozen release.');
  await new Promise((resolve, reject) => {
    const child = spawn('./node_modules/.bin/wrangler', ['versions', 'deploy', `${frozenVersion}@100`, '--name', 'todoflare-staging', '--yes'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Staging rollback failed: ${errors}`)));
  });
  await waitForWriteMode(true);
  const rolledBackData = await api('/api/account/export');
  assert.deepEqual(rolledBackData.account, rollbackData.account);
  assert.deepEqual(rolledBackData.ownedColumns, rollbackData.ownedColumns);
  await deploy(false);
  results.push('Cloudflare version rollback restored the write freeze and preserved data written after that version was created; staging thawed again');
  const report = { origin, completedAt: new Date().toISOString(), results, productionChanged: false, limitations: ['Remote drill deletes account roots and auth rows; documents remain and are reimported from verified backups. Complete document loss and corruption are covered by local Worker tests.', 'Production credential migration is complete; Account IDs cannot authenticate.'] };
  await writeFile('.wrangler/staging-drill-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
