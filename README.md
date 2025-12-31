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

## Configuration

### `wrangler.jsonc`

-   `name`: Worker name (used in deploy URL)
-   `main`: Worker entry point
-   `assets.not_found_handling`: Set to `single-page-application` for client-side routing
-   `assets.run_worker_first`: Routes that hit the Worker before static assets (e.g., `/api/*`)

### Adding API Routes

Add routes in `src/index.tsx`:

```ts
app.get("/api/example", (c) => {
	return c.json({ message: "Hello" });
});
```

### Adding Bindings

Configure KV, D1, R2, or other Cloudflare bindings in `wrangler.jsonc`:

```jsonc
{
	"kv_namespaces": [{ "binding": "MY_KV", "id": "xxx" }]
}
```

Access in your Worker:

```ts
app.get("/api/data", (c) => {
	const value = await c.env.MY_KV.get("key");
	return c.json({ value });
});
```
