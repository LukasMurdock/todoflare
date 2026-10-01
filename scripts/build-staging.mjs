import { spawnSync } from 'node:child_process';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const result = spawnSync('pnpm', ['exec', 'vite', 'build'], {
  stdio: 'inherit', env: { ...process.env, CLOUDFLARE_ENV: 'staging', TODOFLARE_E2E: 'false', VITE_E2E_REPLAY_CONTROL: 'false' },
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
await writeFile('dist/staging-build.json', JSON.stringify({ environment: 'staging', authBypass: false, hashes }));
