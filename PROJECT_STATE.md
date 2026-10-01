# iGetJobs — PROJECT_STATE.md

## Current status
Phase 0 implementation complete. Awaiting review before Phase 1.

The 2026-10-01 user request explicitly approved inspection followed by Phase 0 implementation and a separate commit/push. This supersedes the previous inspection-only state.

## Locked V1
- React + TypeScript frontend; Node.js API/backend
- Supabase auth + database; free-tier-compatible only
- SerpAPI free tier, OpenStreetMap / Overpass, manual CSV import
- Hunter as fallback only
- Configurable niches and markets (initially US, UK, Canada, Australia)
- Deterministic audit, classification and explainable 0–100 scoring
- Manual/editable outreach with human approval and manual pipeline tracking
- No AI, automatic outreach, voice calls, paid dependency, MongoDB, Next.js, or V2 features

## Source-of-truth docs
SPEC.md → DESIGN.md → AGENTS.md → PLAN.md → PROJECT_STATE.md → existing code.

SPEC.md and DESIGN.md were copied unchanged from the supplied documents.
AGENTS.md and PLAN.md now record the user's mandatory per-phase commit, push, and review workflow.

## Current phase
`PHASE 0 — COMPLETE / AWAITING REVIEW`

## Initial inspection
- Remote: https://github.com/london160771/iGetJobs
- Branch: main; initial commit: aa5e667
- Existing repository contained only .gitkeep.
- All Phase 0 foundation code and tooling were missing.
- No existing code conflicted with the docs.
- Stale inspection-only approval text was the only documentation conflict.
- Node.js 22.20.0 and npm 10.9.3 were available.
- Network approval was needed to clone/install/publish.
- No live Supabase credentials were supplied.

## Completed Phase 0
- npm workspaces: apps/web, apps/api, packages/shared.
- Vite React/TypeScript frontend; Express Node/TypeScript API.
- Base light app shell with responsive, keyboard-accessible navigation.
- Routes: Dashboard, Search, Leads, Lead Detail, Outreach, Settings, Login, and not-found.
- Routes are previews only; no business features, sample leads, or fabricated results.
- Browser and server Supabase client setup.
- Optional paired environment values; malformed configuration fails clearly.
- Browser rejects secret/service-role keys at startup and before bundling.
- API Supabase clients use public credentials and support separate user access tokens without persisted sessions.
- GET /api/health reports API availability and configured/unconfigured client state only.
- Shared normalized Lead model includes every SPEC field, provenance, audit outcomes, score reasons, draft approval, statuses, and timestamps.
- Unprocessed audit/classification/score/draft values are null; no invented classification or score.
- Normalization conventions are documented; normalization logic and deduplication remain Phase 1.
- Lint, typecheck (including tests), test, build, dev, and production-start scripts.
- Lockfile, ignored secret env files/build outputs, empty env examples, and local setup README.

## Validation — 2026-10-01
- npm run check: PASS (lint, typecheck, tests, production build).
- Foundation tests: 4 passed, 0 failed.
- Tests cover empty/partial/invalid env, browser private-key rejection, user-token isolation through mocked Supabase transport, health responses, unknown routes, and malformed JSON.
- npm install reported 0 vulnerabilities.
- npm run dev starts both frontend and API successfully without credentials.
- Browser review: desktop and 390px/320px mobile layouts inspected; no horizontal overflow at 320px.
- Search/Settings navigation and keyboard navigation to Leads/Outreach verified.
- Direct Lead Detail, Login, and not-found routes verified.
- Browser review reported no warning/error console entries.
- Runtime checks needed approved execution outside the sandbox because tsx's OS user-information lookup was restricted.
- No live provider request, database table, migration, auth flow, ingestion, deduplication, audit, scoring, or outreach implementation was added.

## Phase 0 UI correction — 2026-10-01
- Approved scope: fix shell scrolling only; Phase 1 remains unapproved.
- App shell fills the dynamic viewport; sidebar and top bar stay outside the scrolling content.
- One workspace content container scrolls the route outlet and footer; no document scrollbar.
- Existing desktop styling and wrapped mobile navigation are preserved.
- Short desktop/landscape viewports use compact sidebar spacing to keep all navigation and the sidebar footer visible.
- Changed files: apps/web/src/App.tsx, apps/web/src/styles.css, PROJECT_STATE.md.
- npm run lint, npm run typecheck, npm run build: PASS.
- Browser verification at 1280×720 desktop and 390×844 mobile: content scrolls while sidebar/header bounds stay unchanged; exactly one vertical scroll container and zero document overflow.
- At 320×740: no horizontal overflow; keyboard PageDown scrolls only workspace content.
- At 844×390 landscape: sidebar, all navigation, and sidebar footer remain fully visible.
- Separate fix commit: `fix: keep app navigation fixed while content scrolls`; target origin/main. Final handoff confirms its SHA and push status.

## Limitations / blockers
No remaining Phase 0 implementation blocker.

Live Supabase authentication/database connectivity is unverified because no project credentials were provided. A configured client is not proof of a live connection. No lead storage exists yet.

Before Phase 1 persistence, add the database schema with owner-scoped row-level security. The shell currently exposes no data and is unprotected; functioning authentication must be explicitly scoped in a later approved phase.

## Phase publication
Phase commit message: `feat: establish Phase 0 project foundation`. Publication target: `origin/main`. Git history and the final phase handoff record the confirmed SHA and push status.

## Next approved action
Review Phase 0 and its shell scrolling correction only. **Phase 1 has not started and is not approved.**

At the end of every future completed phase:
1. Run relevant checks and lint/typecheck/build.
2. Review against SPEC.md and summarize files changed.
3. Update PROJECT_STATE.md and record limitations honestly.
4. Commit that phase separately with a clear message.
5. Push it to the iGetJobs GitHub repository and confirm SHA/push status.
6. Stop and wait for review before starting the next phase.

## Last updated
2026-10-01
