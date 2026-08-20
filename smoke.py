"""End-to-end smoke test for erling-open."""
import json
import urllib.request

BASE = "http://localhost:8100"


def call(path, body=None, token="", method=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method=method or ("POST" if data else "GET"),
        headers={"X-Token": token, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.load(res), res.status
    except urllib.error.HTTPError as e:
        return json.load(e), e.code


def main():
    checks = []

    def check(name, ok):
        checks.append((name, ok))
        print(("OK  " if ok else "FAIL"), name)

    t1, _ = call("/api/register", {"name": "Daniel", "emoji": "🎩", "partyCode": "fest"})
    t2, _ = call("/api/register", {"name": "Gunnar", "emoji": "🍷", "partyCode": "fest"})
    t1, t2 = t1["token"], t2["token"]
    _, code = call("/api/register", {"name": "Snik", "partyCode": "feil"})
    check("feil festkode avvist", code == 403)

    _, code = call("/api/admin/unlock", {"code": "hemmelig"}, t1)
    check("admin unlock", code == 200)
    _, code = call("/api/admin/score", {"playerId": 1, "label": "x", "points": 1}, t2)
    check("ikke-admin nektes admin-endepunkt", code == 403)

    state, code = call("/api/state", token=t1)
    check("state svarer (deadlock-regresjonen)", code == 200)

    tech = [z for z in state["quizzes"] if "Tech" in z["name"]][0]
    qid = tech["questions"][0]["id"]
    call("/api/admin/question/update", {"id": qid, "state": "open"}, t1)
    _, code = call("/api/quiz/answer", {"questionId": qid, "value": "2007"}, t1)
    check("svar på åpent spørsmål", code == 200)
    call("/api/quiz/answer", {"questionId": qid, "value": "2009"}, t2)

    state2, _ = call("/api/state", token=t2)
    tech2 = [z for z in state2["quizzes"] if "Tech" in z["name"]][0]
    check("andres svar skjult før reveal", "answers" not in tech2["questions"][0])

    call("/api/admin/question/update", {"id": qid, "state": "revealed"}, t1)
    state3, _ = call("/api/state", token=t2)
    daniel = [p for p in state3["players"] if p["name"] == "Daniel"][0]
    gunnar = [p for p in state3["players"] if p["name"] == "Gunnar"][0]
    check("nærmest-vinner fikk poeng (Daniel 5)", daniel["total"] == 5)
    check("taper fikk 0 (Gunnar)", gunnar["total"] == 0)
    tech3 = [z for z in state3["quizzes"] if "Tech" in z["name"]][0]
    check("svar synlige etter reveal", len(tech3["questions"][0].get("answers", [])) == 2)

    pid = state["predictions"][0]["id"]
    call("/api/predictions/bet", {"predictionId": pid, "value": "11:30"}, t1)
    call("/api/predictions/bet", {"predictionId": pid, "value": "10:15"}, t2)
    call("/api/admin/predictions/lock", None, t1, method="POST")
    _, code = call("/api/predictions/bet", {"predictionId": pid, "value": "12:00"}, t2)
    check("bet etter lås avvist", code == 409)

    call("/api/admin/prediction/resolve", {"id": pid, "fasit": "10:05"}, t1)
    state4, _ = call("/api/state", token=t1)
    gunnar = [p for p in state4["players"] if p["name"] == "Gunnar"][0]
    check("nærmest tid vant spådom (Gunnar 10)", gunnar["total"] == 10)
    pred = state4["predictions"][0]
    check("alle bets synlige etter lås", len(pred.get("bets", [])) == 2)

    # Teams + missions
    call("/api/admin/team", {"name": "Lag Vin"}, t1)
    state5, _ = call("/api/state", token=t1)
    team_id = state5["teams"][0]["id"]
    call("/api/admin/assign-team", {"playerId": gunnar["id"], "teamId": team_id}, t1)
    mid = state5["missions"][0]["id"]
    _, code = call("/api/missions/complete", {"missionId": mid}, t2)
    check("lagmedlem melder oppdrag", code == 200)
    state6, _ = call("/api/state", token=t1)
    done = state6["missions"][0]["teams"][str(team_id)]
    call("/api/admin/mission/review", {"id": done["id"], "approved": True}, t1)
    state7, _ = call("/api/state", token=t1)
    team = state7["teams"][0]
    check("lag fikk oppdragspoeng + medlemspoeng", team["total"] == 10 + 10)

    # Checklist admin-only filtering
    hidden_for_gunnar = all(not c["adminOnly"] for c in call("/api/state", token=t2)[0]["checklist"])
    check("arrangørpunkter skjult for vanlig spiller", hidden_for_gunnar)

    failed = [n for n, ok in checks if not ok]
    print()
    print(f"{len(checks) - len(failed)}/{len(checks)} sjekker OK")
    if failed:
        raise SystemExit(1)


main()
