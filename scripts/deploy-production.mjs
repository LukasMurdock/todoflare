import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
assert(process.argv.slice(2).every(arg => ['--freeze', '--check'].includes(arg)), 'Unknown production deploy argument');
const freeze = process.argv.includes('--freeze');
const configPath = 'dist/todoflare_prod/wrangler.json';
const c = JSON.parse(await readFile(configPath, 'utf8'));
assert.equal(c.name, 'todoflare-prod');
assert.equal(c.account_id, '8818a1fbe40a0fdc63ec6ab52cb62e3b');
for (const binding of ['kv_namespaces', 'd1_databases', 'r2_buckets']) assert.equal(c[binding].length, 1);
assert.equal(c.vars.ENVIRONMENT, 'production');
assert.equal(c.vars.AUTH_ORIGIN, 'https://todo.tamesystems.org');
assert.equal(c.vars.AUTH_RP_ID, 'todo.tamesystems.org');
assert.equal(c.kv_namespaces[0].id, 'b2a26a39720746e2b67d8a07ee1a2d68');
assert.equal(c.d1_databases[0].database_id, '6314b61f-579a-474b-88dc-df715faff5fc');
assert.equal(c.r2_buckets[0].bucket_name, 'todoflare-backups');
assert.deepEqual(c.routes, [{ pattern: 'todo.tamesystems.org', custom_domain: true }]);
assert.equal(c.vars.AUTO_BACKUP_ENABLED, 'true');
assert(!c.vars.LEGACY_ACCOUNT_MIGRATION_ENABLED);
const workerSource = await readFile('dist/todoflare_prod/index.js', 'utf8');
assert(!workerSource.includes('/api/admin/staging/'));
assert(!c.vars.AUTH_TEST_BYPASS && !c.vars.RATE_LIMIT_DISABLED);
assert(c.durable_objects.bindings.every(b => !b.script_name));
// Require our production-mode production build provenance, written after a fresh build.
const stamp = JSON.parse(await readFile('dist/production-build.json', 'utf8'));
assert.equal(stamp.environment, 'production');
assert.equal(stamp.authBypass, false);
assert(Object.keys(stamp.hashes).includes(configPath));
for (const [path, hash] of Object.entries(stamp.hashes)) {
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), hash, `Stale production build: ${path}`);
}
if (process.argv.includes('--check')) {
  console.log('Production build, authentication mode and resource isolation verified.');
  process.exit(0);
}
if (!freeze) {
 const checkpoint = JSON.parse(await readFile('.wrangler/production-release-checkpoint.json', 'utf8'));
 assert.equal(checkpoint.verified, true);
 assert.deepEqual(checkpoint.buildHashes, stamp.hashes, 'Verified build artifacts changed');
 assert.equal(checkpoint.configHash, stamp.hashes[configPath]);
 assert.equal(checkpoint.workerHash, stamp.hashes['dist/todoflare_prod/index.js']);
 assert(Date.now() - checkpoint.verifiedAt < 60 * 60 * 1000, 'Production verification is stale');
}
console.log(`Deploying production (${freeze ? 'frozen' : 'writable'}).`);
const result = spawnSync('pnpm', ['exec', 'wrangler', 'deploy', '--config', configPath, '--var', `READ_ONLY_MODE:${freeze}`], { stdio: 'inherit' });
process.exit(result.status ?? 1);
