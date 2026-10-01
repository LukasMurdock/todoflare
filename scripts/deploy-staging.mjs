import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
assert(process.argv.slice(2).every(arg => ['--freeze', '--check'].includes(arg)), 'Unknown staging deploy argument');
const freeze = process.argv.includes('--freeze');
const configPath = 'dist/todoflare_prod/wrangler.json';
const c = JSON.parse(await readFile(configPath, 'utf8'));
assert.equal(c.name, 'todoflare-staging');
assert.equal(c.account_id, '8818a1fbe40a0fdc63ec6ab52cb62e3b');
for (const binding of ['kv_namespaces', 'd1_databases', 'r2_buckets']) assert.equal(c[binding].length, 1);
assert.equal(c.vars.ENVIRONMENT, 'staging');
assert.equal(c.vars.AUTH_ORIGIN, 'https://staging.todo.tamesystems.org');
assert.equal(c.vars.AUTH_RP_ID, 'staging.todo.tamesystems.org');
assert.equal(c.kv_namespaces[0].id, '000084374c0d46949985ce0331cd67bd');
assert.equal(c.d1_databases[0].database_id, 'b978ef4f-261e-45ba-bba0-c008136e51ef');
assert.equal(c.r2_buckets[0].bucket_name, 'todoflare-backups-staging');
assert.deepEqual(c.routes, [{ pattern: 'staging.todo.tamesystems.org', custom_domain: true }]);
assert(!c.vars.AUTH_TEST_BYPASS && !c.vars.RATE_LIMIT_DISABLED);
assert(c.durable_objects.bindings.every(b => !b.script_name));
// Require our production-mode staging build provenance, written after a fresh build.
const stamp = JSON.parse(await readFile('dist/staging-build.json', 'utf8'));
assert.equal(stamp.environment, 'staging');
assert.equal(stamp.authBypass, false);
assert(Object.keys(stamp.hashes).includes(configPath));
for (const [path, hash] of Object.entries(stamp.hashes)) {
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), hash, `Stale staging build: ${path}`);
}
if (process.argv.includes('--check')) {
  console.log('Staging build, authentication mode and resource isolation verified.');
  process.exit(0);
}
console.log(`Deploying isolated staging (${freeze ? 'frozen' : 'writable'}).`);
const result = spawnSync('pnpm', ['exec', 'wrangler', 'deploy', '--config', configPath, '--var', `READ_ONLY_MODE:${freeze}`], { stdio: 'inherit' });
process.exit(result.status ?? 1);
