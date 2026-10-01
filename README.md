# iGetJobs

Personal workspace for finding local businesses that need website work.

**Phase 1 implemented:** authenticated discovery, CSV previews, conservative duplicate review, and Supabase lead persistence. Phase 2 website auditing and scoring have not started. Leads remain unclassified and unscored until measurable checks are performed.

## Local setup

Use Node.js 22.13+ within the Node 22 line, or Node 24+, and npm 10+.

```sh
npm ci
# Copy .env.example to .env and fill the public Supabase configuration locally.
npm run dev
```

PowerShell: `Copy-Item .env.example .env`. On macOS/Linux: `cp .env.example .env`. Never overwrite an existing configured env file. Restart development processes after environment changes.

Open http://127.0.0.1:5173. The API listens on http://127.0.0.1:3001. Without Supabase configuration, login explains the missing setup and protected routes remain inaccessible. Stop both processes with Ctrl+C.

## Supabase and authentication

Use a Supabase free project. Configure its URL and **publishable key** (legacy **anon** keys also work).

| File | Variables |
| --- | --- |
| Root `.env` | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` or `VITE_SUPABASE_PUBLISHABLE_KEY` |
| Optional `apps/web/.env` | Same public browser variables |
| Optional `apps/api/.env` | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` or `SUPABASE_ANON_KEY` |

The ANON_KEY alias accepts publishable and legacy anon formats. If both key aliases are present, their values must agree. Vite loads root values, then web workspace values, then process variables. The API loads root and API env files without overriding existing process variables; a server-specific pair takes precedence and must be complete. Each URL/key pair is optional together, and malformed configuration fails without echoing values.

Only the validated public URL/key enter the browser bundle. Provider keys, test account credentials, and database credentials are excluded even when present in the root env. Public keys are required for the Supabase browser SDK; authenticated tokens and RLS authorize data access. Secret/service-role keys are rejected by both app clients. The backend creates separate user-token clients, disables session persistence/refresh, and bounds Supabase requests to 15 seconds. No admin key is required.

Run `supabase/migrations/202610010001_auth_and_leads.sql` once through the project owner's SQL Editor or your migration tooling. It is transactional and deliberately fails if its tables already exist, rather than modifying an unknown schema. **The current project migration has already been applied; do not rerun it.**

The migration creates V1 `leads` and `user_settings`, owner defaults referencing Auth users, enabled/forced owner-only RLS for all CRUD, no anonymous table grants, timestamps, constraints, and non-unique comparison indexes. Shared domains/phones can represent different branches. Credentials are not stored in these tables.

Use a confirmed email/password account at `/login`. All workspace routes require an Auth-verified session, including restored sessions. The top bar signs out locally. The Node API independently verifies every protected bearer token with Supabase Auth and uses that token for database operations. `/api/health` reports API availability/configuration only; it does not prove a live database connection.

## Discovery workflow

1. Open Search; choose country, city (add state/region when ambiguous), niche, and source.
2. Find leads or upload a CSV to create a preview. Nothing is saved automatically.
3. Review location, contact information, source notes, and duplicate evidence. A missing source website is not an audit or a classification.
4. Select up to 50 results and save. Failures are reported per row; retrying the same preview does not repeat completed saves. Owner-scoped lookup by the server-created preview lead ID also reconciles an insert that committed before its response was lost; retry returns the existing lead without overwriting it.
5. Open Saved leads to reload the latest 100 records from Supabase. This read view verifies collection; lead management, filters, detail views, auditing, and outreach remain later phases.

Each source has an isolated adapter. Normalization trims text, normalizes domains/HTTP(S) URLs, validates E.164 phones using the country, normalizes email/country, and bounds ratings/review counts. Invalid contacts become null with visible warnings, while original source fields remain in provenance. Source/sourceId, raw OSM tags, SerpAPI record fields, and CSV columns/row numbers are retained, subject to credential sanitization. Website/social and metadata URLs share sanitization: userinfo is rejected in canonical contacts, metadata userinfo is stripped, fragments and unknown query parameters are removed. Only bounded `page` numbers and validated `lang`/`locale` selectors survive because they select pagination or language without accepting arbitrary secret values. Credential-shaped metadata fields are removed. Oversized metadata records are skipped with a source note.

Duplicate evidence checks domain, phone, then normalized business name + address; source identifiers provide additional evidence. A shared domain or phone alone is uncertain. Conflicting details and multiple matches require review. Duplicates default to Skip. An exact, single saved match can receive source metadata only after the user chooses it; existing business/contact fields are preserved. The user may explicitly keep a reviewed match separately. No uncertain records are silently merged.

Previews are held on the server for 30 minutes, tied to the verified owner, with at most five previews per user and bounded total memory. Saving accepts preview IDs/selections rather than arbitrary browser-submitted leads, owner IDs, scores, or source metadata. Reloading the API or losing a preview requires a fresh search/import; saved Supabase leads remain persisted.

### CSV format

Use a UTF-8 CSV with exactly one business-name header: `businessName`, `name`, or `title`. Download the header-only template from Search. BOMs, quoted commas, and quoted multiline fields work. Headers must be unique; malformed CSV fails clearly.

Optional mapped columns: `niche`, `country`, `city`, `address`, `phone`, `website` (or `domain`), `email`, `facebook`, `instagram`, `linkedin`, `twitter`, `rating`, `reviewCount` (or `reviews`). Header matching ignores case, spaces, hyphens, and underscores. Country/city/niche form defaults fill missing values. Country aliases include UK/USA and the four starter country names. All extra columns are retained as metadata, excluding credential-shaped fields. Stable source identifiers use a file-content hash plus row index.

Limits: 40KB per CSV, 1–200 data rows, 32KB original metadata per record, and 50 selected saves per request. These keep serialized uploads within the API's 100KB JSON limit. Larger JSON returns 413; malformed JSON returns 400. Internal/provider error details are not returned or logged.

### Sources and free-tier protection

Copy `apps/api/.env.example` to `apps/api/.env` only when needed; keep all credential values local.

- **OpenStreetMap / Overpass:** no key. A country-constrained Nominatim city lookup supplies a validated bounding box; fixed niche tags drive a bounded Overpass query. Ambiguous cities fail with a request to add a region. Public requests use an identifying User-Agent, no autocomplete, no automatic retries, and no bulk pagination. Discovery is capped at 100 named results, 30 attempts per UTC day, and a 15-second cooldown. Identical results cache for one hour; city bounds cache for 24 hours. Coverage varies and bounding boxes can include nearby businesses. Spa/hotel tags do not establish specialty or business size; review relevance. OSM attribution and its license link appear with previews.
- **SerpAPI:** optional server-only `SERPAPI_API_KEY`; unavailable in the UI until configured. Every uncached search first checks the account API and accepts only an active, verifiable free plan with remaining monthly/hourly allowance. It makes one Google Maps result-page request, without automatic retries/pagination. `SERPAPI_MONTHLY_LIMIT` defaults to 50 local attempts; the provider's remaining allowance is also enforced. Tests cover the adapter and free-plan guards; a live SerpAPI credential was not supplied for this phase.
- **CSV:** manual local import; no discovery-provider quota.

One live provider request runs at a time; identical in-flight requests share their result. Failed attempts are charged locally before network I/O. Provider responses/timeouts are bounded. Usage counts persist in ignored `.local/provider-usage.json`; failed/corrupt storage blocks discovery. Keep this directory writable and durable, and **do not delete it to reset quotas**.

Run one API process for this personal workspace. The quota file, previews, and locks do not coordinate multiple processes/replicas. Distributed operation is outside the current architecture. Duplicate checks inspect at most 2,000 owner records and fail clearly above that limit. Source history is limited to 100 provenance records per lead; simultaneous metadata updates use an optimistic timestamp check. Provenance equality recursively sorts object keys, retains array order, and preserves genuinely different values. Repeated links remain idempotent after PostgreSQL JSONB reorders keys.

### Phase 2 website-fetch safety hook

`apps/api/src/website-safety.ts` prepares safety helpers only; no audit, classification, scoring, or website HTTP fetching is implemented.

- `collectWebsiteEvidence` exposes sanitized canonical website data and supported CSV/OSM/SerpAPI website fields from all linked provenance, with their source IDs and field paths. It excludes map/social URLs and does not pick a winner or modify the lead. Future audits must resolve conflicting evidence explicitly; a null canonical website is not proof that no website exists.
- `validateWebsiteDestination` permits HTTP(S) on standard web ports, rejects credentials/internal hostnames, resolves all addresses with a bounded wait, and fails closed if any answer is invalid or non-public. It excludes loopback, private/shared/link-local/multicast/reserved IPv4, metadata/platform endpoints, and non-global or special-purpose IPv6. IP shorthand and mapped forms cannot bypass checks. Tests use injected DNS results; they never fetch the blocked targets.
- **Mandatory before any Phase 2 website request:** pin a returned validated address in the transport while preserving the original Host/TLS hostname. Do not validate then call ordinary `fetch(url)`, which re-resolves DNS and permits rebinding. Disable automatic redirects; resolve and validate every redirect hop, pin its connection, and bound redirects/time/response size. Retest redirect-to-private and DNS-rebinding cases when implementing that transport. These helpers do not constitute a safe fetcher on their own.

Conservative address policy references: [IANA IPv4 special-purpose registry](https://www.iana.org/assignments/iana-ipv4-special-registry/), [IANA IPv6 special-purpose registry](https://www.iana.org/assignments/iana-ipv6-special-registry/). Some special-purpose public exceptions are deliberately excluded.

Backend configuration:

| Variable | Purpose |
| --- | --- |
| `DISCOVERY_MARKETS` | Comma-separated ISO alpha-2 codes; default `US,GB,CA,AU` |
| `DISCOVERY_NICHES_JSON` | Optional list of `{id,label,tags:[[key,value]]}`; all nine SPEC starter niches by default |
| `SERPAPI_API_KEY` | Optional free-plan provider credential, server only |
| `SERPAPI_MONTHLY_LIMIT` | Local monthly attempt cap (default 50); never overrides provider allowance |
| `OSM_NOMINATIM_URL`, `OSM_OVERPASS_URL` | Optional HTTPS endpoint overrides, without credentials/query strings/fragments; switch providers through env/restart |
| `HOST`, `PORT` | Default `127.0.0.1`, `3001` |

If changing PORT, set the web's `API_PROXY_TARGET` accordingly. Browser API requests stay same-origin through the Vite proxy; no permissive CORS is enabled.

Provider references: [Nominatim search](https://nominatim.org/release-docs/latest/api/Search/), [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/), [Overpass public-instance limits](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html), [OSM license](https://www.openstreetmap.org/copyright), [SerpAPI account API](https://serpapi.com/account-api).

## Verification and build

```sh
npm run lint
npm run typecheck
npm test
npm run build
# All four:
npm run check
# Remote auth/RLS prerequisites:
npm run verify:supabase
# Production API CSV/save/dedupe/persistence checks, after building:
npm run verify:phase1
# Include one bounded live OSM discovery/save/cache check:
npm run verify:phase1 -- --live-source
```

Live verifiers use two **confirmed, disposable** Auth accounts configured in ignored root `.env` through `SUPABASE_TEST_EMAIL_A`, `SUPABASE_TEST_PASSWORD_A`, `SUPABASE_TEST_EMAIL_B`, and `SUPABASE_TEST_PASSWORD_B`. Do not print/paste/commit their values. Accounts must have no existing `user_settings` row for the prerequisite verifier. Missing setup fails rather than being skipped. Verifiers remove only their generated test rows and end their non-persisted sessions.

`verify:supabase` checks live password sign-in, verified identities, persistence, bidirectional cross-user read/update/delete denial, forged inserts, owner-transfer denial, and anonymous access on both tables. `--connectivity-only` probes the schema/gateway but does not prove RLS. `verify:phase1` runs the built API on an ephemeral loopback port and checks token guards, owner-bound previews, normalized CSV storage, retry behavior, explicit source linking, uncertain duplicates, and remote isolation. Its live-source option consumes one guarded OSM attempt; wait at least 15 seconds after any other uncached OSM request and do not make concurrent quota-sensitive requests from separate API processes.

Unit tests execute the unchanged migration in development-only in-memory PostgreSQL via [PGlite](https://pglite.dev/docs/), emulating Supabase Auth roles/identity. They complement the remote verification; the app uses only Supabase for persistence. Other tests cover normalization, source transports, free-plan/quota guards, CSV bounds, safe API errors, and preview/save ownership.

Build order: shared contracts → API → web. Outputs: `packages/shared/dist`, `apps/api/dist`, `apps/web/dist`. After building, production smoke tests can use two terminals:

```sh
npm run start -w @igetjobs/api
npm run preview -w @igetjobs/web
```

Web preview is http://127.0.0.1:4173 with the local API proxy. A real deployment needs a reverse proxy for `/api`, SPA fallback, and durable local usage storage; deployment remains Phase 5.

## Structure and phase boundary

```text
apps/web/            React/TypeScript shell, login, Search previews, saved collection read view
apps/api/            Express/TypeScript API, verified auth, isolated adapters, quota guard, persistence
packages/shared/     Normalized Lead and API/discovery contracts
supabase/migrations/ V1 schema and owner policies
scripts/             Safe live Supabase and Phase 1 verification
tests/               Foundation, discovery, PostgreSQL RLS tests
```

Routes: `/`, `/search`, `/leads`, `/leads/:leadId`, `/outreach`, `/settings`, `/login`, and not-found. The workspace uses a viewport-fixed shell, fixed navigation/top bar, and a single scrolling content outlet. Short landscape navigation remains fully visible; mobile navigation wraps. Lead detail/outreach/scoring/management are intentionally placeholders for their approved phases.

Read SPEC.md, DESIGN.md, AGENTS.md, PLAN.md, and PROJECT_STATE.md. Finish each approved phase with checks, state update, separate commit/push, and review before proceeding. React, Node.js, Supabase, free tiers. No Next.js, MongoDB, AI, Hunter integration yet, automatic outreach, paid dependency, or V2 features.
