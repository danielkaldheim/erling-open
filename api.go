package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type Server struct {
	db        *sql.DB
	hub       *Hub
	seed      *Seed
	partyCode string
	adminCode string
}

type player struct {
	ID      int64  `json:"id"`
	Name    string `json:"name"`
	Emoji   string `json:"emoji"`
	TeamID  *int64 `json:"teamId"`
	IsAdmin bool   `json:"isAdmin"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func decode(r *http.Request, v any) error {
	return json.NewDecoder(http.MaxBytesReader(nil, r.Body, 64<<10)).Decode(v)
}

func newToken() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// currentPlayer resolves the X-Token header; nil when unauthenticated.
func (s *Server) currentPlayer(r *http.Request) *player {
	token := r.Header.Get("X-Token")
	if token == "" {
		return nil
	}
	var p player
	var admin int
	err := s.db.QueryRow(
		`SELECT id, name, emoji, team_id, is_admin FROM players WHERE token = ?`, token,
	).Scan(&p.ID, &p.Name, &p.Emoji, &p.TeamID, &admin)
	if err != nil {
		return nil
	}
	p.IsAdmin = admin == 1
	return &p
}

// withPlayer / withAdmin wrap handlers with token resolution.
func (s *Server) withPlayer(fn func(http.ResponseWriter, *http.Request, *player)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p := s.currentPlayer(r)
		if p == nil {
			httpError(w, http.StatusUnauthorized, "ukjent spiller – registrer deg på nytt")
			return
		}
		fn(w, r, p)
	}
}

func (s *Server) withAdmin(fn func(http.ResponseWriter, *http.Request, *player)) http.HandlerFunc {
	return s.withPlayer(func(w http.ResponseWriter, r *http.Request, p *player) {
		if !p.IsAdmin {
			httpError(w, http.StatusForbidden, "krever arrangørmodus")
			return
		}
		fn(w, r, p)
	})
}

// --- Registration and roles ---

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name      string `json:"name"`
		Emoji     string `json:"emoji"`
		PartyCode string `json:"partyCode"`
	}
	if err := decode(r, &body); err != nil || strings.TrimSpace(body.Name) == "" {
		httpError(w, http.StatusBadRequest, "navn mangler")
		return
	}
	if s.partyCode != "" && !strings.EqualFold(strings.TrimSpace(body.PartyCode), s.partyCode) {
		httpError(w, http.StatusForbidden, "feil festkode")
		return
	}
	emoji := body.Emoji
	if emoji == "" {
		emoji = "🍺"
	}
	token := newToken()
	res, err := s.db.Exec(
		`INSERT INTO players (name, emoji, token) VALUES (?, ?, ?)`,
		strings.TrimSpace(body.Name), emoji, token,
	)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	id, _ := res.LastInsertId()
	s.hub.Poke()
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "playerId": id})
}

func (s *Server) handleUnlockAdmin(w http.ResponseWriter, r *http.Request, p *player) {
	var body struct {
		Code string `json:"code"`
	}
	if err := decode(r, &body); err != nil {
		httpError(w, http.StatusBadRequest, "ugyldig forespørsel")
		return
	}
	if s.adminCode == "" || !strings.EqualFold(strings.TrimSpace(body.Code), s.adminCode) {
		httpError(w, http.StatusForbidden, "feil arrangørkode")
		return
	}
	s.db.Exec(`UPDATE players SET is_admin = 1 WHERE id = ?`, p.ID)
	s.hub.Poke()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// --- Teams ---

func (s *Server) handleCreateTeam(w http.ResponseWriter, r *http.Request, _ *player) {
	var body struct {
		Name string `json:"name"`
	}
	if err := decode(r, &body); err != nil || strings.TrimSpace(body.Name) == "" {
		httpError(w, http.StatusBadRequest, "lagnavn mangler")
		return
	}
	s.db.Exec(`INSERT INTO teams (name) VALUES (?)`, strings.TrimSpace(body.Name))
	s.hub.Poke()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleAssignTeam(w http.ResponseWriter, r *http.Request, _ *player) {
	var body struct {
		PlayerID int64  `json:"playerId"`
		TeamID   *int64 `json:"teamId"`
	}
	if err := decode(r, &body); err != nil {
		httpError(w, http.StatusBadRequest, "ugyldig forespørsel")
		return
	}
	s.db.Exec(`UPDATE players SET team_id = ? WHERE id = ?`, body.TeamID, body.PlayerID)
	s.hub.Poke()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// --- Checklist ---

func (s *Server) handleChecklistAdd(w http.ResponseWriter, r *http.Request, p *player) {
	var body struct {
		Text      string `json:"text"`
		AdminOnly bool   `json:"adminOnly"`
	}
	if err := decode(r, &body); err != nil || strings.TrimSpace(body.Text) == "" {
		httpError(w, http.StatusBadRequest, "tekst mangler")
		return
	}
	adminOnly := 0
	if body.AdminOnly && p.IsAdmin {
		adminOnly = 1
	}
	s.db.Exec(`INSERT INTO checklist (text, admin_only) VALUES (?, ?)`, strings.TrimSpace(body.Text), adminOnly)
	s.hub.Poke()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleChecklistToggle(w http.ResponseWriter, r *http.Request, p *player) {
	var body struct {
		ID int64 `json:"id"`
	}
	if err := decode(r, &body); err != nil {
		httpError(w, http.StatusBadRequest, "ugyldig forespørsel")
		return
	}
	s.db.Exec(
		`UPDATE checklist SET done = 1 - done, done_by = CASE done WHEN 0 THEN ? ELSE NULL END WHERE id = ?`,
		p.ID, body.ID,
	)
	s.hub.Poke()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// --- Manual scores (golf quick-entry and everything else) ---

func (s *Server) handleScoreAdd(w http.ResponseWriter, r *http.Request, _ *player) {
	var body struct {
		PlayerID *int64 `json:"playerId"`
		TeamID   *int64 `json:"teamId"`
		Activity string `json:"activity"`
		Label    string `json:"label"`
		Points   int    `json:"points"`
	}
	if err := decode(r, &body); err != nil || (body.PlayerID == nil && body.TeamID == nil) || body.Label == "" {
		httpError(w, http.StatusBadRequest, "mangler mottaker eller beskrivelse")
		return
	}
	if body.Activity == "" {
		body.Activity = "dagen"
	}
	s.db.Exec(
		`INSERT INTO score_events (player_id, team_id, activity, label, points) VALUES (?, ?, ?, ?, ?)`,
		body.PlayerID, body.TeamID, body.Activity, body.Label, body.Points,
	)
	s.hub.Poke()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleScoreDelete(w http.ResponseWriter, r *http.Request, _ *player) {
	var body struct {
		ID int64 `json:"id"`
	}
	if err := decode(r, &body); err != nil {
		httpError(w, http.StatusBadRequest, "ugyldig forespørsel")
		return
	}
	s.db.Exec(`DELETE FROM score_events WHERE id = ?`, body.ID)
	s.hub.Poke()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// --- Quiz ---

func (s *Server) handleQuestionAdd(w http.ResponseWriter, r *http.Request, _ *player) {
	var body struct {
		QuizID  int64    `json:"quizId"`
		Text    string   `json:"text"`
		Type    string   `json:"type"`
		Options []string `json:"options"`
		Answer  string   `json:"answer"`
		Points  int      `json:"points"`
	}
	if err := decode(r, &body); err != nil || strings.TrimSpace(body.Text) == "" {
		httpError(w, http.StatusBadRequest, "spørsmål mangler")
		return
	}
	if body.Type == "" {
		body.Type = "choice"
	}
	if body.Points == 0 {
		body.Points = 5
	}
	options, _ := json.Marshal(body.Options)
	s.db.Exec(
		`INSERT INTO questions (quiz_id, sort, text, qtype, options, answer, points)
		 VALUES (?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM questions WHERE quiz_id = ?), ?, ?, ?, ?, ?)`,
		body.QuizID, body.QuizID, strings.TrimSpace(body.Text), body.Type, string(options), body.Answer, body.Points,
	)
	s.hub.Poke()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleQuestionUpdate(w http.ResponseWriter, r *http.Request, _ *player) {
	var body struct {
		ID     int64   `json:"id"`
		Answer *string `json:"answer"`
		State  *string `json:"state"` // hidden | open | revealed
	}
	if err := decode(r, &body); err != nil {
		httpError(w, http.StatusBadRequest, "ugyldig forespørsel")
		return
	}
	if body.Answer != nil {
		s.db.Exec(`UPDATE questions SET answer = ? WHERE id = ?`, *body.Answer, body.ID)
	}
	if body.State != nil {
		switch *body.State {
		case "hidden", "open", "revealed":
		default:
			httpError(w, http.StatusBadRequest, "ugyldig tilstand")
			return
		}
		s.db.Exec(`UPDATE questions SET state = ? WHERE id = ?`, *body.State, body.ID)
		if *body.State == "revealed" {
			s.scoreQuestion(body.ID)
		} else {
			// Un-revealing (correcting a mistake) withdraws the points.
			s.db.Exec(`DELETE FROM score_events WHERE ref = ?`, questionRef(body.ID))
		}
	}
	s.hub.Poke()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleAnswer(w http.ResponseWriter, r *http.Request, p *player) {
	var body struct {
		QuestionID int64  `json:"questionId"`
		Value      string `json:"value"`
	}
	if err := decode(r, &body); err != nil || strings.TrimSpace(body.Value) == "" {
		httpError(w, http.StatusBadRequest, "svar mangler")
		return
	}
	var state string
	if err := s.db.QueryRow(`SELECT state FROM questions WHERE id = ?`, body.QuestionID).Scan(&state); err != nil {
		httpError(w, http.StatusNotFound, "ukjent spørsmål")
		return
	}
	if state != "open" {
		httpError(w, http.StatusConflict, "spørsmålet er ikke åpent")
		return
	}
	s.db.Exec(
		`INSERT INTO answers (question_id, player_id, value) VALUES (?, ?, ?)
		 ON CONFLICT (question_id, player_id) DO UPDATE SET value = excluded.value, correct = NULL`,
		body.QuestionID, p.ID, strings.TrimSpace(body.Value),
	)
	s.hub.Poke()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleGradeAnswer(w http.ResponseWriter, r *http.Request, _ *player) {
	var body struct {
		AnswerID int64 `json:"answerId"`
		Correct  bool  `json:"correct"`
	}
	if err := decode(r, &body); err != nil {
		httpError(w, http.StatusBadRequest, "ugyldig forespørsel")
		return
	}
	correct := 0
	if body.Correct {
		correct = 1
	}
	s.db.Exec(`UPDATE answers SET correct = ? WHERE id = ?`, correct, body.AnswerID)
	// Regrading after reveal recomputes the points.
	var questionID int64
	var state string
	if err := s.db.QueryRow(
		`SELECT q.id, q.state FROM questions q JOIN answers a ON a.question_id = q.id WHERE a.id = ?`,
		body.AnswerID,
	).Scan(&questionID, &state); err == nil && state == "revealed" {
		s.scoreQuestion(questionID)
	}
	s.hub.Poke()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func questionRef(id int64) string { return "q:" + strconv.FormatInt(id, 10) }

// scoreQuestion converts a revealed question's answers into score events.
// It replaces any previous scoring for the question, so re-reveals and
// regrades stay idempotent.
func (s *Server) scoreQuestion(questionID int64) {
	var quizName, text, qtype, fasit string
	var points int
	err := s.db.QueryRow(
		`SELECT z.name, q.text, q.qtype, q.answer, q.points FROM questions q JOIN quizzes z ON z.id = q.quiz_id WHERE q.id = ?`,
		questionID,
	).Scan(&quizName, &text, &qtype, &fasit, &points)
	if err != nil {
		return
	}

	rows, err := s.db.Query(`SELECT player_id, value, correct FROM answers WHERE question_id = ?`, questionID)
	if err != nil {
		return
	}
	type ans struct {
		playerID int64
		value    string
		correct  sql.NullInt64
	}
	var answers []ans
	for rows.Next() {
		var a ans
		rows.Scan(&a.playerID, &a.value, &a.correct)
		answers = append(answers, a)
	}
	rows.Close()

	var winners []int64
	switch qtype {
	case "choice":
		for _, a := range answers {
			if fasit != "" && strings.EqualFold(a.value, fasit) {
				winners = append(winners, a.playerID)
			}
		}
	case "number":
		guesses := make([]guess, 0, len(answers))
		for _, a := range answers {
			guesses = append(guesses, guess{a.playerID, a.value})
		}
		winners = nearestPlayers(guesses, fasit)
	case "text":
		for _, a := range answers {
			if a.correct.Valid && a.correct.Int64 == 1 {
				winners = append(winners, a.playerID)
			}
		}
	}

	ref := questionRef(questionID)
	s.db.Exec(`DELETE FROM score_events WHERE ref = ?`, ref)
	label := quizName + ": " + text
	for _, playerID := range winners {
		s.db.Exec(
			`INSERT INTO score_events (player_id, activity, label, points, ref) VALUES (?, 'quiz', ?, ?, ?)`,
			playerID, label, points, ref,
		)
	}
}

type guess struct {
	playerID int64
	value    string
}

// nearestPlayers returns every player whose numeric guess ties for the
// smallest distance to the answer. Ties share the full points.
func nearestPlayers(guesses []guess, fasit string) []int64 {
	target, err := parseNumeric(fasit)
	if err != nil {
		return nil
	}
	best := math.Inf(1)
	var winners []int64
	for _, g := range guesses {
		v, err := parseNumeric(g.value)
		if err != nil {
			continue
		}
		d := math.Abs(v - target)
		switch {
		case d < best:
			best = d
			winners = []int64{g.playerID}
		case d == best:
			winners = append(winners, g.playerID)
		}
	}
	return winners
}

// parseNumeric accepts plain numbers and HH:MM clock times (as minutes).
func parseNumeric(s string) (float64, error) {
	s = strings.TrimSpace(strings.ReplaceAll(s, ",", "."))
	if h, m, ok := strings.Cut(s, ":"); ok {
		hh, err1 := strconv.Atoi(strings.TrimSpace(h))
		mm, err2 := strconv.Atoi(strings.TrimSpace(m))
		if err1 == nil && err2 == nil {
			return float64(hh*60 + mm), nil
		}
	}
	return strconv.ParseFloat(s, 64)
}

// --- Predictions ---

func (s *Server) handleBet(w http.ResponseWriter, r *http.Request, p *player) {
	var body struct {
		PredictionID int64  `json:"predictionId"`
		Value        string `json:"value"`
	}
	if err := decode(r, &body); err != nil || strings.TrimSpace(body.Value) == "" {
		httpError(w, http.StatusBadRequest, "svar mangler")
		return
	}
	var state string
	if err := s.db.QueryRow(`SELECT state FROM predictions WHERE id = ?`, body.PredictionID).Scan(&state); err != nil {
		httpError(w, http.StatusNotFound, "ukjent spådom")
		return
	}
	if state != "open" {
		httpError(w, http.StatusConflict, "spådommene er låst")
		return
	}
	s.db.Exec(
		`INSERT INTO bets (prediction_id, player_id, value) VALUES (?, ?, ?)
		 ON CONFLICT (prediction_id, player_id) DO UPDATE SET value = excluded.value`,
		body.PredictionID, p.ID, strings.TrimSpace(body.Value),
	)
	s.hub.Poke()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handlePredictionsLock(w http.ResponseWriter, r *http.Request, _ *player) {
	s.db.Exec(`UPDATE predictions SET state = 'locked' WHERE state = 'open'`)
	s.hub.Poke()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handlePredictionResolve(w http.ResponseWriter, r *http.Request, _ *player) {
	var body struct {
		ID    int64  `json:"id"`
		Fasit string `json:"fasit"`
	}
	if err := decode(r, &body); err != nil || strings.TrimSpace(body.Fasit) == "" {
		httpError(w, http.StatusBadRequest, "fasit mangler")
		return
	}
	fasit := strings.TrimSpace(body.Fasit)

	var text, ptype string
	var points int
	if err := s.db.QueryRow(`SELECT text, ptype, points FROM predictions WHERE id = ?`, body.ID).Scan(&text, &ptype, &points); err != nil {
		httpError(w, http.StatusNotFound, "ukjent spådom")
		return
	}
	s.db.Exec(`UPDATE predictions SET state = 'resolved', fasit = ? WHERE id = ?`, fasit, body.ID)

	rows, err := s.db.Query(`SELECT player_id, value FROM bets WHERE prediction_id = ?`, body.ID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	var guesses []guess
	for rows.Next() {
		var g guess
		rows.Scan(&g.playerID, &g.value)
		guesses = append(guesses, g)
	}
	rows.Close()

	var winners []int64
	if ptype == "choice" {
		for _, g := range guesses {
			if strings.EqualFold(g.value, fasit) {
				winners = append(winners, g.playerID)
			}
		}
	} else {
		winners = nearestPlayers(guesses, fasit)
	}

	ref := "p:" + strconv.FormatInt(body.ID, 10)
	s.db.Exec(`DELETE FROM score_events WHERE ref = ?`, ref)
	for _, playerID := range winners {
		s.db.Exec(
			`INSERT INTO score_events (player_id, activity, label, points, ref) VALUES (?, 'prediction', ?, ?, ?)`,
			playerID, "Spådom: "+text, points, ref,
		)
	}
	s.hub.Poke()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// --- Photo missions ---

func (s *Server) handleMissionComplete(w http.ResponseWriter, r *http.Request, p *player) {
	var body struct {
		MissionID int64 `json:"missionId"`
	}
	if err := decode(r, &body); err != nil {
		httpError(w, http.StatusBadRequest, "ugyldig forespørsel")
		return
	}
	if p.TeamID == nil {
		httpError(w, http.StatusConflict, "du er ikke på et lag ennå")
		return
	}
	s.db.Exec(
		`INSERT INTO mission_done (mission_id, team_id, player_id) VALUES (?, ?, ?)
		 ON CONFLICT (mission_id, team_id) DO NOTHING`,
		body.MissionID, *p.TeamID, p.ID,
	)
	s.hub.Poke()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleMissionReview(w http.ResponseWriter, r *http.Request, _ *player) {
	var body struct {
		ID       int64 `json:"id"` // mission_done id
		Approved bool  `json:"approved"`
	}
	if err := decode(r, &body); err != nil {
		httpError(w, http.StatusBadRequest, "ugyldig forespørsel")
		return
	}
	state := "rejected"
	if body.Approved {
		state = "approved"
	}
	s.db.Exec(`UPDATE mission_done SET state = ? WHERE id = ?`, state, body.ID)

	ref := "m:" + strconv.FormatInt(body.ID, 10)
	s.db.Exec(`DELETE FROM score_events WHERE ref = ?`, ref)
	if body.Approved {
		var teamID int64
		var text string
		var points int
		if err := s.db.QueryRow(
			`SELECT d.team_id, m.text, m.points FROM mission_done d JOIN missions m ON m.id = d.mission_id WHERE d.id = ?`,
			body.ID,
		).Scan(&teamID, &text, &points); err == nil {
			s.db.Exec(
				`INSERT INTO score_events (team_id, activity, label, points, ref) VALUES (?, 'foto', ?, ?, ?)`,
				teamID, "Fotooppdrag: "+text, points, ref,
			)
		}
	}
	s.hub.Poke()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// --- State ---

// handleState assembles the whole app state, filtered for the requesting
// player: other players' quiz answers and the fasit stay hidden until
// reveal, everyone's bets become visible once predictions lock, and the
// admin sees everything plus the admin-only checklist.
func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	p := s.currentPlayer(r) // nil is fine: pre-registration view
	isAdmin := p != nil && p.IsAdmin

	state := map[string]any{
		"now":          time.Now().Format("15:04"),
		"schedule":     s.seed.Schedule,
		"scorePresets": s.seed.ScorePresets,
		"me":           p,
	}

	// Players and totals.
	players := []map[string]any{}
	playerTotals := map[int64]int{}
	rows, _ := s.db.Query(
		`SELECT p.id, p.name, p.emoji, p.team_id, p.is_admin, COALESCE(SUM(e.points), 0)
		 FROM players p LEFT JOIN score_events e ON e.player_id = p.id
		 GROUP BY p.id ORDER BY p.created_at`,
	)
	for rows.Next() {
		var id int64
		var name, emoji string
		var teamID sql.NullInt64
		var admin, total int
		rows.Scan(&id, &name, &emoji, &teamID, &admin, &total)
		playerTotals[id] = total
		entry := map[string]any{
			"id": id, "name": name, "emoji": emoji, "isAdmin": admin == 1, "total": total,
			"teamId": nil,
		}
		if teamID.Valid {
			entry["teamId"] = teamID.Int64
		}
		players = append(players, entry)
	}
	rows.Close()
	state["players"] = players

	// Teams: own events plus the members' individual points.
	teams := []map[string]any{}
	rows, _ = s.db.Query(
		`SELECT t.id, t.name, COALESCE(SUM(e.points), 0)
		 FROM teams t LEFT JOIN score_events e ON e.team_id = t.id
		 GROUP BY t.id ORDER BY t.id`,
	)
	for rows.Next() {
		var id int64
		var name string
		var own int
		rows.Scan(&id, &name, &own)
		teams = append(teams, map[string]any{"id": id, "name": name, "total": own})
	}
	rows.Close()
	for _, t := range teams {
		teamID := t["id"].(int64)
		total := t["total"].(int)
		for _, pl := range players {
			if tid, ok := pl["teamId"].(int64); ok && tid == teamID {
				total += pl["total"].(int)
			}
		}
		t["total"] = total
	}
	state["teams"] = teams

	// Feed: latest events, newest first.
	feed := []map[string]any{}
	rows, _ = s.db.Query(
		`SELECT e.id, e.label, e.points, e.activity, e.created_at, p.name, p.emoji, t.name
		 FROM score_events e
		 LEFT JOIN players p ON p.id = e.player_id
		 LEFT JOIN teams t ON t.id = e.team_id
		 ORDER BY e.id DESC LIMIT 40`,
	)
	for rows.Next() {
		var id int64
		var label, activity, createdAt string
		var points int
		var playerName, playerEmoji, teamName sql.NullString
		rows.Scan(&id, &label, &points, &activity, &createdAt, &playerName, &playerEmoji, &teamName)
		entry := map[string]any{
			"id": id, "label": label, "points": points, "activity": activity, "at": createdAt,
		}
		if playerName.Valid {
			entry["who"] = playerEmoji.String + " " + playerName.String
		} else if teamName.Valid {
			entry["who"] = "🏴 " + teamName.String
		}
		feed = append(feed, entry)
	}
	rows.Close()
	state["feed"] = feed

	// Checklist.
	checklist := []map[string]any{}
	rows, _ = s.db.Query(`SELECT c.id, c.text, c.admin_only, c.done, p.name FROM checklist c LEFT JOIN players p ON p.id = c.done_by ORDER BY c.id`)
	for rows.Next() {
		var id int64
		var text string
		var adminOnly, done int
		var doneBy sql.NullString
		rows.Scan(&id, &text, &adminOnly, &done, &doneBy)
		if adminOnly == 1 && !isAdmin {
			continue
		}
		checklist = append(checklist, map[string]any{
			"id": id, "text": text, "adminOnly": adminOnly == 1, "done": done == 1, "doneBy": doneBy.String,
		})
	}
	rows.Close()
	state["checklist"] = checklist

	// Quizzes with questions, filtered by state.
	state["quizzes"] = s.quizzesState(p, isAdmin)

	// Predictions.
	state["predictions"] = s.predictionsState(p, isAdmin)

	// Missions with per-team status.
	missions := []map[string]any{}
	rows, _ = s.db.Query(`SELECT id, text, points FROM missions ORDER BY sort`)
	for rows.Next() {
		var id int64
		var text string
		var points int
		rows.Scan(&id, &text, &points)
		missions = append(missions, map[string]any{"id": id, "text": text, "points": points, "teams": map[string]any{}})
	}
	rows.Close()
	rows, _ = s.db.Query(`SELECT id, mission_id, team_id, state FROM mission_done`)
	for rows.Next() {
		var id, missionID, teamID int64
		var st string
		rows.Scan(&id, &missionID, &teamID, &st)
		for _, m := range missions {
			if m["id"].(int64) == missionID {
				m["teams"].(map[string]any)[strconv.FormatInt(teamID, 10)] = map[string]any{"id": id, "state": st}
			}
		}
	}
	rows.Close()
	state["missions"] = missions

	writeJSON(w, http.StatusOK, state)
}

func (s *Server) quizzesState(p *player, isAdmin bool) []map[string]any {
	quizzes := []map[string]any{}
	rows, _ := s.db.Query(`SELECT id, name FROM quizzes ORDER BY sort`)
	for rows.Next() {
		var id int64
		var name string
		rows.Scan(&id, &name)
		quizzes = append(quizzes, map[string]any{"id": id, "name": name, "questions": []map[string]any{}})
	}
	rows.Close()

	// Buffer the questions before any per-question lookups: the pool has a
	// single connection, so a nested query while rows are open deadlocks.
	type questionRow struct {
		id, quizID                         int64
		text, qtype, optionsJSON, answer, qstate string
		points                             int
	}
	var questionRows []questionRow
	qrows, _ := s.db.Query(`SELECT id, quiz_id, text, qtype, options, answer, points, state FROM questions ORDER BY quiz_id, sort`)
	for qrows.Next() {
		var q questionRow
		qrows.Scan(&q.id, &q.quizID, &q.text, &q.qtype, &q.optionsJSON, &q.answer, &q.points, &q.qstate)
		questionRows = append(questionRows, q)
	}
	qrows.Close()

	for _, row := range questionRows {
		id, quizID, text, qtype, answer, qstate, points := row.id, row.quizID, row.text, row.qtype, row.answer, row.qstate, row.points

		var options []string
		json.Unmarshal([]byte(row.optionsJSON), &options)

		q := map[string]any{
			"id": id, "text": text, "type": qtype, "options": options,
			"points": points, "state": qstate,
		}
		if isAdmin || qstate == "revealed" {
			q["answer"] = answer
		}

		if p != nil {
			var mine string
			if err := s.db.QueryRow(`SELECT value FROM answers WHERE question_id = ? AND player_id = ?`, id, p.ID).Scan(&mine); err == nil {
				q["myAnswer"] = mine
			}
		}

		// Everyone's answers become public at reveal; the admin sees them
		// while the question is open to grade text answers live.
		if qstate == "revealed" || (isAdmin && qstate == "open") {
			all := []map[string]any{}
			arows, _ := s.db.Query(
				`SELECT a.id, a.value, a.correct, p.name, p.emoji FROM answers a JOIN players p ON p.id = a.player_id WHERE a.question_id = ? ORDER BY a.id`, id,
			)
			for arows.Next() {
				var answerID int64
				var value, name, emoji string
				var correct sql.NullInt64
				arows.Scan(&answerID, &value, &correct, &name, &emoji)
				entry := map[string]any{"id": answerID, "value": value, "who": emoji + " " + name}
				if correct.Valid {
					entry["correct"] = correct.Int64 == 1
				}
				all = append(all, entry)
			}
			arows.Close()
			q["answers"] = all
		}

		for _, z := range quizzes {
			if z["id"].(int64) == quizID {
				z["questions"] = append(z["questions"].([]map[string]any), q)
			}
		}
	}
	return quizzes
}

func (s *Server) predictionsState(p *player, isAdmin bool) []map[string]any {
	predictions := []map[string]any{}
	// Buffered before per-row lookups; see quizzesState.
	type predictionRow struct {
		id                                  int64
		text, ptype, optionsJSON, pstate, fasit string
		points                              int
	}
	var predictionRows []predictionRow
	rows, _ := s.db.Query(`SELECT id, text, ptype, options, points, state, fasit FROM predictions ORDER BY sort`)
	for rows.Next() {
		var r predictionRow
		rows.Scan(&r.id, &r.text, &r.ptype, &r.optionsJSON, &r.points, &r.pstate, &r.fasit)
		predictionRows = append(predictionRows, r)
	}
	rows.Close()

	for _, row := range predictionRows {
		id, text, ptype, pstate, fasit, points := row.id, row.text, row.ptype, row.pstate, row.fasit, row.points

		var options []string
		json.Unmarshal([]byte(row.optionsJSON), &options)

		entry := map[string]any{
			"id": id, "text": text, "type": ptype, "options": options,
			"points": points, "state": pstate,
		}
		if pstate == "resolved" {
			entry["fasit"] = fasit
		}
		if p != nil {
			var mine string
			if err := s.db.QueryRow(`SELECT value FROM bets WHERE prediction_id = ? AND player_id = ?`, id, p.ID).Scan(&mine); err == nil {
				entry["myBet"] = mine
			}
		}
		// The market becomes public knowledge once locked — half the fun.
		if pstate != "open" || isAdmin {
			bets := []map[string]any{}
			brows, _ := s.db.Query(
				`SELECT b.value, p.name, p.emoji FROM bets b JOIN players p ON p.id = b.player_id WHERE b.prediction_id = ? ORDER BY b.id`, id,
			)
			for brows.Next() {
				var value, name, emoji string
				brows.Scan(&value, &name, &emoji)
				bets = append(bets, map[string]any{"value": value, "who": emoji + " " + name})
			}
			brows.Close()
			entry["bets"] = bets
		}
		predictions = append(predictions, entry)
	}
	return predictions
}
