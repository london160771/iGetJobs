# iGetJobs — PROJECT_STATE.md

## Current status

Phases 0–2 are approved and complete, including all reviewed fixes. The user authorized Phase 3 only. Lead management now includes a responsive table/cards, filters, sorting, pagination, notes, seven manual pipeline stages, follow-up dates, source/activity detail, guarded contact corrections and dashboard counts. Assessment invalidation is enforced atomically in both API updates and the database; stale/uncertain saves require reload and hide potentially stale results. **Stop for Phase 3 review. Phase 4 has not started.**

Branch: main. Repository: https://github.com/london160771/iGetJobs.

## Source of truth and locked scope

SPEC.md → DESIGN.md → AGENTS.md → PLAN.md → PROJECT_STATE.md → code. SPEC.md remains unchanged; DESIGN.md now records the user-authorized permanent responsive navigation rule.

- React + TypeScript, Node.js API, Supabase auth/database, free tiers only.
- Isolated SerpAPI, OpenStreetMap/Overpass, and manual CSV sources.
- Configurable US/GB/CA/AU markets and all nine starter niches.
- No Next.js, MongoDB, AI, paid requirement, Hunter integration yet, automatic outreach/calling, CRM, or V2 features.
- New discovery leads still have null audit/classification/score/draft and status New. Phase 3 adds management only; outreach drafts remain Phase 4. Discovery adapters and the audit/fetching/scoring engine are preserved.

## Approved Phase 0 history

- Foundation: 36cb620 — React/Vite and Express npm workspaces, shared V1 Lead contracts, environment/public clients, shell/routes, checks, local setup.
- Shell scrolling: dbb539d — viewport workspace, fixed navigation/top bar, only content scrolling.
- Review fixes: 3b15ddfe7fdb8349a3e7509519f3fd4815c75501 — height-aware landscape navigation and HTTP 413 for JSON over 100KB.
- The user approved Phase 0 and authorized Supabase prerequisites followed by Phase 1, with a separate commit/push and review stop.

## Completed Supabase prerequisites

- The user applied supabase/migrations/202610010001_auth_and_leads.sql remotely and created two confirmed disposable Auth accounts, configured only in ignored root .env.
- Live password sign-in and Auth-verified identities pass for both accounts.
- Email/password UI, restored-session verification, protected workspace routes, and local sign-out are implemented. Signed-out protected routes redirect to Login.
- Protected Node endpoints independently verify bearer tokens with Supabase Auth. Per-request database clients use user tokens/public keys, no admin key, no persisted server sessions, and bounded transport timeouts.
- V1 leads/user_settings tables have Auth ownership defaults, owner-only CRUD policies, enabled/forced RLS, no anonymous grants, constraints/indexes/timestamps.
- Remote checks prove bidirectional cross-user read/update/delete denial, forged ownership rejection, owner transfer rejection, anonymous read/write denial, and owner persistence for both tables.
- API-saved records are isolated remotely and in the browser: user B cannot see or change user A's lead.
- Root/workspace env handling accepts consistent ANON_KEY/PUBLISHABLE_KEY aliases, rejects private/admin credentials and partial/conflicting pairs, and explicitly exposes only validated public browser configuration.
- Local secret values are absent from publishable source files and Git file history. Test/private credentials are excluded from production web output. Secret env files, usage storage, test artifacts, and builds remain ignored.

## Completed Phase 1

- Shared live-source and import adapter interfaces; isolated SerpAPI, OSM/Overpass, and CSV implementations.
- SerpAPI Google Maps first-page mapping with server-only key, active free-plan/account allowance verification, local monthly cap/cooldown, no pagination/retry, and safe errors. Disabled in Search until a free-plan key is configured.
- OSM country-constrained, city-only Nominatim lookup and bounded Overpass queries. Ambiguous locations require a region. City/result caching, identifying User-Agent, attribution/license, cooldown, global request guard, daily attempt cap, response/time limits, and configurable HTTPS endpoints.
- UTF-8/BOM/quoted/multiline CSV import, header-only template, row/file/metadata bounds, stable file-hash/row source identifiers, optional defaults, and preserved extra columns.
- Normalized text/country/URLs/domains/E.164 phones/email/ratings/review counts; invalid contacts become null with warnings. No invented website audit, classification, score, or outreach.
- Domain/phone/name-address duplicate evidence plus source identifiers. Shared contacts, conflicting fields, and multiple matches are uncertain. Duplicates default to Skip; separate saves require explicit review; source linking requires one exact saved match and preserves existing fields/provenance.
- Owner-bound server previews, 30-minute expiry, capped memory, validated selections, 50-row saves, server-controlled ownership/fields, same-preview retry protection, per-row failures, and optimistic source-history updates.
- Authenticated Supabase insertion, source-history persistence, duplicate identity reads, and latest-100 collection reload.
- Search country/city/niche/source form; loading/error/empty states; results/contact/source notes; duplicate evidence; explicit save/link/separate choices; success summary and saved collection view.
- Desktop/mobile styling preserved. A viewport-fixed shell and clipped non-scrolling containers prevent hidden accessibility labels/focus from moving navigation in long results. Only workspace-content scrolls. Short landscape retains all navigation and the sidebar footer.

## Validation — 2026-10-01

- npm run check: PASS — lint with zero warnings, TypeScript including tests, 24 tests, production shared/API/web builds.
- Tests cover normalization/provenance, malformed/oversized CSV, Nominatim city restriction/cache, OSM/SerpAPI mapping, free-plan/quota guards, provider cache/persisted reservations/failure handling, conservative duplicates, preview ownership/mass assignment/retries, explicit source links, Auth guards, safe 400/413/API errors, and actual PostgreSQL migration/RLS enforcement through development-only PGlite.
- npm run verify:supabase: PASS remotely for both accounts/tables, including persistence and all cross-user/anonymous/ownership checks. Disposable records cleaned up.
- npm run verify:phase1 -- --live-source: PASS with the built API. CSV preview/save/reload, cross-user preview rejection/RLS isolation, retry protection, exact duplicate review, explicit provenance linking, and reviewed separate branch saves work.
- Live OSM/Overpass city+niche discovery returned 24 normalized businesses; source identifiers/raw tags were retained, identical queries cached, and a discovered lead persisted remotely. Only generated verifier rows were deleted.
- Browser CSV upload produced two preview rows, marked the conflicting shared-domain branch for review, saved the selected row, and reloaded it from Supabase. User B's collection remained empty. Browser test lead removed; both sessions signed out.
- Browser evidence from the unchanged Phase 1 UI at 1280×720, 390×844, 320×740, 844×320, and 320×320: sidebar/header bounds fixed while content scrolls; all navigation accessible; zero document/horizontal overflow; exactly one visible vertical scroller (workspace-content). This fix does not change the UI layout.
- Secret audit: publishable files, Git file history, and six production web output files scanned without emitting actual values. No secret env/build/usage artifacts are tracked.
- Dependency installation audit reported zero vulnerabilities.

## Phase 1 review fixes — 2026-10-01

Reviewed base: 9e444a99b7478fa22600d10972f13c6c70091108. The user authorized only these fixes and Phase 2 safety preparation, followed by checks, a separate commit/push, and a review stop.

- Canonical website/social URLs and provenance URLs now share credential sanitization. Unknown query parameters and all fragments are removed; only validated, bounded page/language selectors remain. Canonical userinfo remains rejected; metadata userinfo is removed. Regression tests cover token/key/auth variants, encoded/duplicate keys, fragment tokens, scheme-less/international URLs, and nested metadata. Live CSV persistence confirms the credential fixture is absent from canonical URLs and provenance.
- Save retries reconcile by verified owner + server-created preview lead UUID, before duplicate rejection or insert. An already-persisted record returns success without an overwrite or second insert. Unit tests cover lost acknowledgements for save/separate actions, repeated retries, foreign records, and failed lookups. The live verifier simulates a lost acknowledgement after a real Supabase insert, then confirms retry success with one insert and owner-only lookup.
- Provenance comparison recursively canonicalizes object keys while retaining array order and changed values. Tests exercise actual PostgreSQL JSONB reordering and repeated links. Live repeat linking after a remote JSONB round trip preserves the two genuine source entries without adding a third.
- apps/api/src/website-safety.ts exposes sanitized canonical and linked CSV/OSM/SerpAPI website evidence with source IDs/field paths; it does not choose a website, merge fields, fetch pages, classify, or score.
- A server-only destination validator rejects credentials/non-web protocols/nonstandard ports, internal hostnames, non-public IP literals or DNS answers, metadata/platform endpoints, and special-purpose IPv6. It fails closed on DNS errors/mixed answers and has a bounded DNS wait. Tests use injected DNS answers and do not fetch blocked targets.
- README documents the mandatory future transport hook: pin validated addresses with original Host/TLS identity, disable automatic redirects, validate/pin every redirect afresh, and bound transport work. Validation followed by ordinary fetch(url) is insufficient against DNS rebinding. The audit engine and that website transport remain unimplemented.
- Re-ran live auth/RLS checks on both tables/accounts and CSV/OSM discovery/cache/persistence verification. OSM returned 24 results. Only generated verifier records were cleaned up; no migration, policy, or auth behavior changed.

Fix file groups: discovery normalization/repository/save service; new website safety helpers; discovery and new review regression tests; enhanced live Phase 1 verifier; README and PROJECT_STATE.md. No frontend redesign, new dependency, migration, or V2 feature.

## Protocol-relative sanitization fix — 2026-10-01

Reviewed base: 4945e3b8dd222b9870eeb9cf6116c6dc12c76689. Review found that //example.com/?api_key=fixture was sanitized in canonical contacts but retained credential values in raw provenance.

- Metadata now recognizes protocol-relative URLs, resolves them to HTTPS, and applies the existing absolute-URL sanitizer. Credential/unknown query parameters, userinfo, and fragments are removed. Safe path, bounded page/language selectors, source identifiers, filenames, row numbers, and unrelated source fields are preserved. Malformed protocol-relative URLs become null. Other URL policies and app behavior are unchanged.
- Two regression tests cover canonical/social contacts, nested provenance, encoded credential keys, fragments, userinfo, malformed URLs, equivalent absolute-URL filtering, and CSV preview/save/reload including the persistence row mapping.
- npm run check: PASS — all 24 tests, zero-warning lint, typecheck, and production build.
- npm run verify:phase1: PASS — the built authenticated API preview, remote Supabase website/social/provenance persistence, and API reload contain no synthetic protocol-relative credential values. Safe fields/source IDs remain intact. Existing retry, source linking, duplicate-review, and owner-isolation checks also pass. Only generated verifier rows are deleted. No live-provider request is needed for this CSV-only fix.
- Secret scan: PASS — local configuration values absent from publishable files/Git file history; private/test credentials absent from web output; env/build/test artifacts remain ignored.
- Changed files: apps/api/src/discovery/normalize.ts, tests/phase1-fixes.test.ts, scripts/verify-phase1.mjs, and PROJECT_STATE.md. No new dependency, schema/RLS change, UI change, or audit implementation.

## Completed Phase 2 — 2026-10-01

Approved base: 82d60f4cfebcd25a4142b53122f12a2f6b0904f4. No new migration or RLS policy is required; the existing V1 assessment columns are used.

- Website resolution checks canonical and supported linked CSV/OSM/SerpAPI fields, retaining sanitized URLs/source IDs/paths. Conflicting or invalid evidence requires an explicit preserved candidate choice. Invalid-only evidence cannot become NO_WEBSITE; new normalization records a non-sensitive invalid-evidence marker even when sanitization discarded the input. Selection never overwrites contact/source data.
- The Node HTTP(S) fetcher validates every destination and all DNS answers, pins the approved address through a custom lookup, disables address family selection and pooling, preserves Host/TLS identity and certificate checks, and forwards no credentials/cookies. No ordinary fetch(url) is used for website requests. Local/private/link-local/metadata/internal and special-purpose destinations are blocked before connection.
- Redirects are manual, capped at three, and revalidated/repinned at every hop including the same hostname. Eight-second absolute request deadlines, twenty-second overall abort, five-second bounded DNS waits within that deadline, 16KB headers and 1MB HTML cap bound work. Compression is declined; no assets/scripts/extra link requests execute. Rebinding and private/userinfo/protocol redirect tests assert no unsafe transport connection.
- Static audits measure reachability, HTTPS, viewport meta, fixed minimum-width indicators, bounded response timing/HTML bytes, contact/CTA text patterns, title/h1/text structure and local fragment targets. Unknown/external/rendered behavior is explicitly unverified and earns no penalty. Hidden/inline-hidden content/scripts/styles are excluded from visible-text checks. No subjective design age, AI or fabricated relevance.
- Completed assessments have exactly NO_WEBSITE, POOR_WEBSITE or ACCEPTABLE_WEBSITE. Missing evidence produces NO_WEBSITE; failed network/DNS/timeouts/HTTP responses produce a labeled unreachable POOR_WEBSITE state with page quality unknown. Reachable HTML uses the inclusive weighted quality threshold (default 18). Unsafe/oversized/unsupported/restricted/redirect-limited results remain incomplete and do not replace a prior assessment.
- Scores sum explicit reasons, cap at 100 with a visible cap adjustment, and explain zero-point results. Default missing/unreachable weights 60/50 prioritize website need; measured quality penalties and recorded contact/rating/source indicators add points. High/Medium thresholds default to 70/40. Full numeric policy is configured through server AUDIT_SCORING_JSON; exact keys/weights/thresholds are validated without echoing values, recorded per audit and shown in UI.
- Authenticated detail/audit endpoints reject field injection, arbitrary URLs and foreign IDs. Per-user JWT/public Supabase clients enforce RLS. Updates change assessment fields only, with owner/ID/updated_at optimistic guards. One audit per owner, two globally and a five-second cooldown bound single-process requests. A new source link clears stale derived assessments; identical links retain a refreshed audit through JSONB round trips.
- Leads and Lead Detail show classification, numeric score, priority, explicit reasons and audit evidence; detail records the selected/final-response or attempted website and policy. Conflicts require a choice. Loading, reload, incomplete/blocked and unreachable states are clear. Navigation/unmount aborts stale client requests. Existing desktop/mobile shell and discovery flow are preserved.
- Added Cheerio (MIT, free) for bounded static HTML parsing. It does not perform network requests or execute scripts. No Hunter, AI, management, outreach, automatic sending or Phase 3 implementation.

### Phase 2 verification

- npm run check: PASS — 39 tests, zero-warning lint, TypeScript including tests, and shared/API/web production builds.
- Tests cover missing/unreachable/acceptable/poor outcomes, repeat determinism, scoring math/caps/zero reasons/config/thresholds, provenance conflicts/discarded invalid URLs, hidden content, restricted/unsupported pages, private/internal/metadata destinations, private/userinfo/protocol redirects, redirect limits, DNS rebinding/pinned Host/TLS options, response-size/compression/deadline/DNS limits, owner boundaries/cooldown, optimistic writes, and invalidation of stale assessments after new linking. All 24 Phase 1 regression tests remain passing.
- npm run verify:supabase: PASS — live Auth/persistence and bidirectional cross-user/anonymous/ownership denial for leads and user_settings; only generated test rows cleaned up.
- npm run verify:phase2 -- --live-website: PASS — production API Auth guards, real remote assessment JSONB/reasons/source persistence, two-account isolation, explicit conflict selection, incomplete unsafe destinations, cooldown and stale-write rejection. Predictable HTML fixtures are explicitly injected for classification tests. A real public HTTPS page is separately fetched through production DNS validation/pinning/Host/TLS verification and measured successfully.
- Final live checks also cover discarded invalid URL markers and assessment invalidation/idempotent linking through remote JSONB. One intermediate rerun had a transient connection failure; its generated rows were recovered by exact ID/name/owner, the complete rerun passed, and follow-up reads confirmed zero Phase 2 verifier rows for both accounts. An ignored UUID-only recovery journal now supports cleanup after interrupted checks; it contains no credentials/tokens.
- npm run verify:phase1 -- --live-source: PASS — CSV preview/save/reload/sanitization, lost-response retry, JSONB provenance idempotency, uncertain duplicate review, owner isolation, live OSM discovery/cache/save. OSM returned 24 normalized results. No SerpAPI credential was supplied; its prior mocked free-tier safeguards remain passing and it remains unavailable until configured.
- Browser: authenticated audit save/reload in Leads, missing evidence, explicit conflict choice and a live example.com audit, unsafe-target refusal and DNS-unreachable state pass. Responsive audit views at 1280×720, 390×844, 320×740 and 844×320 show no document/horizontal overflow, one workspace-content scroller, fixed navigation/header and accessible short-landscape navigation/footer. Test screenshots remain ignored; disposable browser rows are cleaned up and the session signed out.
- Secret scan: PASS — actual local configuration absent from publishable files/Git file history; test/private credentials absent from production web output. Env, build, usage and verification artifacts remain ignored. No secret values are printed.

Phase 2 file groups: new API audit engine/policy/pinned fetcher/service/routes; website evidence/safety and discovery assessment invalidation/invalid-evidence marker; shared audit contracts; Leads/detail/assessment components/styles/routing; audit regression tests/live verifier; npm manifests/lockfile, API env example, README and PROJECT_STATE.md.

## Responsive shell correction — 2026-10-01

Reviewed base: f0f80f537b0b5dc8cd25e4802f1fa2c0137b34d4. This separate UI correction supersedes earlier horizontal mobile/short-landscape navigation behavior; it does not begin Phase 3.

- Desktop/tablet retains the fixed vertical left sidebar and top bar. Only workspace-content normally scrolls. Short desktop spacing stays vertical and compact.
- Mobile uses the same sidebar hidden off-canvas, accessed through a labeled top-bar menu button. Close button, backdrop, navigation selection, Escape and browser history close it. Hidden navigation is inert; the open drawer traps focus, marks the background inert, locks workspace scrolling and restores focus on closing. Resizing to desktop restores focus to main content.
- Short mobile drawers permit bounded vertical scrolling for all navigation/footer access, with the close control kept visible. The workspace scrollbar is hidden while the drawer is open, so only one scroll area is active. Reduced motion is respected. No horizontal mobile navbar remains.
- DESIGN.md and README.md record the permanent desktop/tablet-sidebar and mobile-drawer rule. Current boundary: up to 760px wide, or up to 960px wide with height up to 500px for phone landscape.
- Browser verification: 1280×720 desktop, 768×1024 and 1024×768 tablets, 390×844 and 320×740 mobile portrait, 844×320 and 320×320 mobile landscape, and 1280×320 short desktop. No document/horizontal overflow; fixed top bar/sidebar while workspace scrolls; all navigation/footer accessible; no duplicate active scrollbars.
- Browser verification covers initial close-button focus, Tab/Shift+Tab containment, Escape/close/backdrop/navigation/history closure, resize focus recovery, and background scroll lock. Authenticated Search, Leads and Lead Detail still render; a disposable missing-website audit saved/reloaded classification, score 65, reasons and evidence. Only generated browser fixtures were cleaned up.
- npm run check: PASS — all 39 tests, zero-warning lint, typecheck including tests, shared/API/web production builds. Vite reports its non-blocking main-chunk size advisory (approximately 500KB); no new dependency is introduced.
- Secret scan: PASS — local configuration values absent from publishable files and Git file history; private/test credentials absent from web output. Env/build/test artifacts remain ignored.
- Changed files: apps/web/src/App.tsx, apps/web/src/styles.css, DESIGN.md, README.md and PROJECT_STATE.md. No backend, schema, auth policy, discovery or audit-engine change. Phase 2 review is pending.

## Phase 2 review fixes — 2026-10-01

Reviewed base: 4514d2fc87e8b801c8b70584d4bf4e409920101d (Phase 2 implementation f0f80f537b0b5dc8cd25e4802f1fa2c0137b34d4 plus mobile drawer correction). This separate fix addresses only the three reviewed audit issues and records the future invalidation requirement; it does not begin Phase 3.

- Contact detection now scans text once with fixed-size email tokens (254 characters maximum, local part 64) and phone runs (40 characters). Long unbroken tokens are never passed to a backtracking email regex. Regression cases include the reproduced 40,000-character text, long malformed email, 64,000-character text and a valid email following a long token.
- All HTML parsing/selectors execute in a short-lived Node worker, preserving API event-loop responsiveness even for pathological parser input. Limits: 128KB UTF-8 HTML, 64K visible text characters, 4,000 nodes, depth 64, 64MB worker old-generation heap, five-second initialization and 750ms inspection deadline. Oversized/complex/unresponsive analysis returns HTTP 422, leaves quality unverified and does not persist a partial assessment. Production uses compiled JS; development uses the existing tsx dependency. No page scripts execute and no dependency is added.
- Website evidence supports sanitized strings and flat lists of up to 16 strings with indexed source paths. Unknown objects/scalars, nested/mixed/oversized lists, overly long URLs and malformed source containers remain invalid/review-required. Structured canonical input is preserved in sanitized metadata, with a review marker instead of a guessed website. Candidates and invalid markers survive persistence; invalid-only evidence cannot become NO_WEBSITE.
- CSS selector applicability, media conditions, cascade and rendered impact are not established by this static audit. CSS width behavior is now unknown and earns no penalty, including inline declarations. Unused/desktop-only/overridden CSS regression cases retain the baseline classification and score. The existing mobile_width weight remains compatible but inactive for unknown outcomes.
- New assessments identify these revised checks as static-v1.1. Existing assessments remain dated historical snapshots; rerun them to apply the corrections. No automatic data rewrite, UI redesign, schema/RLS change or management editing is added.
- npm run check: PASS — 47 tests, zero-warning lint, typecheck including tests, shared/API/web production builds. Tests additionally cover analysis byte/text/tree bounds, startup and post-ready worker deadlines, event-loop yielding, repeated deterministic results, malformed evidence/array persistence and CSS scoring regressions. Existing private/internal blocking, redirect revalidation/pinning, Host/TLS, rebinding, classification/scoring and stale-write/source-link regressions remain passing.
- Production benchmark on this machine: 10K/20K/40K/64K unbroken text inspections took 72/53/30/31ms; the reproduced 40K case previously took 12.6 seconds. An event-loop heartbeat fired after 22ms while isolated inspection ran. Timing is machine-dependent; the worker deadlines provide runtime enforcement.
- npm run verify:supabase: PASS — live Auth, persistence and bidirectional cross-user/anonymous/ownership denial on leads and user_settings. npm run verify:phase2 -- --live-website: PASS — enhanced authenticated API cases verify long-text and desktop-only CSS scoring, malformed structured evidence, sanitized array candidates through remote JSONB/explicit selection, large-page refusal, owner isolation, stale-write rejection, assessment invalidation/idempotent linking and real pinned HTTPS fetching. Only generated disposable records are cleaned up.
- Secret scan: PASS — local configuration absent from publishable files/Git file history; test/private credentials absent from web output; env/build/usage/test artifacts remain ignored. No secret values are printed. The unchanged web build retains its non-blocking approximately 500KB chunk-size advisory.
- Changed files: API audit engine/new bounded HTML worker, website-safety evidence resolver, discovery normalization, audit regression tests, live Phase 2 verifier, README.md and PROJECT_STATE.md. The responsive drawer and Phase 1 discovery behavior remain unchanged.

## Completed Phase 3 — 2026-10-01

Approved base: 60d06eba7af8f96f99c76fb44841ce60c78e4974. The user approved Phase 2 and authorized Phase 3 lead management only.

- The user applied supabase/migrations/202610010002_lead_management.sql. It adds a bounded activity JSONB column and a non-privileged before-write trigger; existing enabled/forced owner RLS and ownership policies remain intact. No new app dependency or table is added.
- Auth-verified management routes use per-user public/JWT Supabase clients. Collection reads exclude raw provenance/notes/history, read database pages completely up to 2,000 owner records, then apply validated filters and stable sorting before 25-row UI pagination. Above the cap the API fails explicitly; dashboard counts never silently use latest-100 data. The discovery compatibility read is unchanged.
- Filters: niche, country, city, classification/unaudited, inclusive score range, priority, pipeline status, source and email/phone presence. Null scores are excluded from numeric ranges and sort last. Priority uses each assessment's saved policy. Sorting: score ascending/descending, newest/oldest, updated and case-normalized name, with ID tie-breaking. Filters/sort/page persist in the URL and have a clear action.
- Desktop Leads uses all nine requested columns; smaller workspaces use labeled cards with overdue/today/upcoming follow-ups. Lead Detail preserves audits/reasons and adds explicit save/discard forms for notes (10,000 characters), exact approved stages, follow-up set/change/clear, and validated business/contact corrections. It exposes preserved source IDs/metadata and the last 100 actual state changes. Audit controls are disabled while management edits are unsaved.
- Writes whitelist management fields, normalize/reject malformed contacts, derive the canonical domain, sanitize credential URLs, and require the last-loaded timestamp. Owner/ID/timestamp guards reject stale writes. Evidence/scoring changes clear audit, classification, score and reasons in the same write. The database guard also clears these fields for direct authenticated input edits, even if a client tries to submit a retained/forged assessment. Notes/status/follow-up-only edits retain unchanged assessments; identical provenance linking still retains them.
- The database generates field-name/stage/date/audit/invalidation history atomically; client history cannot replace it. It contains no note/contact value copies and caps the trail at 100 events. Created time remains visible; history before the migration is unavailable. Stale/uncertain management responses retain the visible form, hide the assessment and require reload before further writes; validation errors remain correctable. Reload/discard is explicit.
- Dashboard counts cover the complete supported owner collection: total, Qualified, NO_WEBSITE, POOR_WEBSITE, Contacted, Replied, Call Booked and Closed. Cards link to matching filters; stage counts represent the current stage. Empty/loading/error/retry and save success states are implemented without outreach, automation or analytics expansion.
- npm run check: PASS — 54 tests, zero-warning lint, typecheck including tests and shared/API/web production builds. Seven new tests cover combined filters/nulls, sorting/custom priority, counts/calendar follow-ups, validation/invalidation/no-op edits, 130-row pagination, owner/timestamp repository guards and both actual migrations with SQL RLS/history/direct invalidation bounds.
- Test files run sequentially: concurrently initializing two PGlite engines could starve the unchanged five-second HTML worker startup limit in a loaded local run. Serialization removes that test resource contention without increasing production deadlines or dropping any regression.
- npm run verify:phase3: PASS — real Auth for both accounts, applied schema, complete/paginated owner collections, all filter dimensions, live counts, seven persisted stages, notes/follow-up changes and clearing, remote activity JSONB, unchanged audit retention, stale/foreign/derived-field rejection, sanitized website correction, and API/database-level invalidation. Disposable generated IDs are cleaned up.
- npm run verify:supabase, npm run verify:phase2 -- --live-website, and npm run verify:phase1 -- --live-source: PASS after the migration. Remote Auth/RLS/persistence, pinned HTTPS, evidence/worker/CSS/scoring/stale-link regressions, CSV/lost-response/provenance/dedupe and live OSM discovery/cache/save remain working. OSM returned 24 normalized businesses; only generated verifier rows were removed.
- Browser: filters and score sorting, notes/status/follow-up save/reload, immediate assessment clearing after website correction, real example.com reaudit, source/activity display, stale form rejection/assessment hiding/reload recovery, dashboard counts, and desktop/mobile layout/scrolling verified. Drawer focus/Shift+Tab trapping/Escape restoration, backdrop/navigation closure, workspace lock and short-landscape footer access verified. Fixtures/screenshots remain ignored and disposable browser leads are cleaned up.
- Secret scan: PASS — actual local configuration values absent from publishable source and Git history; test/private credentials absent from production web output; env/usage/build/verifier artifacts ignored. The existing approximately 500KB Vite chunk advisory remains non-blocking.
- Changed file groups: management API/wiring, shared contracts/query helpers, Leads/dashboard/detail/forms/API error helper/styles, new SQL migration, management regression tests/live verifier, package script, README and PROJECT_STATE.md. App shell/drawer behavior, discovery/audit implementation, SPEC.md, DESIGN.md and PLAN.md are unchanged.

## Earlier Phase 0/1 changed file groups

- apps/api/src/auth.ts and app/env/index/Supabase setup: verified authentication, safe routing/configuration/transport.
- apps/api/src/discovery/: adapters/interfaces, normalization, dedupe, quota guard/storage, preview/save service, authenticated repository/routes.
- apps/web/src/: auth/Login, Search, saved collection read view, API helper, page primitives, routing/styles, explicit Vite public-env handling.
- apps/web/public/lead-import-template.csv: header-only template.
- packages/shared/src/index.ts: provenance metadata and discovery/preview/duplicate/save contracts.
- supabase/migrations/202610010001_auth_and_leads.sql: already-applied V1 schema/RLS.
- tests/: foundation/auth regressions, discovery behaviors, SQL RLS.
- scripts/verify-supabase.mjs and scripts/verify-phase1.mjs: safe live checks and test-row cleanup.
- Root/workspace env examples, .gitignore, README, npm manifests/lockfile, lint configuration, and this state.

## Limitations and Phase 4 handoff

Phases 0–2 are approved; Phase 3 review is pending. No remaining Supabase prerequisite blocker. Live SerpAPI remains unverified because no provider key was supplied; its adapter/free-plan safeguards pass mocked transport tests and it remains unavailable until configured. OSM satisfies the one-live-source criterion. Verify live SerpAPI before enabling/relying on it.

This personal architecture uses one API process. Persist .local/provider-usage.json across restarts; do not reset it to bypass caps. Previews/cache/locks are process-local and do not support replicas. A preview expires after 30 minutes or API restart. Limits: CSV 40KB/200 rows, saves 50/request, duplicate reads 2,000 owner records, saved read view latest 100, history 100 provenance records/lead. Failures are explicit; uncertain records never silently merge. OSM coverage/bounding boxes require relevance review.

Phase 2 uses static HTML, not a rendered browser audit. JavaScript-only pages, external CSS visibility, actual CTA behavior, external broken links and complete mobile/performance behavior remain unverified. Compression, unsupported content and access restrictions may require manual review; no score is invented for incomplete audits. Address rules deliberately reject some public special-purpose exceptions. Only the first approved IP is tried, without automatic retries. Results reflect the measured snapshot and may change with real page/DNS/timing changes. Previously discarded invalid source strings cannot be reconstructed; import corrected evidence when historical source data is incomplete.

Preserve safety in later phases: use provenance before NO_WEBSITE; pin validated IPs, preserve Host/TLS checks, disable automatic redirects, revalidate/repin every hop, keep bounds and rebinding/private-redirect tests. Do not bypass the pinned transport or execute page assets. Keep classifications/scoring deterministic and explicit. Phase 4 requires approval; outreach remains unimplemented.

Mandatory invalidation is implemented and verified in Phase 3. Preserve the owner/timestamp guards and database trigger for future edits; reaudit before presenting invalidated values as current. Notes/status/follow-up retain unchanged assessments and identical links remain idempotent. HTML analysis bounds and CSS-unknown behavior must remain intact. Management/counts cap at 2,000 owner records; legacy discovery reads remain latest-100. Activity retains the latest 100 events, not an unlimited history. Follow-up is a calendar date; no reminders or automatic sending are implemented.

## Publication and mandatory workflow

Phase 1 commit message: feat: implement Phase 1 lead discovery and ingestion. Target: origin/main. Git history and the final handoff record the confirmed commit hash/push status.

Separate review-fix commit message: fix: harden Phase 1 URLs, save retries, and provenance. Target: origin/main. Confirmed SHA/push status are recorded in Git and the final handoff; stop for review before Phase 2.

Separate protocol-relative fix commit message: fix: sanitize protocol-relative URLs in lead provenance. Target: origin/main. Confirmed SHA/push status are recorded in Git and the final handoff; stop for review before Phase 2.

Phase 2 commit message: feat: implement safe website audits and explainable scoring. Target: origin/main. Confirmed SHA/push status are recorded in Git and the final handoff; stop for review before Phase 3.

Separate responsive correction commit message: fix: use an accessible off-canvas sidebar on mobile. Target: origin/main. Confirmed SHA/push status are recorded in Git and the final handoff; stop for Phase 2 review before Phase 3.

Separate Phase 2 review-fix commit message: fix: bound audit analysis and preserve uncertain website evidence. Target: origin/main. Confirmed SHA/push status are recorded in Git and the final handoff; stop for Phase 2 review before Phase 3.

At every future completed phase: run tests/lint/typecheck/build, review against SPEC.md, update state and limitations, commit separately, push and confirm SHA/status, then stop for review. Do not start the next phase without approval.

Phase 3 commit message: feat: implement owner-scoped lead management. Target: origin/main. Confirmed SHA/push status are recorded in Git and the final handoff; stop for review before Phase 4.

## Last updated

2026-10-01
