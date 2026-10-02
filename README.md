# iGetJobs

Personal workspace for finding local businesses that need website work.

**Phases 0–4 approved. Phase 5 production smoke: NEEDS FIXES.** [Frontend](https://igetjobs.vercel.app) and [API](https://igetjobs-api.onrender.com) are live. Fresh-account workflows and live SerpAPI pass, but production OSM discovery fails at its public upstream. Phase 5 is not complete; see PROJECT_STATE.md for evidence and limitations. New leads remain unclassified and unscored until an audit completes. No V2 work.

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

Only validated public configuration enters the browser bundle. Provider keys, test credentials, and database credentials are excluded even from the root env. Lead/settings clients use public keys and user JWTs through owner RLS; they reject secret/service-role keys. Production requires a separate server-only `SUPABASE_QUOTA_SERVICE_KEY`, confined to `apps/api/src/quota.ts` for quota RPCs and never passed to lead/settings clients or Vercel. Server Supabase requests remain bounded at 15 seconds with no persisted sessions.

Run `supabase/migrations/202610010001_auth_and_leads.sql` once through the project owner's SQL Editor or your migration tooling. It is transactional and deliberately fails if its tables already exist, rather than modifying an unknown schema. **The current project migration has already been applied; do not rerun it.**

The migration creates V1 `leads` and `user_settings`, owner defaults referencing Auth users, enabled/forced owner-only RLS for all CRUD, no anonymous table grants, timestamps, constraints, and non-unique comparison indexes. Shared domains/phones can represent different branches. Credentials are not stored in these tables.

Then apply `supabase/migrations/202610010002_lead_management.sql` once. It adds a bounded database-generated activity trail and an atomic assessment invalidation trigger. **Both migrations are already applied to the current project; do not rerun them.** No new table, privileged app credential, or ownership-policy change is needed.

Also apply `supabase/migrations/202610010003_management_snapshot.sql` once before using the updated management API. Its read-only, stable, security-invoker function returns one bounded owner snapshot under existing RLS; anonymous execution is denied. It takes no owner argument and has no privileged credentials. **All three migrations are applied and remotely verified in the current project; do not rerun them.**

Apply `supabase/migrations/202610020004_outreach.sql` once for Phase 4. It adds bounded contact-enrichment attempt state, an owner-scoped outreach snapshot and a draft-staleness/history trigger. **All four migrations are applied and remotely verified in the current project; do not rerun them.** Existing ownership/RLS remains unchanged.

Sign in at `/login` or select Create an account. Signup may require email confirmation; provider errors use generic feedback. Configure Supabase's Site URL before testing deployed confirmation. All workspace routes require an Auth-verified session, including restored sessions. The Node API independently verifies every protected bearer token for owner-scoped data operations. Sign-out is local. `/api/health` reports API availability/configuration, not live lead access.

## Discovery workflow

1. Open Search; choose country, city (add state/region when ambiguous), niche, and source.
2. Find leads or upload a CSV to create a preview. Nothing is saved automatically.
3. Review location, contact information, source notes, and duplicate evidence. A missing source website is not an audit or a classification.
4. Select up to 50 results and save. Failures are reported per row; retrying the same preview does not repeat completed saves. Owner-scoped lookup by the server-created preview lead ID also reconciles an insert that committed before its response was lost; retry returns the existing lead without overwriting it.
5. Open Leads to inspect/audit and manage saved leads. In Lead Detail, generate a deterministic draft, edit it, explicitly review/approve it, then copy it for manual use. Outreach groups Ready, Contacted and Follow-up Due leads.

Each source has an isolated adapter. Normalization trims text, normalizes domains/HTTP(S) URLs, validates E.164 phones using the country, normalizes email/country, and bounds ratings/review counts. Invalid contacts become null with visible warnings, while original source fields remain in provenance. Source/sourceId, raw OSM tags, SerpAPI record fields, and CSV columns/row numbers are retained, subject to credential sanitization. Website/social and metadata URLs share sanitization: userinfo is rejected in canonical contacts, metadata userinfo is stripped, fragments and unknown query parameters are removed. Only bounded `page` numbers and validated `lang`/`locale` selectors survive because they select pagination or language without accepting arbitrary secret values. Credential-shaped metadata fields are removed. Oversized metadata records are skipped with a source note.

Duplicate evidence checks domain, phone, then normalized business name + address; source identifiers provide additional evidence. A shared domain or phone alone is uncertain. Conflicting details and multiple matches require review. Duplicates default to Skip. An exact, single saved match can receive source metadata only after the user chooses it; existing business/contact fields are preserved. The user may explicitly keep a reviewed match separately. No uncertain records are silently merged.

Previews are held on the server for 30 minutes, tied to the verified owner, with at most five previews per user and bounded total memory. Saving accepts preview IDs/selections rather than arbitrary browser-submitted leads, owner IDs, scores, or source metadata. Reloading the API or losing a preview requires a fresh search/import; saved Supabase leads remain persisted.

### CSV format

Use a UTF-8 CSV with exactly one business-name header: `businessName`, `name`, or `title`. Download the header-only template from Search. BOMs, quoted commas, and quoted multiline fields work. Headers must be unique; malformed CSV fails clearly.

Optional mapped columns: `niche`, `country`, `city`, `address`, `phone`, `website` (or `domain`), `email`, `facebook`, `instagram`, `linkedin`, `twitter`, `rating`, `reviewCount` (or `reviews`). Header matching ignores case, spaces, hyphens, and underscores. Country/city/niche form defaults fill missing values. Country aliases include UK/USA and the four starter country names. All extra columns are retained as metadata, excluding credential-shaped fields. Stable source identifiers use a file-content hash plus row index.

Limits: 40KB per CSV, 1–200 data rows, 32KB original metadata per record, and 50 selected saves per request. These keep serialized uploads within the API's 100KB JSON limit. Larger JSON returns 413; malformed JSON returns 400. Internal/provider error details are not returned or logged.

### Sources and free-tier protection

Copy `apps/api/.env.example` to `apps/api/.env` only when needed; keep all credential values local.

- **OpenStreetMap / Overpass:** no key. A country-constrained Nominatim city lookup supplies a validated bounding box; fixed niche tags drive a bounded Overpass query. Ambiguous cities fail with a request to add a region. Both services receive the identifying `iGetJobs/1.0 (+https://github.com/london160771/iGetJobs)` User-Agent. No autocomplete or bulk pagination. Results are capped at 100; the durable guard allows 30 attempts per UTC day with a 15-second cooldown. Identical results cache for one hour; country/city bounds cache for seven days (100 cities, coalesced lookups). These caches are process-local and reset on restart; quota state remains durable in Supabase. Nominatim requests are serialized and start at least one second apart, including different cities and retries. Coverage varies and bounding boxes can include nearby businesses. Spa/hotel tags do not establish specialty or business size; review relevance. OSM attribution and its license link appear with previews.

  Overpass defaults to `https://overpass-api.de/api/interpreter`, then `https://overpass.private.coffee/api/interpreter`. Configure an ordered list of one or both with `OSM_OVERPASS_URLS`; other destinations, duplicates and credential-bearing URLs fail startup. Legacy `OSM_OVERPASS_URL` chooses the preferred approved instance and retains the other as fallback. Set only one of these variables. City lookup and business lookup each make at most two attempts within a shared 110-second deadline; city requests time out after 10 seconds, business requests after 30 seconds, responses stay bounded at 8MB, and automatic redirects remain disabled. Connections/timeouts and HTTP 500/502/503/504 receive one bounded retry/fallback after at least 15 seconds; HTTP 429 waits at least 30 seconds and honors longer `Retry-After` values, refusing retry if the deadline cannot accommodate it. Geocoder 429 cooldown applies across cities. Overpass 403/404 may try the other approved instance once; permanent query errors, malformed responses and TLS certificate errors are not retried. Every additional attempt reserves another unit through the same atomic Supabase quota guard before network I/O. Fallback cannot increase/reset allowances or bypass the cooldown. Long rate limits and public-provider outages remain visible failures.
- **SerpAPI:** optional server-only `SERPAPI_API_KEY`; unavailable in the UI until configured. Every uncached search first checks the account API and accepts only an active, verifiable free plan with remaining monthly/hourly allowance. It makes one Google Maps result-page request, without automatic retries/pagination. `SERPAPI_MONTHLY_LIMIT` defaults to 50 local attempts; the provider's remaining allowance is also enforced. Tests cover the adapter and free-plan guards; a live SerpAPI credential was not supplied for this phase.
- **CSV:** manual local import; no discovery-provider quota.

One live discovery request runs at a time; identical in-flight requests share results. Attempts reserve allowance before network I/O, including failures. Production uses a row-locked Supabase RPC and database UTC periods/cooldowns; failed storage blocks calls. Development uses ignored `.local/provider-usage.json` unless `SUPABASE_QUOTA_SERVICE_KEY` is configured. Production never falls back to files or memory. Never reset usage to bypass caps.

Run one API process. Production database quotas are atomic; previews, caches, request locks and audit workers remain process-local. Replica operation is outside this architecture. Duplicate checks cap at 2,000 owner records and fail clearly above it. Source history caps at 100 records per lead with optimistic writes. Provenance equality ignores object key order, preserves array order and different values, and stays idempotent after JSONB round trips.

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

Management edits changing evidence/scoring inputs atomically clear `audit`, `classification`, `score` and `score_reasons`. The API uses owner/ID/last-loaded-timestamp guards; a database trigger also enforces invalidation for direct authenticated writes. Business name, niche/location/address, website/domain, contacts/socials, source/provenance, rating and review count are guarded conservatively. Notes, pipeline status and follow-up changes retain an unchanged assessment. Identical provenance links still retain it. Reaudit before presenting invalidated derived values as current.

## Lead management

Leads shows business, niche, location, classification, numeric score, priority, pipeline stage, source and update date. Desktop uses a table; smaller workspaces use labeled cards. Expand Filter leads for niche, country/city, classification (including unaudited), score bounds, priority, stage, source and email/phone presence. Sort by score, creation date, update date or name. Filters/sort/page remain in the URL and can be cleared. Null scores sort last and do not count as zero in numeric filters. Priority uses the scoring thresholds recorded in each audit.

The owner collection is read through one database statement/MVCC snapshot, then filtered/sorted before 25-row UI pagination. Concurrent inserts, deletions or edits cannot shift HTTP offset pages within that read. Management supports up to 2,000 owner records; the snapshot returns at most 2,001 summaries so exceeding the cap fails explicitly. It omits notes, raw provenance/history and audit checks, retaining only the saved scoring policy needed for priority. Each list/count response is coherent; separate requests can reflect newer committed state. The legacy discovery `/api/leads` read remains latest-100 for compatibility. Dashboard counts cover the complete supported owner collection and link to corresponding filters. Stage counts are current stages, not cumulative historical conversions.

City and niche have one shared 300-character limit in source normalization, CSV fields/defaults, discovery/configuration, management edits, filters and UI inputs. Normalized Unicode expansion is bounded too. Oversized imports produce a row warning; edits/queries fail with 400. No labels are silently truncated. Historical overlong labels are not rewritten automatically; correct them explicitly. They remain readable and do not block unrelated notes/status/follow-up saves.

Lead Detail supports saved notes (10,000-character limit), exactly the seven approved manual pipeline stages, follow-up dates, business/contact corrections, source/provenance and the latest 100 recorded state changes. Follow-up is a calendar date; UI writes noon UTC and labels the date overdue/today/upcoming against the local calendar day. Clearing it stores null. No outreach is sent. Source history is preserved; clearing the canonical website cannot erase linked website evidence.

Save changes explicitly; unsaved form changes block auditing until saved/discarded. A stale or uncertain management response keeps the form visible, hides the possibly stale assessment, and requires an explicit reload before further writes. Reload/discard is labeled when edits would be lost. Activity records field names, stage/date transitions and audit/invalidation events, never old note/contact values. It is generated in the same database transaction, cannot be replaced by API/client-supplied history, and does not reconstruct changes made before the migration.

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
| `HUNTER_API_KEY` | Optional server-only fallback credential; a key alone does not enable lookup |
| `HUNTER_FREE_PLAN_VERIFIED` | Default false; set exactly `true` only after real Free-plan credential verification |
| `HUNTER_MONTHLY_LIMIT` | Durable monthly fallback attempt cap (default 10, maximum 50) |
| `SUPABASE_QUOTA_SERVICE_KEY` | Render only: private quota RPC credential, never an app/public key |
| `OSM_NOMINATIM_URL`, `OSM_OVERPASS_URLS`, `OSM_OVERPASS_URL` | Optional HTTPS geocoder override and ordered approved Overpass list (or legacy preference); see bounded fallback rules above |
| `HOST`, `PORT` | Default `127.0.0.1`, `3001` |
| `AUDIT_SCORING_JSON` | Optional full numeric audit/scoring policy; defaults and validation above |

If changing PORT, set the web's `API_PROXY_TARGET` accordingly. Browser API requests stay same-origin through the Vite proxy; no permissive CORS is enabled.

Provider references: [Nominatim search](https://nominatim.org/release-docs/latest/api/Search/), [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/), [Overpass public-instance limits](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html), [OSM license](https://www.openstreetmap.org/copyright), [SerpAPI account API](https://serpapi.com/account-api).

## Outreach drafts and contact fallback (Phase 4)

Lead Detail provides deterministic NO_WEBSITE and POOR_WEBSITE drafts based on the current completed assessment. Missing-website wording refers to available listings, not proof that no site exists. Poor-site drafts include at most three failed, supported static checks, ordered by the saved audit weights; rendered mobile behavior and other unknown checks never become claims. Failed checks distinguish a recorded HTTP response from DNS, connection and timeout problems without exposing technical details to the recipient. Unknown historical failures use conservative wording; no-response claims require explicit evidence. Every failure may be temporary and page quality remains unverified. No AI, provider-generated text, fake personal history or invented sender details are used.

Generated drafts start pending. Edit subject/message, review the evidence, and explicitly check the review box before saving approval. Copy performs a fresh owner/timestamp/evidence check before browser clipboard access; denial/unavailable clipboard produces clear feedback and manual-copy fallback. Copy never sends anything. Regeneration requires explicit replacement confirmation for edited text. Evidence/audit/classification/scoring changes atomically preserve draft text but mark it stale and revoke approval. Reaudit/regenerate/review before copying again. Notes/status/follow-up-only changes retain unchanged drafts. No-op draft saves do not duplicate activity.

Successful saves clear the editor's dirty state even when the server keeps the unchanged timestamp. Copy/manual Contacted remain available according to saved approval/state. The corrected template version requires regeneration/review for older failure drafts, preserving user text and replacement confirmation; unaffected older missing/reachable-site drafts remain usable.

Outreach reads one bounded owner snapshot and paginates 20 items. Ready contains current NO_WEBSITE/POOR_WEBSITE opportunities in New/Qualified with Medium/High priority (or manual Qualified status). Contacted uses the actual Contacted stage. Follow-up Due uses the chosen local calendar day, including today, and excludes Closed/Lost. Every card shows contact data, score/classification/priority, reason, draft state/preview and explicit copy/Contacted/detail actions. Mark Contacted is a guarded manual status update, independent of sending or clipboard success.

Hunter is an isolated **explicit fallback**. A server-only `HUNTER_API_KEY` and `HUNTER_FREE_PLAN_VERIFIED=true` are both required. Verify a real Free-plan credential before setting the flag; each lookup still verifies the account and credits. The cap defaults to 10 and cannot exceed 50. Production reserves attempts atomically in Supabase; development may use ignored `.local/hunter-usage.json`. Failed/no-result attempts count before network I/O; one global lookup and a five-second cooldown protect the free tier. Extra allocations over the free ceiling are declined. See the [account/domain reference](https://hunter.io/api-documentation/v2) and [Free Plan limits](https://help.hunter.io/en/articles/11060999-what-s-included-in-hunter-s-free-plan).

Only worthwhile assessed leads without a usable email qualify. A domain must come from the explicitly audited preserved website; no company-name guess is made for NO_WEBSITE leads with no domain. The lookup requests one generic contact, has no pagination/retry/verification charge, uses a secret header on a fixed HTTPS endpoint, declines redirects, and bounds time/response size. Only a matching-domain, syntactically valid generic email with provider confidence ≥80 is saved as a **candidate**, not a delivery guarantee. Raw provider data, key, personal names and source URLs are discarded. “Use email” is explicit, never overwrites a usable email, and clears assessment/scoring and marks the draft stale because contactability affects scoring.

Per-lead attempt fingerprints and pending/found/no-result/quota/error outcomes persist in Supabase under owner RLS. An unchanged lead cannot be silently looked up again after no result, restart or uncertain response; the user must explicitly retry. Stale/uncertain writes require reload. The live verifier injects clearly labeled provider fixtures; live Hunter remains unverified until a real Free-plan credential is configured. There are no Hunter sequences, mailboxes, sending, CRM, automatic DMs, voice, campaigns or V2 features.

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
# Phase 3 persistence, filters/counts, state changes, invalidation, activity and isolation
npm run verify:phase3
# Phase 4 drafts/approval/Contacted/staleness, remote persistence/RLS and explicit Hunter fixtures
npm run verify:phase4
# Optional browser regression (requires local dev app/API and a Playwright runtime):
npm run verify:phase4:browser
# Global quota migration/reservation/restart and public/user RPC denial:
npm run verify:quota
# All V1 screens, responsive overflow, WCAG and keyboard drawer:
npm run verify:phase5:browser
# Built/deployed API workflow with real public fixture audits; optional one OSM search:
npm run verify:deployed -- --live-source
# Production normal signup/email confirmation/login, with a fresh disposable email:
node scripts/verify-production-auth.mjs --create
# After obtaining the real signup confirmation URL privately in ignored .local:
node scripts/verify-production-auth.mjs --confirm
node scripts/verify-production-security.mjs
node scripts/verify-production-discovery-browser.mjs
# Focused production OSM Search UI preview/save/reload/cache/quota/cleanup:
npm run verify:osm:production
# Both real providers, through the deployed frontend proxy:
npm run verify:deployed -- --live-source --live-serpapi
npm run secret:scan
```

Live verifiers use two **confirmed, disposable** Auth accounts configured in ignored root `.env` through `SUPABASE_TEST_EMAIL_A`, `SUPABASE_TEST_PASSWORD_A`, `SUPABASE_TEST_EMAIL_B`, and `SUPABASE_TEST_PASSWORD_B`. Do not print/paste/commit their values. Accounts must have no existing `user_settings` row for the prerequisite verifier. Missing setup fails rather than being skipped. Verifiers remove only their generated test rows and end their non-persisted sessions.

Production smoke uses a fresh account created through the real Create account UI. Set `SUPABASE_SMOKE_EMAIL` privately in ignored `.env`; the creation verifier generates/stores `SUPABASE_SMOKE_PASSWORD` there. The confirmation verifier accepts only the configured Supabase signup verification URL from ignored `.local/production-confirmation-url.txt`, consumes it through the browser and deletes the file. Do not paste confirmation tokens into chat/logs. Deployed API, quota and browser verifiers prefer this fresh account when both smoke variables are present; existing account B is used only for isolation checks. Set `VERIFY_WEB_URL=https://igetjobs.vercel.app/`. Run mutating verifiers sequentially so dashboard baselines do not overlap fixtures. The security verifier checks deployed headers/private paths and recursively scans built assets against known private configuration; it never prints credential values.

The optional `verify:phase4:browser` checks actual editor save/review/copy/reload/no-op behavior, manual Contacted, stale-draft refusal and desktop/tablet/mobile drawer/scrolling at five sizes. It requires an existing Playwright runtime and Chrome; the application adds no browser-testing dependency. Set `PLAYWRIGHT_MODULE` to an installed Playwright module path/URL if it is not locally resolvable. `VERIFY_WEB_URL` may override the default `http://127.0.0.1:5173/`, restricted to loopback or the approved production frontend. Logs/screenshots/fixture IDs stay in ignored `.local`; only the verifier's generated lead is removed.

`verify:supabase` checks live password sign-in, verified identities, persistence, bidirectional cross-user read/update/delete denial, forged inserts, owner-transfer denial, and anonymous access on both tables. `--connectivity-only` probes the schema/gateway but does not prove RLS. `verify:phase1` runs the built API on an ephemeral loopback port and checks token guards, owner-bound previews, normalized CSV storage, retry behavior, explicit source linking, uncertain duplicates, and remote isolation. Its live-source option consumes one guarded OSM attempt; wait at least 15 seconds after any other uncached OSM request and do not make concurrent quota-sensitive requests from separate API processes.

`verify:phase2` uses explicitly injected HTML fixtures for predictable classification, then verifies real Auth/API/JSONB persistence, cross-user denial, evidence choices, cooldown and stale-write rejection. Its live-website option additionally fetches `https://example.com/` through the actual validated, pinned HTTPS transport. Only generated records are cleaned up. Fixtures do not claim to be live business audit measurements.

`verify:phase3` signs in both disposable accounts and runs the built management/audit API on an ephemeral loopback port. It checks more than 200 records, concurrent insert/snapshot/count coherence, boundary-label save/filter behavior, anonymous/cross-user RPC denial, pagination/filtering/sorting, seven persisted stages, notes/follow-up changes and clearing, unchanged assessment retention, stale/injected/foreign write rejection, idempotent history, URL sanitization and atomic invalidation. Only its generated fixture IDs are removed; an ignored UUID-only recovery journal supports interrupted cleanup.

Unit tests execute all five actual migrations in development-only in-memory PostgreSQL via [PGlite](https://pglite.dev/docs/), emulating Supabase Auth roles/identity. `npm test` compiles tests and their API imports to ignored `.local/test-build`, then runs only current test files sequentially with a 30-second per-test watchdog. HTML workers use compiled JavaScript, matching production rather than paying TypeScript-loader startup on every test. Readiness waits are bounded and inspections settle only after worker termination on success/error/timeout. Production limits remain five seconds for startup, 750ms for inspection, and the existing HTML/tree/text/heap bounds. These tests complement remote checks; the app uses only Supabase for persistence. Coverage includes outreach templates/approval/clipboard/edits/invalidation, Hunter eligibility/quota/retry/no-result, snapshot races/coherence/caps/RLS, shared input boundaries, filters/sorting/counts, notes/status/follow-up/history, atomic invalidation, owner/timestamp guards, deterministic audits/scoring, evidence, SSRF/redirect/rebinding/bounds, discovery/CSV/dedupe/retries/quotas and safe Auth/API errors.

Build order: shared contracts → API → web. Outputs: `packages/shared/dist`, `apps/api/dist`, `apps/web/dist`. After building, production smoke tests can use two terminals:

```sh
npm run start -w @igetjobs/api
npm run preview -w @igetjobs/web
```

Web preview is http://127.0.0.1:4173 with the local API proxy. Set `VERIFY_WEB_URL=http://127.0.0.1:4173/` for built-asset browser checks. Optional `SERVE_WEB=true` serves the built React app through the Node API for local combined-build checks; Render does not use it.

## Approved deployment: Vercel Free + Render Free + Supabase

No paid disk or extra database is required. Render's free filesystem is ephemeral; quota state uses the existing Supabase project. [Render documents free-service limitations](https://render.com/docs/free). Keep one API process/instance: previews, caches and locks remain process-local.

Vercel's [Hobby plan](https://vercel.com/docs/plans/hobby) is restricted to personal, non-commercial use. A personal demonstration must meet that policy; using this client-acquisition app for commercial work may require another approved frontend host. Do not silently upgrade to a paid plan. Confirm eligibility before business production use.

### Manual setup before deployment

1. **Supabase SQL Editor:** apply `supabase/migrations/202610020005_provider_usage.sql` once. The earlier four migrations are already applied. Global `provider_usage` has forced RLS and no public/user table grants. Only `service_role` can execute the two quota RPCs. They cannot touch leads/settings, reset counts, accept a caller-supplied clock/period or change ownership. Reservations lock the provider row, then check UTC period/cooldown/cap before consuming allowance.
2. **Supabase API Keys:** obtain a secret key or legacy service_role key. Store it as `SUPABASE_QUOTA_SERVICE_KEY` in ignored local `.env` and Render's private environment. Never put it in chat, Git, Vercel or VITE variables. It is privileged at project level; the quota module confines its use to the two RPCs. Lead/settings clients retain public keys/user JWTs/RLS.
3. **Live quota gate:** `npm run build && npm run verify:quota`. This consumes one database SerpAPI reservation without contacting SerpAPI, checks fresh-client restart/cooldown behavior, and verifies anonymous/both users cannot access quota state. Do not delete/reset production quota rows as cleanup. Missing setup fails explicitly.
4. **Render dashboard:** connect `london160771/iGetJobs`; create a Blueprint from root `render.yaml`, or a Free Node Web Service named `igetjobs-api` with its commands. Repository root directory: `.`. Keep Free plan, one instance, no autoscaling/cron/worker/disk. Set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and private `SUPABASE_QUOTA_SERVICE_KEY`. Leave provider keys unset and `HUNTER_FREE_PLAN_VERIFIED=false`. Render supplies `PORT`; `HOST=0.0.0.0` and `/api/health` are configured. Startup requires working quota RPCs with no filesystem fallback. Record the actual API HTTPS URL.
5. **Vercel dashboard:** import the same repository on Free/Hobby as `igetjobs`, root directory `.`, Node 22. `vercel.json` sets workspace build, `apps/web/dist`, security headers, SPA fallback and external `/api` proxy. Set ONLY `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Never copy root/server/test credentials. The proxy currently targets `https://igetjobs-api.onrender.com`; change it before deploying if Render assigns another hostname. [External rewrites](https://vercel.com/docs/routing/rewrites) keep API calls on the frontend origin without wildcard CORS.
6. **Supabase Auth → URL Configuration:** use the actual frontend HTTPS origin as Site URL and allow its confirmation redirect origin. Test signup using an inbox you control. Automated local signup verification uses an explicitly injected response fixture; it does not claim delivered confirmation mail.
7. **Deployed smoke gate:** once accounts/configuration are ready, set `VERIFY_WEB_URL` to the actual `https://igetjobs….vercel.app/` origin and run `npm run verify:phase5:browser` using local disposable account credentials and an optional Playwright runtime, then `npm run verify:deployed -- --live-source` sequentially. Verify CSV/save/dedupe, OSM/cache, three classifications/scoring, filters/notes/status/follow-up/counts, reviewed drafts/copy/Contacted, logout/login and cross-user isolation on the deployed API. The poor public fixture is a measured HTTP 404; its page quality is explicitly unverified. Public pages can change, so a failed live assertion requires evidence review rather than fabricated results. The earlier phase verifiers run local built APIs against real Supabase; they are regression evidence, not deployed smoke tests. Do not mark Phase 5 complete until deployment and smoke tests pass.

Free Render can sleep/cold-start and reset previews/caches, but database quota survives. Client requests are bounded at three minutes to allow a cold start and bounded discovery; uncertain saves retain retry/stale-write safeguards. Strict worker/fetch bounds remain intact and may decline busy/unsupported pages without inventing evidence. Hunter remains disabled until a real Free-plan credential is configured and verified. Live SerpAPI discovery, reviewed collection, caching and durable reservations now pass in production. Signup, delivered confirmation, application migrations and quota setup are also verified.

The remaining production smoke blocker is OSM: earlier Nominatim city lookups intermittently returned HTTP 429, and Overpass business endpoints refused/failed connections from Render. The old `OSM_OVERPASS_URL` and `NODE_OPTIONS` overrides are now confirmed absent in Render, with deployment `281bfea` Live before this fix. The bounded approved-instance fallback above is implemented and passes regression checks; production verification of this fix remains pending. Run `npm run verify:osm:production` after the new API deployment is Live, then the affected deployed smoke checks before declaring success. Public provider availability is not guaranteed; error feedback remains bounded and safe. No cap increase, quota reset, browser-side provider calls or paid infrastructure was introduced. All other requested production gates previously passed, including actual mobile CSV/SerpAPI preview/save, clipboard and cross-user isolation. Full results are recorded in PROJECT_STATE.md.

## Structure and phase boundary

```text
apps/web/            React shell, login, Search, management/detail/dashboard and outreach
apps/api/            Express auth/discovery/audit/management/outreach APIs and persistence
packages/shared/     Lead/API contracts, management helpers and deterministic outreach templates
supabase/migrations/ V1 schema, owner policies, atomic history/invalidation guard
scripts/             Safe live Supabase and Phases 1–4 verification
tests/               Foundation, discovery, audit/security, management/outreach and SQL RLS tests
```

Routes: `/`, `/search`, `/leads`, `/leads/:leadId`, `/outreach`, `/settings`, `/login`, and not-found. Desktop/tablet retains fixed navigation/header with one keyboard-focusable content scroller. Mobile keeps the same hidden off-canvas sidebar, never horizontal navigation. The drawer closes on close/backdrop/navigation/Escape, contains/restores focus and locks background scrolling. On short screens the open drawer alone may scroll to keep all items/footer accessible. Phase 5 is deployed but its OSM smoke gate remains unresolved; no V2 work.

Read SPEC.md, DESIGN.md, AGENTS.md, PLAN.md, and PROJECT_STATE.md. Finish approved work with checks, state update, separate commit/push, and review. React, Node.js, Supabase, free tiers. Hunter is explicit fallback only. No Next.js, MongoDB, AI, automatic outreach, paid dependency, or V2 features. Stop for final V1 review after Phase 5 deployment verification.
