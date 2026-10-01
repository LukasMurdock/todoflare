import { readFile } from 'node:fs/promises';
const environment = process.argv[2] ?? 'production';
if (!['production', 'staging'].includes(environment)) throw new Error('Expected production or staging');
const origin = environment === 'production' ? 'https://todo.tamesystems.org' : 'https://staging.todo.tamesystems.org';
const secrets = JSON.parse(await readFile(`.wrangler/${environment}-secrets.json`, 'utf8'));
const response = await fetch(origin + '/api/admin/backups/status', { headers: { Authorization: `Bearer ${secrets.BACKUP_ADMIN_TOKEN}` }, signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error(`Backup health unavailable (${response.status})`);
const status = await response.json();
const last = status.lastRun;
const unhealthy = !status.automaticBackupsEnabled || !last || last.skipped || !Number.isFinite(last.completedAt) || Date.now() - last.completedAt > 2 * 60 * 60 * 1000 || last.failed > 0 || last.rawCopies > 0 || last.invalidAccounts > 0 || last.backedUp !== last.columnsSelected;
if (unhealthy) { console.error('Backup health requires attention:', { automaticBackupsEnabled: status.automaticBackupsEnabled, completedAt: last?.completedAt, failed: last?.failed, rawCopies: last?.rawCopies, invalidAccounts: last?.invalidAccounts }); process.exit(1); }
console.log('Backup health is current; selected documents copied successfully.');
