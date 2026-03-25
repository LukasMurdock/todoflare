# Todoflare

A focused todo app. No account. Autosaves to your browser.

## Stack

-   **Frontend**: React 19, Tailwind CSS, Plate.js (rich text editor), dnd-kit (drag and drop)
-   **Backend**: Hono (API routes)
-   **Deployment**: Cloudflare Workers with Static Assets
-   **Build**: Vite with `@cloudflare/vite-plugin`

## Development

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

The app runs at `http://localhost:5173` with hot module replacement. The dev server uses Cloudflare's `workerd` runtime, matching production behavior.

## Building

Build for production:

```bash
npm run build
```

Output is written to `dist/`:

-   `dist/client/` - Static assets (HTML, CSS, JS)
-   `dist/todoflare/` - Worker code and `wrangler.json`

## Preview

Preview the production build locally:

```bash
npm run preview
```

This runs the built app in the Workers runtime before deploying.

## Deployment

Deploy to Cloudflare Workers:

```bash
npm run deploy
```

This builds and deploys to `https://todoflare.<your-subdomain>.workers.dev`.

You'll be prompted to log in to Cloudflare on first deploy.

## Project Structure

```
├── index.html          # SPA entry point
├── wrangler.jsonc      # Cloudflare Worker configuration
├── vite.config.ts      # Vite configuration
├── src/
│   ├── client.tsx      # React app entry
│   ├── index.tsx       # Hono API worker entry
│   ├── components/     # React components
│   ├── hooks/          # React hooks
│   └── styles/         # CSS
└── dist/               # Build output
```

## Recovery Runbook

The app supports emergency read-only mode and admin backup/restore endpoints.
Local-only users also keep hourly rolling checkpoints in browser storage
(`todoflare-backup-YYYYMMDDHH`) with automatic compaction.

Authenticated users can self-serve export/import from the account menu
(`Export Data` and `Import Data`).

### 1) Enable read-only mode (freeze writes)

Set `READ_ONLY_MODE=true` in your deployed Worker vars, then redeploy.

`GET /api/clock` returns `readOnlyMode` so you can verify state.

### 2) Configure backup auth secret

Set an admin token as a Worker secret:

```bash
wrangler secret put BACKUP_ADMIN_TOKEN
```

The Worker uses the `BACKUPS` R2 binding from `wrangler.jsonc`.

### 2.5) Enable automatic scheduled backups

Set these Worker vars and deploy:

- `AUTO_BACKUP_ENABLED=true`
- `BACKUP_MAX_COLUMNS=1000` (or lower for conservative runs)

Cron is configured in `wrangler.jsonc` as hourly (`0 * * * *`).

### 3) Create and list snapshots

```bash
BACKUP_API_ORIGIN="https://todoflare.<subdomain>.workers.dev" \
BACKUP_ADMIN_TOKEN="<token>" \
npm run backup:create -- <columnId>

BACKUP_API_ORIGIN="https://todoflare.<subdomain>.workers.dev" \
BACKUP_ADMIN_TOKEN="<token>" \
npm run backup:list -- <columnId>
```

### 4) Restore a snapshot

Restore latest snapshot for a column:

```bash
BACKUP_API_ORIGIN="https://todoflare.<subdomain>.workers.dev" \
BACKUP_ADMIN_TOKEN="<token>" \
npm run backup:restore -- <columnId>
```

By default this performs a safe `clone` restore (creates a new column).

Restore a specific snapshot key:

```bash
BACKUP_API_ORIGIN="https://todoflare.<subdomain>.workers.dev" \
BACKUP_ADMIN_TOKEN="<token>" \
npm run backup:restore -- <columnId> "columns/<columnId>/<timestamp>.json"
```

In-place restore (dangerous, takes a pre-restore snapshot first):

```bash
BACKUP_API_ORIGIN="https://todoflare.<subdomain>.workers.dev" \
BACKUP_ADMIN_TOKEN="<token>" \
npm run backup:restore -- <columnId> in_place
```

Scheduled backup runs log an event named `scheduled_backup_run` with counts.

Restore all owned columns for an account from latest backups:

```bash
BACKUP_API_ORIGIN="https://todoflare.<subdomain>.workers.dev" \
BACKUP_ADMIN_TOKEN="<token>" \
npm run backup:restore-account -- <accountId>
```
