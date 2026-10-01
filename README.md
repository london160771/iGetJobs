# iGetJobs

Personal workspace for finding local businesses that need website work.

**Phases 1 and 2 implemented:** authenticated discovery, conservative duplicate review, Supabase persistence, safe website auditing, deterministic classification, and explainable scoring. New leads remain unclassified and unscored until an audit completes. Stop for review before Phase 3 lead management.

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
5. Open Saved leads to reload the latest 100 records from Supabase. Inspect a lead's website evidence, run its audit, and review the classification, numeric score, priority, reasons, and checks. Management, filters, and outreach remain later phases.

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

## Website audit and scoring (Phase 2)

Open **Leads → Inspect evidence / audit**. Canonical website data and all supported linked CSV/OSM/SerpAPI website fields are considered with source IDs and field paths. Map/social URLs are not treated as business websites. Multiple candidates or invalid evidence require an explicit selection; invalid-only evidence must be corrected through import/linking. New normalization retains a non-sensitive `websiteEvidenceInvalid` marker when a rejected URL had to be discarded. No available website evidence produces `NO_WEBSITE` without a network request. A failed or blocked request is never treated as proof of no website. A choice is recorded without overwriting canonical fields or source history.

Supported website evidence shapes are strings and flat lists of up to 16 strings, with sanitized URLs and indexed provenance paths. Unknown objects/scalars, nested/mixed lists, oversized URLs and malformed source containers require review. Structured canonical input is preserved safely for explicit selection; it never becomes a guessed canonical URL or silently becomes `NO_WEBSITE`.

- `validateWebsiteDestination` allows HTTP(S) on web ports, rejects credentials/internal hostnames, and fails closed if any DNS answer is invalid or non-public. Loopback, private/shared/link-local/multicast/reserved IPv4, metadata/platform endpoints, non-global/special-purpose IPv6, shorthand and mapped forms are blocked. DNS waits are bounded to five seconds and the overall deadline.
- The Node HTTP(S) transport pins the first approved address through a lookup callback, disables address family selection and connection pooling, preserves Host and TLS hostname/certificate verification, and sends no cookies, authorization or proxy credentials. There is no second DNS lookup for the connection. **Never replace this with ordinary `fetch(url)` after validation.**
- Automatic redirects are disabled. Each of at most three hops is revalidated and repinned, including same-host redirects. Userinfo and unsafe protocols are rejected before URL sanitization. Query credentials/fragments are stripped using Phase 1 rules. Requests have an eight-second absolute deadline, twenty seconds for the chain, 16KB header and 1MB HTML limits. Compressed responses are declined; HTML parsing executes no scripts, assets or extra link requests.
- Audits require verified Auth, use the user's RLS-scoped client, accept only a candidate choice, and update assessment fields only. Owner/ID/evidence timestamp guards reject concurrent lead changes. Two audits globally, one per owner, and a five-second owner cooldown bound work in the documented single API process. No automatic retries/bulk audit/caching of potentially stale measurements. New, genuinely different linked provenance clears an old assessment; identical links retain it.
- HTML parsing/selectors run in a short-lived Node worker (no page scripts). Analysis bounds: 128KB UTF-8 HTML, 64K visible text characters, 4,000 DOM nodes, depth 64, 64MB worker old-generation heap, five-second worker initialization and 750ms inspection deadline. Exceeding a bound produces HTTP 422 with quality unverified; no partial page is scored and prior results remain unchanged. Contact scanning makes one bounded pass, skips email tokens above 254 characters and bounds phone runs to 40 characters. Production uses compiled JS; development uses the existing tsx runner.

Completed audits always have one classification and a 0–100 score with explicit reasons. Missing evidence is `NO_WEBSITE`; network/DNS/timeouts or unsuccessful HTTP responses produce `POOR_WEBSITE` with a clearly labeled **unreachable in this audit** state and unknown page-quality checks. Reachable HTML becomes `POOR_WEBSITE` when weighted measured quality failures total at least 18, otherwise `ACCEPTABLE_WEBSITE`. Unsafe destinations, redirect/size/encoding limits, unsupported content, and HTTP 401/403/429 produce an incomplete audit error and leave prior results unchanged. They cannot support a quality classification.

Checks measure HTTPS, `width=device-width` meta, bounded response duration, HTML bytes, contact patterns, CTA labels, title/h1/text structure, and missing local fragment targets. Hidden/inline-hidden content, scripts and styles are excluded from text checks. CSS selector applicability, media conditions, cascade and rendered overflow are **not verified**, so minimum-width declarations (including inline widths) receive no mobile penalty. External CSS visibility, JavaScript-rendered contacts, actual click behavior, full browser performance, external links and rendered mobile usability also remain unverified. Unknown checks contribute no points. Contact/CTA absence means no supported indicator in the bounded fetched HTML, not absence from every rendered page. No subjective design-age or fabricated local-relevance score is assigned. New assessments use `static-v1.1`; older results remain dated historical snapshots and should be rerun to apply the corrected checks.

Default configurable points:

| Factor | Points |
| --- | ---: |
| No website after evidence resolution / unreachable request | 60 / 50 |
| Missing HTTPS / mobile viewport | 10 / 8 |
| CSS mobile width behavior (unverified) | 0; configured weight retained but inactive |
| Response over 3,000ms / HTML over 500,000 bytes | 5 / 4 |
| Missing contact / CTA / basic structure / broken local fragment | 6 / 6 / 4 / 3 |
| Recorded phone/email / rating ≥4 with ≥5 reviews / source identifier | 10 / 5 / 5 |

The last three are recorded source indicators, not independently verified facts. The existing `mobile_width` policy key is retained for configuration compatibility but contributes zero while its outcome is unknown. Score is the sum of reasons capped at 100; a cap adjustment is visible. A zero score has a zero-point explanation. High priority starts at 70, Medium at 40, Low below 40. Classification uses quality penalties only, not source/contact bonuses. Every audit stores its policy, choice, evidence, checks, metrics, timestamp, classification reasons and score reasons in existing Supabase columns; no new migration is needed.

Phase 3 requirement: management edits changing website/domain, linked evidence/source identifiers, phone/email, rating or review count must atomically clear `audit`, `classification`, `score` and `score_reasons` in the same owner/timestamp-guarded update. Reaudit before presenting these derived values as current. Preserve the existing identical-link behavior. Management editing remains unimplemented until Phase 3 is approved.

To tune weights, set a **complete** `AUDIT_SCORING_JSON` policy in the ignored API env, then restart. Defaults are in `apps/api/src/audit/policy.ts`; the following is a non-secret example of the full shape (use compact JSON as an env value):

```json
{"weights":{"no_website":60,"unreachable":50,"https":10,"viewport":8,"mobile_width":6,"performance":5,"page_size":4,"contact":6,"cta":6,"structure":4,"links":3,"contactable":10,"business_signal":5,"source_identity":5},"poorThreshold":18,"highPriority":70,"mediumPriority":40,"slowMs":3000,"largeBytes":500000}
```

Weights must be integers 0–100 with exactly the documented keys; thresholds are positive integers with Medium below High. Size/time thresholds cannot exceed fetch limits. Invalid config fails without echoing its value. Existing audit policies stay recorded; rerun an audit to apply new settings. Identical measured input and configuration produce identical results; real pages, DNS/reachability and timings can change between runs. Leads and Lead Detail display the measurement limits alongside evidence.

Authenticated endpoints: `GET /api/leads/:id` returns the lead/evidence/policy; `POST /api/leads/:id/audit` accepts `{}` for unambiguous evidence or `{"website":"https://candidate.com/"}` for an explicit preserved candidate. Arbitrary URLs, scores, classifications, ownership and audit payloads are rejected.

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
| `AUDIT_SCORING_JSON` | Optional full numeric audit/scoring policy; defaults and validation above |

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
# Authenticated Phase 2 fixture audits, remote persistence/RLS and optimistic writes:
npm run verify:phase2
# Also one real public HTTPS audit using the production pinned transport:
npm run verify:phase2 -- --live-website
```

Live verifiers use two **confirmed, disposable** Auth accounts configured in ignored root `.env` through `SUPABASE_TEST_EMAIL_A`, `SUPABASE_TEST_PASSWORD_A`, `SUPABASE_TEST_EMAIL_B`, and `SUPABASE_TEST_PASSWORD_B`. Do not print/paste/commit their values. Accounts must have no existing `user_settings` row for the prerequisite verifier. Missing setup fails rather than being skipped. Verifiers remove only their generated test rows and end their non-persisted sessions.

`verify:supabase` checks live password sign-in, verified identities, persistence, bidirectional cross-user read/update/delete denial, forged inserts, owner-transfer denial, and anonymous access on both tables. `--connectivity-only` probes the schema/gateway but does not prove RLS. `verify:phase1` runs the built API on an ephemeral loopback port and checks token guards, owner-bound previews, normalized CSV storage, retry behavior, explicit source linking, uncertain duplicates, and remote isolation. Its live-source option consumes one guarded OSM attempt; wait at least 15 seconds after any other uncached OSM request and do not make concurrent quota-sensitive requests from separate API processes.

`verify:phase2` uses explicitly injected HTML fixtures for predictable classification, then verifies real Auth/API/JSONB persistence, cross-user denial, evidence choices, cooldown and stale-write rejection. Its live-website option additionally fetches `https://example.com/` through the actual validated, pinned HTTPS transport. Only generated records are cleaned up. Fixtures do not claim to be live business audit measurements.

Unit tests execute the unchanged migration in development-only in-memory PostgreSQL via [PGlite](https://pglite.dev/docs/), emulating Supabase Auth roles/identity. They complement remote checks; the app uses only Supabase for persistence. Tests also cover measured audit/classification/scoring math, repeat determinism, missing/conflicting evidence, response/deadline limits, private redirects, DNS rebinding, stale/source-changed assessments, Phase 1 normalization/transports/quotas/CSV/dedupe/retries, and safe Auth/API errors.

Build order: shared contracts → API → web. Outputs: `packages/shared/dist`, `apps/api/dist`, `apps/web/dist`. After building, production smoke tests can use two terminals:

```sh
npm run start -w @igetjobs/api
npm run preview -w @igetjobs/web
```

Web preview is http://127.0.0.1:4173 with the local API proxy. A real deployment needs a reverse proxy for `/api`, SPA fallback, and durable local usage storage; deployment remains Phase 5.

## Structure and phase boundary

```text
apps/web/            React/TypeScript shell, login, Search, saved collection and audit detail
apps/api/            Express API, auth, discovery, quota guard, safe audit/scoring, persistence
packages/shared/     Normalized Lead and API/discovery/audit contracts
supabase/migrations/ V1 schema and owner policies
scripts/             Safe live Supabase, Phase 1 and Phase 2 verification
tests/               Foundation, discovery, audit/security, PostgreSQL RLS tests
```

Routes: `/`, `/search`, `/leads`, `/leads/:leadId`, `/outreach`, `/settings`, `/login`, and not-found. Desktop/tablet uses a fixed left sidebar and top bar with one scrolling content outlet. Mobile uses the same vertical sidebar in a hidden off-canvas drawer, opened by the top-bar menu button; never horizontal navigation. The drawer closes on close/backdrop/navigation/Escape, contains and restores keyboard focus, and locks background scrolling. On short screens only the open drawer scrolls to keep navigation and its footer accessible. Phase 2 detail supports audits only; management, pipeline editing, filters, dashboard metrics and outreach remain their later phases.

Read SPEC.md, DESIGN.md, AGENTS.md, PLAN.md, and PROJECT_STATE.md. Finish each approved phase with checks, state update, separate commit/push, and review before proceeding. React, Node.js, Supabase, free tiers. No Next.js, MongoDB, AI, Hunter integration yet, automatic outreach, paid dependency, or V2 features.
