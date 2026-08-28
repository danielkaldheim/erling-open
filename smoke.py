"""End-to-end smoke test for erling-open."""
import base64
import json
import time
import urllib.error
import urllib.request
import uuid

BASE = "http://localhost:8100"


def call(path, body=None, token="", method=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method or ("POST" if data else "GET"),
        headers={"X-Token": token, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.load(res), res.status
    except urllib.error.HTTPError as error:
        return json.load(error), error.code


def upload(path, filename, content, content_type, token):
    boundary = "----erling-" + uuid.uuid4().hex
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode() + content + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        BASE + path,
        data=body,
        method="POST",
        headers={"X-Token": token, "Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.load(res), res.status
    except urllib.error.HTTPError as error:
        return json.load(error), error.code


def main():
    checks = []

    def check(name, ok):
        checks.append((name, ok))
        print(("OK  " if ok else "FAIL"), name)

    player1, _ = call("/api/register", {"name": "Daniel", "emoji": "🎩", "partyCode": "fest"})
    player2, _ = call("/api/register", {"name": "Gunnar", "emoji": "🍷", "partyCode": "fest"})
    token1, token2 = player1["token"], player2["token"]
    _, code = call("/api/register", {"name": "Snik", "partyCode": "feil"})
    check("feil festkode avvist", code == 403)

    # Same name and emoji is the same person on a new phone, not a new player.
    again, code = call("/api/register", {"name": "Daniel", "emoji": "🎩", "partyCode": "fest"})
    twin, _ = call("/api/register", {"name": "Daniel", "emoji": "🚀", "partyCode": "fest"})
    roster, _ = call("/api/state", token=token1)
    check(
        "samme navn og merke gjenbruker spilleren",
        code == 200
        and again["playerId"] == player1["playerId"]
        and again["token"] == token1
        and again.get("returning") is True
        and len([p for p in roster["players"] if p["name"] == "Daniel"]) == 2
        and twin["playerId"] != player1["playerId"],
    )

    _, code = call("/api/admin/unlock", {"code": "hemmelig"}, token1)
    check("admin unlock", code == 200)
    _, code = call("/api/admin/score", {"playerId": player1["playerId"], "label": "x", "points": 1}, token2)
    check("ikke-admin nektes admin-endepunkt", code == 403)

    # An organizer's name+emoji is not enough to take over their player.
    _, no_code = call("/api/register", {"name": "Daniel", "emoji": "🎩", "partyCode": "fest"})
    _, wrong_code = call(
        "/api/register",
        {"name": "Daniel", "emoji": "🎩", "partyCode": "fest", "adminCode": "gjett"},
    )
    back, right_code = call(
        "/api/register",
        {"name": "Daniel", "emoji": "🎩", "partyCode": "fest", "adminCode": "hemmelig"},
    )
    check(
        "arrangørnavn krever arrangørkode",
        no_code == 403 and wrong_code == 403
        and right_code == 200 and back["token"] == token1,
    )

    state, code = call("/api/state", token=token1)
    check("state svarer (deadlock-regresjonen)", code == 200)

    # Persistent, organizer-editable schedule.
    first_slot = state["schedule"][0]
    updated_slot = {
        "id": first_slot["id"], "time": "09:45", "title": "Oppdatert frokost",
        "where": "Ny adresse 1", "icon": "🥐",
    }
    _, code = call("/api/admin/schedule/update", updated_slot, token1)
    participant_state, _ = call("/api/state", token=token2)
    hidden_slot = participant_state["schedule"][0]
    check(
        "uavslørt aktivitet viser bare klokkeslett",
        code == 200
        and hidden_slot["time"] == "09:45"
        and hidden_slot["revealed"] is False
        and hidden_slot["title"] == ""
        and hidden_slot["where"] == "",
    )

    _, code = call(
        "/api/admin/schedule/reveal", {"id": first_slot["id"], "revealed": True}, token1,
    )
    participant_state, _ = call("/api/state", token=token2)
    check(
        "arrangøren avslører aktivitet og adresse",
        code == 200
        and participant_state["schedule"][0]["title"] == "Oppdatert frokost"
        and participant_state["schedule"][0]["where"] == "Ny adresse 1",
    )

    call("/api/admin/schedule/reveal", {"id": first_slot["id"], "revealed": False}, token1)
    participant_state, _ = call("/api/state", token=token2)
    check(
        "avsløring kan angres",
        participant_state["schedule"][0]["title"] == "",
    )

    # Quiz editor: quizzes can be created, renamed and deleted.
    created_quiz, code = call("/api/admin/quiz", {"name": "Testquiz"}, token1)
    _, rename_code = call(
        "/api/admin/quiz/update", {"id": created_quiz["id"], "name": "Endret quiz"}, token1,
    )
    quiz_state, _ = call("/api/state", token=token2)
    renamed = next((z for z in quiz_state["quizzes"] if z["id"] == created_quiz["id"]), None)
    check(
        "quiz kan opprettes og få nytt navn",
        code == 200 and rename_code == 200 and renamed is not None
        and renamed["name"] == "Endret quiz" and renamed["status"] == "idle",
    )

    call(
        "/api/admin/question",
        {"quizId": created_quiz["id"], "text": "Slettes med quizen", "type": "text", "points": 4},
        token1,
    )
    _, code = call("/api/admin/quiz/delete", {"id": created_quiz["id"]}, token1)
    after_delete, _ = call("/api/state", token=token1)
    _, missing_quiz_code = call("/api/admin/quiz/delete", {"id": created_quiz["id"]}, token1)
    check(
        "quiz kan slettes med spørsmålene sine",
        code == 200 and missing_quiz_code == 404
        and not any(z["id"] == created_quiz["id"] for z in after_delete["quizzes"])
        and not any(
            q["text"] == "Slettes med quizen" for z in after_delete["quizzes"] for q in z["questions"]
        ),
    )

    # Quiz editor: add, edit and remove a question.
    editor_quiz = state["quizzes"][0]
    _, code = call(
        "/api/admin/question",
        {"quizId": editor_quiz["id"], "text": "Testspørsmål", "type": "choice",
         "options": ["A", "B"], "answer": "A", "points": 3}, token1,
    )
    admin_state, _ = call("/api/state", token=token1)
    added = next(
        (q for z in admin_state["quizzes"] if z["id"] == editor_quiz["id"]
         for q in z["questions"] if q["text"] == "Testspørsmål"), None,
    )
    check("spørsmål kan legges til", code == 200 and added is not None and added["points"] == 3)

    _, code = call(
        "/api/admin/question/update",
        {"id": added["id"], "text": "Endret spørsmål", "options": ["A", "B", "C"], "points": 7}, token1,
    )
    admin_state, _ = call("/api/state", token=token1)
    edited = next(
        q for z in admin_state["quizzes"] if z["id"] == editor_quiz["id"]
        for q in z["questions"] if q["id"] == added["id"]
    )
    check(
        "spørsmål kan endres",
        code == 200 and edited["text"] == "Endret spørsmål"
        and edited["points"] == 7 and edited["options"] == ["A", "B", "C"],
    )

    _, code = call("/api/admin/question/delete", {"id": added["id"]}, token1)
    admin_state, _ = call("/api/state", token=token1)
    still_there = any(
        q["id"] == added["id"] for z in admin_state["quizzes"] for q in z["questions"]
    )
    _, missing_code = call("/api/admin/question/delete", {"id": added["id"]}, token1)
    check(
        "spørsmål kan slettes",
        code == 200 and not still_there and missing_code == 404,
    )

    # Start a timed quiz and select a numeric question for deterministic scoring.
    quiz = next(z for z in state["quizzes"] if any(q["type"] == "number" for q in z["questions"]))
    question = next(q for q in quiz["questions"] if q["type"] == "number")
    _, code = call(
        "/api/admin/quiz/control",
        {"id": quiz["id"], "action": "start", "durationSeconds": 120}, token1,
    )
    call("/api/admin/question/update", {"id": question["id"], "answer": "2007", "state": "open"}, token1)
    started_state, _ = call("/api/state", token=token1)
    started_quiz = next(z for z in started_state["quizzes"] if z["id"] == quiz["id"])
    check(
        "quiz kan startes med tidsfrist",
        code == 200 and started_quiz["status"] == "active"
        and started_quiz["durationSeconds"] == 120
        and started_quiz["currentQuestionId"] == question["id"],
    )

    # Upload and attach media to an existing question.
    one_pixel_png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    )
    media, code = upload("/api/admin/media", "test.png", one_pixel_png, "image/png", token1)
    if code == 200:
        _, code = call(
            "/api/admin/question/update",
            {"id": question["id"], "mediaUrl": media["url"], "mediaType": media["type"]}, token1,
        )
    media_state, _ = call("/api/state", token=token2)
    media_question = next(q for z in media_state["quizzes"] for q in z["questions"] if q["id"] == question["id"])
    with urllib.request.urlopen(BASE + media["url"], timeout=10) as uploaded_file:
        uploaded_file_ok = uploaded_file.status == 200 and uploaded_file.headers.get_content_type() == "image/png"
    check(
        "bilde kan lastes opp og vises på spørsmål",
        code == 200 and media_question["mediaType"] == "image" and uploaded_file_ok,
    )

    _, code = call("/api/quiz/answer", {"questionId": question["id"], "value": "2007"}, token1)
    check("svar på åpent spørsmål", code == 200)
    call("/api/quiz/answer", {"questionId": question["id"], "value": "2009"}, token2)

    state2, _ = call("/api/state", token=token2)
    q2 = next(q for z in state2["quizzes"] for q in z["questions"] if q["id"] == question["id"])
    check("andres svar skjult før reveal", "answers" not in q2 and q2["answerCount"] == 2)

    call("/api/admin/question/update", {"id": question["id"], "state": "revealed"}, token1)
    state3, _ = call("/api/state", token=token2)
    daniel = next(p for p in state3["players"] if p["name"] == "Daniel")
    gunnar = next(p for p in state3["players"] if p["name"] == "Gunnar")
    check("nærmest-vinner fikk poeng (Daniel 5)", daniel["total"] == question["points"])
    check("taper fikk 0 (Gunnar)", gunnar["total"] == 0)
    q3 = next(q for z in state3["quizzes"] for q in z["questions"] if q["id"] == question["id"])
    check("svar synlige etter reveal", len(q3.get("answers", [])) == 2)

    # Editing a revealed question from the quiz editor recomputes its points.
    call("/api/admin/question/update", {"id": question["id"], "points": 9}, token1)
    rescored, _ = call("/api/state", token=token1)
    daniel_rescored = next(p for p in rescored["players"] if p["name"] == "Daniel")
    check("endret poengverdi etter reveal regnes om", daniel_rescored["total"] == 9)
    call("/api/admin/question/update", {"id": question["id"], "points": question["points"]}, token1)

    with urllib.request.urlopen(BASE + "/?display=quiz", timeout=10) as display:
        check("quizvisning kan åpnes på egen skjerm", display.status == 200 and b'id="app"' in display.read())

    pid = state["predictions"][0]["id"]
    call("/api/predictions/bet", {"predictionId": pid, "value": "11:30"}, token1)
    call("/api/predictions/bet", {"predictionId": pid, "value": "10:15"}, token2)
    call("/api/admin/predictions/lock", None, token1, method="POST")
    _, code = call("/api/predictions/bet", {"predictionId": pid, "value": "12:00"}, token2)
    check("bet etter lås avvist", code == 409)

    call("/api/admin/prediction/resolve", {"id": pid, "fasit": "10:05"}, token1)
    state4, _ = call("/api/state", token=token1)
    gunnar = next(p for p in state4["players"] if p["name"] == "Gunnar")
    check("nærmest tid vant spådom (Gunnar 10)", gunnar["total"] == 10)
    check("alle bets synlige etter lås", len(state4["predictions"][0].get("bets", [])) == 2)

    # Missions can be created and edited, including approved-score recalculation.
    _, code = call("/api/admin/mission", {"text": "Nytt testoppdrag", "points": 12}, token1)
    mission_state, _ = call("/api/state", token=token1)
    mission = mission_state["missions"][-1]
    _, update_code = call(
        "/api/admin/mission/update",
        {"id": mission["id"], "text": "Oppdatert testoppdrag", "points": 12}, token1,
    )
    check("oppdrag kan legges til og oppdateres", code == 200 and update_code == 200)

    call("/api/admin/team", {"name": "Lag Vin"}, token1)
    state5, _ = call("/api/state", token=token1)
    team_id = state5["teams"][0]["id"]
    call("/api/admin/assign-team", {"playerId": gunnar["id"], "teamId": team_id}, token1)
    call("/api/missions/complete", {"missionId": mission["id"]}, token2)
    state6, _ = call("/api/state", token=token1)
    saved_mission = next(m for m in state6["missions"] if m["id"] == mission["id"])
    done = saved_mission["teams"][str(team_id)]
    call("/api/admin/mission/review", {"id": done["id"], "approved": True}, token1)
    call(
        "/api/admin/mission/update",
        {"id": mission["id"], "text": "Oppdatert testoppdrag", "points": 14}, token1,
    )
    state7, _ = call("/api/state", token=token1)
    team = state7["teams"][0]
    check("godkjente oppdragspoeng følger oppdatert verdi", team["total"] == 10 + 14)

    # Deadline is enforced by the server, not only by the visible countdown.
    call(
        "/api/admin/quiz/control",
        {"id": quiz["id"], "action": "start", "durationSeconds": 1}, token1,
    )
    call("/api/admin/question/update", {"id": question["id"], "state": "open"}, token1)
    time.sleep(1.2)
    _, code = call("/api/quiz/answer", {"questionId": question["id"], "value": "sent"}, token2)
    expired_state, _ = call("/api/state", token=token2)
    expired_quiz = next(z for z in expired_state["quizzes"] if z["id"] == quiz["id"])
    check("svar avvises når quiztiden er ute", code == 409 and expired_quiz["status"] == "expired")

    hidden_for_gunnar = all(not item["adminOnly"] for item in expired_state["checklist"])
    check("arrangørpunkter skjult for vanlig spiller", hidden_for_gunnar)

    failed = [name for name, ok in checks if not ok]
    print()
    print(f"{len(checks) - len(failed)}/{len(checks)} sjekker OK")
    if failed:
        raise SystemExit(1)


main()
