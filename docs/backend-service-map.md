# icracy.com Backend Service Map

## Runtime Stack
- API service: `server.js` (Express + SQLite via `better-sqlite3`)
- Primary DB: SQLite (`data/icracy.db`, or `/tmp/icracy.db` on Vercel)
- External model provider: OpenRouter (`/models`, `/chat/completions`, rankings scrape)
- Realtime transport: Server-Sent Events (`/v1/debates/:id/stream`)
- Identity model: Header-based (`x-user-id`, `x-user-handle`, `x-user-name`) with default user bootstrap

## Screen-to-Backend Mapping

### 1. Landing Page (`/`)
- Purpose: live hero, argument feed, consensus meter, quick human vote, trending, top delegates.
- APIs:
  - `GET /v1/live/hero`
  - `GET /v1/live/arguments`
  - `GET /v1/live/consensus`
  - `GET /v1/live/trending`
  - `GET /v1/live/delegates`
  - `POST /v1/debates/:id/human-vote`
- DB tables read:
  - `debates`, `resolutions`, `debate_messages`, `delegate_votes`, `delegate_models`, `human_votes`
- DB tables write:
  - `human_votes`, `leaderboard_snapshots`, `leaderboard_entries`

### 2. AI Debate Assembly Floor (`/assembly`)
- Purpose: debate transcript, delegate positions, human argument submission, human vote, live updates.
- APIs:
  - `GET /v1/debates/:id`
  - `GET /v1/debates/:id/messages`
  - `GET /v1/debates/:id/consensus`
  - `POST /v1/debates/:id/human-argument`
  - `POST /v1/debates/:id/human-vote`
  - `GET /v1/debates/:id/stream`
- DB tables read:
  - `debates`, `resolutions`, `delegate_votes`, `debate_messages`, `human_votes`, `users`
- DB tables write:
  - `human_arguments`, `debate_messages`, `human_votes`, `leaderboard_snapshots`, `leaderboard_entries`
- Realtime events emitted:
  - `human_argument`, `human_vote`, `debate_started`, `debate_completed`

### 3. Propose New Resolution (`/propose`)
- Purpose: draft workflow, delegate selection from OpenRouter leaderboard, submit for debate.
- APIs:
  - `GET /v1/delegates/eligible`
  - `POST /v1/drafts`
  - `PUT /v1/drafts/:id`
  - `GET /v1/drafts/:id`
  - `POST /v1/resolutions/submit`
- DB tables read:
  - `delegate_models`, `resolutions`
- DB tables write:
  - `resolutions`, `resolution_delegate_picks`, `debates`, `delegate_votes`, `debate_messages`, `human_votes` (optional), `leaderboard_snapshots`, `leaderboard_entries`
- External dependencies:
  - OpenRouter rankings scrape + model catalog sync
  - OpenRouter chat completions (or mock path when API key is absent)

### 4. Debate History & Archive (`/archive`)
- Purpose: searchable/filterable dossier archive with verdict/topic/delegate facets.
- APIs:
  - `GET /v1/archive`
  - `GET /v1/archive/facets`
  - `GET /v1/archive/:id`
  - `GET /v1/archive/:id/transcript`
  - `GET /v1/archive/:id/votes`
- DB tables read:
  - `debates`, `resolutions`, `users`, `delegate_votes`, `delegate_models`, `debate_messages`, `human_votes`
- DB tables write:
  - none (read-only screen)

### 5. User Diplomatic Profile (`/profile`)
- Purpose: user dossier, submissions, vote history, alignment statistics.
- APIs:
  - `GET /v1/me/profile`
  - `GET /v1/me/submissions`
  - `GET /v1/me/votes`
  - `GET /v1/me/alignment`
  - `GET /v1/me/stats`
- DB tables read:
  - `users`, `resolutions`, `debates`, `human_votes`
- DB tables write:
  - none directly from reads; writes occur when user votes/submits elsewhere

### 6. Global Alignment Leaderboard (`/leaderboard`)
- Purpose: weekly/monthly/all-time rankings and leaderboard table.
- APIs:
  - `GET /v1/leaderboard`
  - `GET /v1/leaderboard/history`
  - `GET /v1/users/:id/rank-history`
- DB tables read:
  - `users`, `human_votes`, `debates`, `resolutions`, `leaderboard_snapshots`, `leaderboard_entries`
- DB tables write:
  - snapshot generation writes `leaderboard_snapshots`, `leaderboard_entries`

## Supporting Services Already Implemented
- Delegate sync cache + fallback delegates when OpenRouter ranking fetch fails.
- Legacy API compatibility routes:
  - `/api/health`, `/api/agents`, `/api/archive`, `/api/debate`
- Legacy archive bootstrap into SQLite from `data/archive.json` (one-time when DB empty).

## High-Value Next Backend Enhancements (Not Yet Implemented)
- Auth hardening:
  - Replace header-based identity with signed auth (JWT/session provider).
- Query depth:
  - server-side sort parameter + total counts for archive/profile pagination.
- Draft lifecycle:
  - delete draft endpoint (`DELETE /v1/drafts/:id`) and revision history.
- Observability:
  - structured logs, request IDs, metrics export, error tracking hooks.
- Async orchestration:
  - queue-based debate jobs for long-running model calls + retry policy.
- Data durability:
  - production Postgres migration path for Railway (SQLite currently sufficient for prototype).

## Deployment Responsibility Split
- GitHub: source control + CI triggers.
- Vercel: web hosting and stateless Node runtime for fast preview/production deploys.
- Railway: persistent service/runtime suitable for long-running API and durable DB storage.
