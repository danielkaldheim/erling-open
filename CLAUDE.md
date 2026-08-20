# CLAUDE.md

Party app for a bachelor party: shared checklist, live scoreboard, quizzes,
prediction market, golf quick-scoring, photo missions. 10 users, one day,
phones only. **UI language is Norwegian (bokmål)** — keep it that way.

## Commands

```bash
# Run locally (data lands in ./data/erling.db)
PARTY_CODE=fest ADMIN_CODE=hemmelig go run .

# Build
go build ./... && go vet ./...

# End-to-end smoke test (expects a server with the codes above on :8100)
PORT=8100 PARTY_CODE=fest ADMIN_CODE=hemmelig go run .   # terminal 1
python smoke.py                                          # terminal 2, if present
```

Deploy: GitHub Actions builds `ghcr.io/danielkaldheim/erling-open` on push
to `main`; apply `k8s/erling-open.yaml` (namespace `crudus-apps`, host
`erling.crudus.dev`). Secrets `PARTY_CODE`/`ADMIN_CODE` live in the
`erling-open-secrets` k8s secret — never in the repo.

## Architecture

- **Single Go binary**, stdlib mux with method patterns (`POST /api/...`),
  `go:embed`-ed frontend, SQLite via `modernc.org/sqlite` (pure Go, no cgo).
- **Everything that gives points is a `score_events` row** (player/team,
  activity, label, points, `ref`). The scoreboard and feed are views over
  it; activities are thin layers that insert rows. Idempotent rescoring:
  delete by `ref` (`q:<id>`, `p:<id>`, `m:<id>`), then re-insert.
- **WebSocket = dumb poke channel** (`hub.go`): every mutation broadcasts
  `{"type":"update"}`; clients refetch `GET /api/state` (debounced 200 ms,
  30 s polling fallback). All filtering happens server-side in
  `handleState` based on the `X-Token` header.
- **Frontend is no-build**: `static/app.js` is one Vue 3 root component
  with a template string, using the vendored **full** build
  (`vue.esm-browser.prod.js` — includes the template compiler; don't swap
  it for the runtime-only build). No npm, no bundler.
- **Auth**: register with name + emoji + `PARTY_CODE` → token in
  localStorage. `ADMIN_CODE` flips `is_admin` on a player. That's all —
  the threat model is ten friends at a party.

## Gotchas (learned the hard way)

- `db.SetMaxOpenConns(1)`: **never run a nested query while a `rows`
  iterator is open** — it deadlocks the whole server permanently. Buffer
  rows into a slice, `Close()`, then do per-row lookups. See
  `quizzesState`/`predictionsState` in `api.go`.
- `seed.json` is applied **once** (guarded by `meta.seeded`). Editing it
  later does nothing for existing databases — change content via the admin
  UI, or wipe the DB/PVC to re-seed. Schedule and score presets are the
  exception: they're served straight from the embedded file on every boot.
- Question/prediction lifecycles are one-way for players but reversible
  for the admin: un-revealing a question or re-grading after reveal
  withdraws/recomputes points via the `ref` mechanism.
- Numeric answers accept `HH:MM` (parsed as minutes) and comma decimals
  (`parseNumeric` in `api.go`).
- The k8s Deployment uses `strategy: Recreate` on purpose (SQLite on a
  RWO volume — no rolling overlap). Keep replicas at 1.
- The repo is public: `seed.json` contains the day's quiz questions and
  missions, so don't commit real answer keys (`answer` fields) — set them
  through the admin UI on the day.
