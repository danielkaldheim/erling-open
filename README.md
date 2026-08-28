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

- **Quizzes** (Erling-quiz, blind tasting): the admin starts a timed quiz,
  opens questions, and reveals the answers. Everyone answers on their phone,
  while `/?display=quiz` provides a large live question view for a laptop,
  iPad or projector. Questions can include an uploaded image or video.
  Multiple choice auto-grades, "closest number wins" auto-grades, and free
  text is graded by the admin with one tap.
- **Prediction market**: everyone bets at breakfast, the admin locks the
  market, and answers resolve naturally during the day ("when does Erling
  take the first shot?"). Closest guess wins; everyone's bets become
  visible once locked.
- **Golf**: preset quick-buttons (closest to pin, longest drive,
  hole-in-one, catastrophe) — the admin taps a player and a button.
- **Photo missions**: teams mark missions complete, the admin approves,
  the team gets the points. Organizers can add and edit missions during the
  day. Photos live in your shared album; the app keeps the score.
- **Checklist**: shared to-dos, plus organizer-only items (surprises).

Registration is name + emoji + a shared party code. No accounts. The
organizer unlocks admin mode with a separate code.

## Run locally

```bash
PARTY_CODE=fest ADMIN_CODE=hemmelig go run .
# open http://localhost:8080
```

Data lands in `./data/erling.db`, and uploaded quiz media in
`./data/uploads/` (override both with `DATA_DIR`).

## Organizer workflow

Unlock **Arrangør** under **Mer**. From there you can edit the time,
activity and address for every schedule entry, and add or update photo
missions. **🧠 Rediger quiz** lists every quiz with its questions: change the
wording, type, options, answer key, points or media, add a question to a quiz,
or delete one (which also removes the answers given to it and the points they
produced). Editing the answer key or points of an already revealed question
recomputes the scores. Whole quizzes can be created, renamed and deleted from
the same card — deleting one takes its questions, answers and points with it. Schedule entries start hidden: everyone else sees only the
clock time until you press **Avslør nå** on that entry (**Skjul igjen**
takes it back). Quiz controls live under **Spill**:

1. Set the duration and press **Start quiz**. The first question opens and
   the server starts enforcing the deadline.
2. Press **Åpne visning** to open `/?display=quiz` on the shared screen.
3. Open/reveal questions as the quiz progresses. Use **Legg til
   bilde/video** on any question to upload media.

The presentation view does not require registration. It only receives the
answer key after the organizer reveals the current question.

## Content

Quiz questions, predictions, photo missions and the schedule are seeded from
[`seed.json`](seed.json) on first boot, then stored in SQLite so organizer
changes persist. Edit the seed before first deploy, or manage the schedule,
missions and questions from the admin UI on the day. Score presets continue
to come directly from the embedded seed on every boot. (The database seed
only runs once; wipe the database or the PVC to re-seed.)

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
