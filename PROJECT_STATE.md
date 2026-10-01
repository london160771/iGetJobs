# iGetJobs — PROJECT_STATE.md

## Current status

Phase 0 is approved and complete. Phase 1 discovery/ingestion and its Supabase prerequisites are implemented and verified. Stop for Phase 1 review. **Phase 2 has not started and requires approval.**

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

- npm run check: PASS — lint with zero warnings, TypeScript including tests, 16 tests, production shared/API/web builds.
- Tests cover normalization/provenance, malformed/oversized CSV, Nominatim city restriction/cache, OSM/SerpAPI mapping, free-plan/quota guards, provider cache/persisted reservations/failure handling, conservative duplicates, preview ownership/mass assignment/retries, explicit source links, Auth guards, safe 400/413/API errors, and actual PostgreSQL migration/RLS enforcement through development-only PGlite.
- npm run verify:supabase: PASS remotely for both accounts/tables, including persistence and all cross-user/anonymous/ownership checks. Disposable records cleaned up.
- npm run verify:phase1 -- --live-source: PASS with the built API. CSV preview/save/reload, cross-user preview rejection/RLS isolation, retry protection, exact duplicate review, explicit provenance linking, and reviewed separate branch saves work.
- Live OSM/Overpass city+niche discovery returned 24 normalized businesses; source identifiers/raw tags were retained, identical queries cached, and a discovered lead persisted remotely. Only generated verifier rows were deleted.
- Browser CSV upload produced two preview rows, marked the conflicting shared-domain branch for review, saved the selected row, and reloaded it from Supabase. User B's collection remained empty. Browser test lead removed; both sessions signed out.
- Browser checks at 1280×720, 390×844, 320×740, 844×320, and 320×320: sidebar/header bounds fixed while content scrolls; all navigation accessible; zero document/horizontal overflow; exactly one visible vertical scroller (workspace-content).
- Secret audit: 63 publishable files and six production web output files scanned without emitting actual values. No secret env/build/usage artifacts are tracked.
- Dependency installation audit reported zero vulnerabilities.

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

No remaining Supabase prerequisite or Phase 1 implementation blocker. Live SerpAPI remains unverified because no provider key was supplied; its adapter/free-plan safeguards pass mocked transport tests and it remains unavailable until configured. The required live-source exit criterion is satisfied by OSM.

This personal architecture uses one API process. Persist .local/provider-usage.json across restarts; do not reset it to bypass caps. Previews/cache/locks are process-local and do not support replicas. A preview expires after 30 minutes or API restart. Limits: CSV 40KB/200 rows, saves 50/request, duplicate reads 2,000 owner records, saved read view latest 100, history 100 provenance records/lead. Failures are explicit; uncertain records never silently merge. OSM coverage/bounding boxes require relevance review.

Phase 2 requires Phase 1 review approval. Add deterministic audits/classification/scoring only after approval; no fabricated results. Lead management and outreach remain Phases 3 and 4.

## Publication and mandatory workflow

Phase 1 commit message: feat: implement Phase 1 lead discovery and ingestion. Target: origin/main. Git history and the final handoff record the confirmed commit hash/push status.

At every future completed phase: run tests/lint/typecheck/build, review against SPEC.md, update state and limitations, commit separately, push and confirm SHA/status, then stop for review. Do not start the next phase without approval.

## Last updated

2026-10-01
