# iGetJobs

Personal workspace for finding local businesses that need website work.

**Phase 0 only:** React/TypeScript shell, Node API, Supabase connection setup, shared lead contracts, and local tooling. Search, ingestion, auth screens, lead persistence, audits, scoring, management, and outreach are not implemented. Routes are foundation previews, without sample leads or invented scores.

## Local setup

Use Node.js 22.13+ within the Node 22 line (recommended), or Node 24+, and npm 10+.

From the repository root:

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173. The API runs at http://127.0.0.1:3001/api/health.
The shell works with no environment files. Both processes stop when you press Ctrl+C.

Optional configuration in PowerShell:

```powershell
Copy-Item apps/web/.env.example apps/web/.env
Copy-Item apps/api/.env.example apps/api/.env
```

On macOS/Linux use `cp` in place of `Copy-Item`. Edit the copied files locally, then restart the dev processes.

## Supabase setup

Use a Supabase free project (or an existing local Supabase instance). No paid service is needed for Phase 0.

From the project's connection/API settings, copy its URL and **publishable key** (legacy **anon** keys also work).

| File | Variables |
| --- | --- |
| `apps/web/.env` | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` |
| `apps/api/.env` | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` |

Set each pair together or leave both empty. URL configuration must use HTTP(S).
The browser validates public key format at startup and before builds, refusing secret/service-role keys.
The backend client has session persistence and token refresh disabled and supports a future per-request user access token. It uses a public key and does not require an admin key.

**Configured does not mean connected:** `/api/health` checks API availability and whether a client was created; it does not query Supabase. Settings reports configuration only. Live auth/database verification requires project credentials and later phase integration.

No database tables or migrations are created in Phase 0. Before persisting leads in Phase 1, add an owner column and enable user-scoped row-level security. Never expose unauthenticated lead data. Full sign-in behavior requires approval as part of a later phase; `/login` currently shows a placeholder.

Never place private keys in the web environment or prefix them with `VITE_`. API-only provider credentials belong in `apps/api/.env` when their adapters are implemented later. No environment file with secrets should be committed. The only tracked env files are empty `.env.example` templates.

## Structure

```text
apps/web/           Vite + React + TypeScript, browser Supabase client
apps/api/           Express + TypeScript, API env and server Supabase client
packages/shared/    Lead, audit, score, outreach and API contracts
tests/              Environment, Supabase construction and API foundation checks
```

Routes: `/`, `/search`, `/leads`, `/leads/:leadId`, `/outreach`, `/settings`, `/login`, and a not-found fallback. Feature routes are placeholders only. The shell is deliberately unprotected until auth is implemented and exposes no lead data.

Lead fields follow SPEC.md. Missing contact/location/source values are null; audits, classification, scores, and drafts stay null until performed. Unknown audit results have an explicit unknown outcome. Preserve source/sourceId and additional provenance during later deduplication. Score bounds, normalization, priority thresholds, and persistence validation belong to their approved implementation phases.

## Checks and build

```sh
npm run lint
npm run typecheck
npm test
npm run build
# Or run everything:
npm run check
```

Build order is shared contracts → API → web. Shared contracts are built before dev/typecheck/tests.
Outputs are `packages/shared/dist`, `apps/api/dist`, and `apps/web/dist`.

To smoke-test production outputs in two terminals after building:

```sh
npm run start -w @igetjobs/api
npm run preview -w @igetjobs/web
```

Preview serves the web on port 4173. Vite preview uses the same local API proxy.
For a future real deployment, configure a reverse proxy for `/api` and SPA fallback to `index.html` for frontend routes. Deployment is Phase 5.

API env defaults: `HOST=127.0.0.1`, `PORT=3001`. If you change PORT, set `API_PROXY_TARGET=http://127.0.0.1:<port>` in the web env. Browser API requests stay same-origin; no permissive CORS is necessary.

## Phase workflow

Read SPEC.md, DESIGN.md, AGENTS.md, PLAN.md, and PROJECT_STATE.md. Implement only the approved phase. At each completed phase: run checks, review scope, update PROJECT_STATE.md, commit the phase separately with a clear message, push to GitHub, and stop for review before the next phase.

React, Node.js, Supabase, free-tier compatibility. No Next.js, MongoDB, AI, paid dependency, V2 features, or automatic outreach.

Reference docs: [Vite](https://vite.dev/guide/), [Supabase client setup](https://supabase.com/docs/reference/javascript/initializing), [Express](https://expressjs.com/en/starter/installing/).
