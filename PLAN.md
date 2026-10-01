# iGetJobs — PLAN.md

## Build rule
Complete one phase at a time.

At the end of each phase:
1. run relevant tests
2. run typecheck/lint/build
3. review against `SPEC.md`
4. update `PROJECT_STATE.md`
5. commit the completed phase separately with a clear commit message
6. push to GitHub and confirm the commit hash and push status
7. stop for review before the next phase

## Phase 0 — Project foundation
Goal: establish a clean runnable base.

Tasks:
- inspect existing repo
- confirm React + TypeScript frontend
- confirm Node.js backend/API structure
- add environment variable handling
- add Supabase client/server setup
- create base app shell/routes
- define shared types
- define normalized lead model
- add basic lint/typecheck/build scripts
- document local setup

Exit criteria:
- app runs locally
- frontend/backend structure is clear
- Supabase connection path exists
- no secrets committed
- base checks pass

Review:
- GPT-6.1 Sol Medium

## Phase 1 — Lead discovery and ingestion
Goal: collect leads from supported sources.

Tasks:
- create source-adapter interface
- implement SerpAPI adapter
- implement OSM/Overpass adapter
- implement CSV import
- normalize all records
- add deduplication
- store leads in Supabase
- build Search UI
- show/save results

Exit criteria:
- user can search by city + niche
- at least one live source works
- CSV import works
- normalized leads persist
- duplicates are handled

Review:
- GPT-6.1 Sol High

## Phase 2 — Website audit, classification, scoring
Goal: turn raw businesses into useful prospects.

Tasks:
- implement deterministic website audit service
- detect no-website cases
- implement measurable quality checks
- classify leads
- implement configurable scoring
- generate explicit score reasons
- persist audit/scoring results
- show results in Leads and Lead Detail

Exit criteria:
- every audited lead has classification
- every scored lead has visible reasons
- no AI is used
- same input produces predictable output

Review:
- GPT-6.1 Sol High

## Phase 3 — Lead management
Goal: make the lead list operational.

Tasks:
- Leads table
- filters
- sorting
- Lead Detail
- notes
- manual pipeline statuses
- follow-up date
- dashboard counts
- useful empty/loading/error states

Exit criteria:
- user can inspect and manage saved leads
- state persists
- filters/status changes work

Review:
- GPT-6.1 Sol Medium

## Phase 4 — Outreach drafts
Goal: prepare leads for manual outreach.

Tasks:
- deterministic outreach template system
- editable drafts
- copy-to-clipboard
- use real available lead details
- Hunter fallback integration if needed
- Hunter quota guard
- mark Contacted manually

Exit criteria:
- user can prepare a sensible draft
- no outreach is auto-sent
- Hunter is only used as fallback
- no fake personalization

Review:
- GPT-6.1 Sol High

## Phase 5 — Polish and deployment
Goal: make V1 demo-ready and usable.

Tasks:
- responsive pass
- accessibility pass
- error handling
- loading states
- caching/throttling verification
- security/secrets review
- cleanup dead code
- production build
- deployment
- smoke test live app
- update README

Exit criteria:
- production build passes
- deployed app works
- core workflow works end-to-end
- no V2 features slipped into V1

Final review:
- GPT-6.1 Sol High

## Deferred V2
Do not implement during V1:
- AI lead research
- AI voice calling
- automated cold outreach
- CRM integrations
- mass email/follow-up automation
- richer analytics
