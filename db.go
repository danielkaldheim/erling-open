package main

import (
	"database/sql"
	"encoding/json"
	"fmt"

	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS players (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	name       TEXT NOT NULL,
	emoji      TEXT NOT NULL DEFAULT '🍺',
	token      TEXT NOT NULL UNIQUE,
	team_id    INTEGER,
	is_admin   INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS teams (
	id   INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checklist (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	text       TEXT NOT NULL,
	admin_only INTEGER NOT NULL DEFAULT 0,
	done       INTEGER NOT NULL DEFAULT 0,
	done_by    INTEGER,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS score_events (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	player_id  INTEGER,
	team_id    INTEGER,
	activity   TEXT NOT NULL,
	label      TEXT NOT NULL,
	points     INTEGER NOT NULL,
	ref        TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS schedule_items (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	sort       INTEGER NOT NULL DEFAULT 0,
	time       TEXT NOT NULL,
	title      TEXT NOT NULL,
	place      TEXT NOT NULL DEFAULT '',
	icon       TEXT NOT NULL DEFAULT '📍',
	revealed   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS quizzes (
	id                  INTEGER PRIMARY KEY AUTOINCREMENT,
	name                TEXT NOT NULL,
	sort                INTEGER NOT NULL DEFAULT 0,
	state               TEXT NOT NULL DEFAULT 'idle', -- idle | active | finished
	duration_seconds    INTEGER NOT NULL DEFAULT 0,
	started_at          INTEGER NOT NULL DEFAULT 0,
	ends_at              INTEGER NOT NULL DEFAULT 0,
	current_question_id INTEGER
);
CREATE TABLE IF NOT EXISTS questions (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	quiz_id    INTEGER NOT NULL,
	sort       INTEGER NOT NULL DEFAULT 0,
	text       TEXT NOT NULL,
	qtype      TEXT NOT NULL DEFAULT 'choice', -- choice | number | text
	options    TEXT NOT NULL DEFAULT '[]',
	answer     TEXT NOT NULL DEFAULT '',
	points     INTEGER NOT NULL DEFAULT 5,
	state      TEXT NOT NULL DEFAULT 'hidden', -- hidden | open | revealed
	media_url  TEXT NOT NULL DEFAULT '',
	media_type TEXT NOT NULL DEFAULT ''         -- image | video
);
CREATE TABLE IF NOT EXISTS answers (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	question_id INTEGER NOT NULL,
	player_id   INTEGER NOT NULL,
	value       TEXT NOT NULL,
	correct     INTEGER, -- NULL = ungraded (text questions)
	UNIQUE (question_id, player_id)
);
CREATE TABLE IF NOT EXISTS predictions (
	id      INTEGER PRIMARY KEY AUTOINCREMENT,
	sort    INTEGER NOT NULL DEFAULT 0,
	text    TEXT NOT NULL,
	ptype   TEXT NOT NULL DEFAULT 'time', -- time | number | choice
	options TEXT NOT NULL DEFAULT '[]',
	points  INTEGER NOT NULL DEFAULT 10,
	state   TEXT NOT NULL DEFAULT 'open', -- open | locked | resolved
	fasit   TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS bets (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	prediction_id INTEGER NOT NULL,
	player_id     INTEGER NOT NULL,
	value         TEXT NOT NULL,
	UNIQUE (prediction_id, player_id)
);
CREATE TABLE IF NOT EXISTS missions (
	id     INTEGER PRIMARY KEY AUTOINCREMENT,
	sort   INTEGER NOT NULL DEFAULT 0,
	text   TEXT NOT NULL,
	points INTEGER NOT NULL DEFAULT 10
);
CREATE TABLE IF NOT EXISTS mission_done (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	mission_id INTEGER NOT NULL,
	team_id    INTEGER NOT NULL,
	player_id  INTEGER,
	state      TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
	UNIQUE (mission_id, team_id)
);
CREATE TABLE IF NOT EXISTS meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`

// seedText is a JSON string that also accepts a bare number, so an answer key
// or option typed as 1987 instead of "1987" does not stop the server booting.
type seedText string

func (t *seedText) UnmarshalJSON(data []byte) error {
	var text string
	if err := json.Unmarshal(data, &text); err == nil {
		*t = seedText(text)
		return nil
	}
	var number json.Number
	if err := json.Unmarshal(data, &number); err != nil {
		return fmt.Errorf("forventet tekst eller tall, fikk %s", data)
	}
	*t = seedText(number.String())
	return nil
}

func seedTexts(values []seedText) []string {
	out := make([]string, len(values))
	for i, v := range values {
		out[i] = string(v)
	}
	return out
}

// Seed mirrors seed.json: the day's content. Score presets are served
// straight from the file; editable content is copied into SQLite.
type Seed struct {
	Schedule []struct {
		Time  string `json:"time"`
		Title string `json:"title"`
		Where string `json:"where"`
		Icon  string `json:"icon"`
	} `json:"schedule"`
	ScorePresets []struct {
		Activity string `json:"activity"`
		Label    string `json:"label"`
		Points   int    `json:"points"`
	} `json:"scorePresets"`
	Quizzes []struct {
		Name      string `json:"name"`
		Questions []struct {
			Text      string     `json:"text"`
			Type      string     `json:"type"`
			Options   []seedText `json:"options"`
			Answer    seedText   `json:"answer"`
			Points    int        `json:"points"`
			MediaURL  string     `json:"mediaUrl"`
			MediaType string     `json:"mediaType"`
		} `json:"questions"`
	} `json:"quizzes"`
	Predictions []struct {
		Text    string     `json:"text"`
		Type    string     `json:"type"`
		Options []seedText `json:"options"`
		Points  int        `json:"points"`
	} `json:"predictions"`
	Missions []struct {
		Text   string `json:"text"`
		Points int    `json:"points"`
	} `json:"missions"`
	Checklist []struct {
		Text      string `json:"text"`
		AdminOnly bool   `json:"adminOnly"`
	} `json:"checklist"`
}

func openDB(path string, seed *Seed) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	// SQLite allows one writer; a single connection sidesteps SQLITE_BUSY
	// entirely at this scale.
	db.SetMaxOpenConns(1)

	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("schema: %w", err)
	}
	if err := migrateDB(db); err != nil {
		return nil, fmt.Errorf("migrate: %w", err)
	}
	if err := seedOnce(db, seed); err != nil {
		return nil, fmt.Errorf("seed: %w", err)
	}
	if err := seedScheduleIfEmpty(db, seed); err != nil {
		return nil, fmt.Errorf("schedule seed: %w", err)
	}
	return db, nil
}

// migrateDB keeps databases created by earlier app versions usable. SQLite's
// CREATE TABLE IF NOT EXISTS does not add newly introduced columns.
func migrateDB(db *sql.DB) error {
	columns := []struct {
		table, name, definition string
	}{
		{"quizzes", "state", "TEXT NOT NULL DEFAULT 'idle'"},
		{"quizzes", "duration_seconds", "INTEGER NOT NULL DEFAULT 0"},
		{"quizzes", "started_at", "INTEGER NOT NULL DEFAULT 0"},
		{"quizzes", "ends_at", "INTEGER NOT NULL DEFAULT 0"},
		{"quizzes", "current_question_id", "INTEGER"},
		{"questions", "media_url", "TEXT NOT NULL DEFAULT ''"},
		{"questions", "media_type", "TEXT NOT NULL DEFAULT ''"},
		{"schedule_items", "revealed", "INTEGER NOT NULL DEFAULT 0"},
	}
	for _, column := range columns {
		hasColumn, err := tableHasColumn(db, column.table, column.name)
		if err != nil {
			return err
		}
		if !hasColumn {
			if _, err := db.Exec("ALTER TABLE " + column.table + " ADD COLUMN " + column.name + " " + column.definition); err != nil {
				return err
			}
		}
	}
	return nil
}

func tableHasColumn(db *sql.DB, table, column string) (bool, error) {
	rows, err := db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, columnType string
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

// Schedule used to be served directly from seed.json. Populate the new table
// independently of meta.seeded so existing installations receive it too.
func seedScheduleIfEmpty(db *sql.DB, seed *Seed) error {
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM schedule_items`).Scan(&count); err != nil {
		return err
	}
	if count != 0 {
		return nil
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for i, item := range seed.Schedule {
		if _, err := tx.Exec(
			`INSERT INTO schedule_items (sort, time, title, place, icon) VALUES (?, ?, ?, ?, ?)`,
			i, item.Time, item.Title, item.Where, item.Icon,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func seedOnce(db *sql.DB, seed *Seed) error {
	var done string
	err := db.QueryRow(`SELECT value FROM meta WHERE key = 'seeded'`).Scan(&done)
	if err == nil {
		return nil
	}
	if err != sql.ErrNoRows {
		return err
	}

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for qi, quiz := range seed.Quizzes {
		res, err := tx.Exec(`INSERT INTO quizzes (name, sort) VALUES (?, ?)`, quiz.Name, qi)
		if err != nil {
			return err
		}
		quizID, _ := res.LastInsertId()
		for i, q := range quiz.Questions {
			options, _ := json.Marshal(seedTexts(q.Options))
			qtype := q.Type
			if qtype == "" {
				qtype = "choice"
			}
			points := q.Points
			if points == 0 {
				points = 5
			}
			if _, err := tx.Exec(
				`INSERT INTO questions (quiz_id, sort, text, qtype, options, answer, points, media_url, media_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				quizID, i, q.Text, qtype, string(options), string(q.Answer), points, q.MediaURL, q.MediaType,
			); err != nil {
				return err
			}
		}
	}

	for i, p := range seed.Predictions {
		options, _ := json.Marshal(seedTexts(p.Options))
		points := p.Points
		if points == 0 {
			points = 10
		}
		if _, err := tx.Exec(
			`INSERT INTO predictions (sort, text, ptype, options, points) VALUES (?, ?, ?, ?, ?)`,
			i, p.Text, p.Type, string(options), points,
		); err != nil {
			return err
		}
	}

	for i, m := range seed.Missions {
		points := m.Points
		if points == 0 {
			points = 10
		}
		if _, err := tx.Exec(`INSERT INTO missions (sort, text, points) VALUES (?, ?, ?)`, i, m.Text, points); err != nil {
			return err
		}
	}

	for _, c := range seed.Checklist {
		adminOnly := 0
		if c.AdminOnly {
			adminOnly = 1
		}
		if _, err := tx.Exec(`INSERT INTO checklist (text, admin_only) VALUES (?, ?)`, c.Text, adminOnly); err != nil {
			return err
		}
	}

	if _, err := tx.Exec(`INSERT INTO meta (key, value) VALUES ('seeded', '1')`); err != nil {
		return err
	}
	return tx.Commit()
}
