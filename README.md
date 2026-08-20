# 🏌️‍♂️ Erling Open 🍷

Party app for a bachelor party ("utdrikningslag"): shared checklist, live
scoreboard, quizzes, a prediction market, golf quick-scoring and photo
missions. Ten friends, one day, everyone on their own phone.

Single Go binary, SQLite, WebSocket live updates, no-build Vue 3 frontend
(vendored, served embedded). Norwegian UI.

## How it works

Everything that gives points is a **score event** (who, what, how many).
The scoreboard and the live feed are just views over that table, and every
activity is a thin layer on top:

- **Quizzes** (Erling-quiz, tech-quiz, blind tasting): admin opens a
  question → everyone answers on their phone → reveal. Multiple choice
  auto-grades, "closest number wins" auto-grades, free text is graded by
  the admin with one tap.
- **Prediction market**: everyone bets at breakfast, the admin locks the
  market, and answers resolve naturally during the day ("when does Erling
  take the first shot?"). Closest guess wins; everyone's bets become
  visible once locked.
- **Golf**: preset quick-buttons (closest to pin, longest drive,
  hole-in-one, catastrophe) — the admin taps a player and a button.
- **Photo missions**: teams mark missions complete, the admin approves,
  the team gets the points. Photos live in your shared album; the app
  keeps the score.
- **Checklist**: shared to-dos, plus organizer-only items (surprises).

Registration is name + emoji + a shared party code. No accounts. The
organizer unlocks admin mode with a separate code.

## Run locally

```bash
PARTY_CODE=fest ADMIN_CODE=hemmelig go run .
# open http://localhost:8080
```

Data lands in `./data/erling.db` (override with `DATA_DIR`).

## Content

Quiz questions, predictions, photo missions, the schedule and score
presets are seeded from [`seed.json`](seed.json) on first boot. Edit it
before first deploy — or add questions from the admin UI on the day.
(The seed only runs once; wipe the database or the PVC to re-seed.)

## Deploy

GitHub Actions builds `ghcr.io/danielkaldheim/erling-open` on every push
to `main`. Kubernetes manifests are in [`k8s/`](k8s/erling-open.yaml):

```bash
kubectl -n crudus-apps create secret generic erling-open-secrets \
  --from-literal=PARTY_CODE=... --from-literal=ADMIN_CODE=...
kubectl apply -f k8s/erling-open.yaml
```

## Env

| Variable | Meaning |
|---|---|
| `PORT` | Listen port (default 8080) |
| `DATA_DIR` | SQLite directory (default `./data`) |
| `PARTY_CODE` | Shared code required to register (empty = open) |
| `ADMIN_CODE` | Code that unlocks organizer mode |
