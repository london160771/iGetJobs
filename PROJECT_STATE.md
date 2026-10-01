# iGetJobs — PROJECT_STATE.md

## Current status

Phase 0 is approved and complete. Phase 1 discovery/ingestion, its Supabase prerequisites, and the requested review fixes, including protocol-relative provenance URL sanitization, are implemented and verified. Stop for review of this separate sanitization fix commit. **Phase 2 has not started and requires approval.**

Branch: main. Repository: https://github.com/london160771/iGetJobs.

## Source of truth and locked scope

SPEC.md → DESIGN.md → AGENTS.md → PLAN.md → PROJECT_STATE.md → code. SPEC.md and DESIGN.md remain unchanged.

- React + TypeScript, Node.js API, Supabase auth/database, free tiers only.
- Isolated SerpAPI, OpenStreetMap/Overpass, and manual CSV sources.
- Configurable US/GB/CA/AU markets and all nine starter niches.
- No Next.js, MongoDB, AI, paid requirement, Hunter integration yet, automatic outreach/calling, CRM, or V2 features.
- Audits, classification, scoring, management, and outreach remain their later phases. New leads have null audit/classification/score/draft and status New.

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

## Changed file groups

- apps/api/src/auth.ts and app/env/index/Supabase setup: verified authentication, safe routing/configuration/transport.
- apps/api/src/discovery/: adapters/interfaces, normalization, dedupe, quota guard/storage, preview/save service, authenticated repository/routes.
- apps/web/src/: auth/Login, Search, saved collection read view, API helper, page primitives, routing/styles, explicit Vite public-env handling.
- apps/web/public/lead-import-template.csv: header-only template.
- packages/shared/src/index.ts: provenance metadata and discovery/preview/duplicate/save contracts.
- supabase/migrations/202610010001_auth_and_leads.sql: already-applied V1 schema/RLS.
- tests/: foundation/auth regressions, discovery behaviors, SQL RLS.
- scripts/verify-supabase.mjs and scripts/verify-phase1.mjs: safe live checks and test-row cleanup.
- Root/workspace env examples, .gitignore, README, npm manifests/lockfile, lint configuration, and this state.

## Limitations and Phase 2 handoff

The reported review defects, including the protocol-relative provenance sanitization gap, are fixed and verified; review approval remains pending. No remaining Supabase prerequisite blocker. Live SerpAPI remains unverified because no provider key was supplied; its adapter/free-plan safeguards pass mocked transport tests and it remains unavailable until configured. The required live-source exit criterion is satisfied by OSM. Verify live SerpAPI before enabling/relying on it; its pending verification alone does not block the documented one-live-source criterion.

This personal architecture uses one API process. Persist .local/provider-usage.json across restarts; do not reset it to bypass caps. Previews/cache/locks are process-local and do not support replicas. A preview expires after 30 minutes or API restart. Limits: CSV 40KB/200 rows, saves 50/request, duplicate reads 2,000 owner records, saved read view latest 100, history 100 provenance records/lead. Failures are explicit; uncertain records never silently merge. OSM coverage/bounding boxes require relevance review.

Phase 2 requires Phase 1 review approval. Use preserved provenance before concluding NO_WEBSITE; expose conflicts for explicit review. Before any website HTTP fetching, pin validated IPs and preserve Host/TLS verification, disable automatic redirects, revalidate and repin every redirect hop, and bound redirect counts, timeouts, and response sizes. Test DNS rebinding and private redirects. The safety helpers alone do not provide a safe fetcher. Keep audits/scoring deterministic, measured, and explainable; no fabricated results. Add audits/classification/scoring only after approval. Lead management and outreach remain Phases 3 and 4.

## Publication and mandatory workflow

Phase 1 commit message: feat: implement Phase 1 lead discovery and ingestion. Target: origin/main. Git history and the final handoff record the confirmed commit hash/push status.

Separate review-fix commit message: fix: harden Phase 1 URLs, save retries, and provenance. Target: origin/main. Confirmed SHA/push status are recorded in Git and the final handoff; stop for review before Phase 2.

Separate protocol-relative fix commit message: fix: sanitize protocol-relative URLs in lead provenance. Target: origin/main. Confirmed SHA/push status are recorded in Git and the final handoff; stop for review before Phase 2.

At every future completed phase: run tests/lint/typecheck/build, review against SPEC.md, update state and limitations, commit separately, push and confirm SHA/status, then stop for review. Do not start the next phase without approval.

## Last updated

2026-10-01
