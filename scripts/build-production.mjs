import { spawnSync } from 'node:child_process';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const buildEnv = { ...process.env, TODOFLARE_E2E: 'false', VITE_E2E_REPLAY_CONTROL: 'false' };
delete buildEnv.CLOUDFLARE_ENV;
const result = spawnSync('pnpm', ['exec', 'vite', 'build'], {
  stdio: 'inherit', env: buildEnv,
});
if (result.status !== 0) process.exit(result.status ?? 1);
const hashes = {};
for (const root of ['dist/todoflare_prod', 'dist/client']) {
  for (const relative of await readdir(root, { recursive: true })) {
    if (!/\.(js|json|html|css)$/.test(relative)) continue;
    const path = `${root}/${relative}`;
    hashes[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
}
await writeFile('dist/production-build.json', JSON.stringify({ environment: 'production', authBypass: false, hashes }));
