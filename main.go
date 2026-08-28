package main

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

//go:embed static
var staticFS embed.FS

//go:embed seed.json
var seedJSON []byte

// noStaleAssets makes phones revalidate the embedded frontend. Embedded files
// carry no modification time, so without an ETag a browser is free to keep
// serving yesterday's app.js after a mid-party deploy. buildTag changes with
// every binary, which is exactly the granularity we need.
func noStaleAssets(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("ETag", buildTag)
		next.ServeHTTP(w, r)
	})
}

// buildTag is derived from the embedded frontend, so it only changes when the
// files actually change.
var buildTag = func() string {
	sum := sha256.New()
	fs.WalkDir(staticFS, "static", func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := staticFS.ReadFile(path)
		if err != nil {
			return err
		}
		sum.Write([]byte(path))
		sum.Write(data)
		return nil
	})
	return `"` + hex.EncodeToString(sum.Sum(nil)[:8]) + `"`
}()

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	var seed Seed
	if err := json.Unmarshal(seedJSON, &seed); err != nil {
		log.Fatalf("seed.json: %v", err)
	}

	dataDir := env("DATA_DIR", "./data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		log.Fatal(err)
	}
	uploadDir := filepath.Join(dataDir, "uploads")
	if err := os.MkdirAll(uploadDir, 0o755); err != nil {
		log.Fatal(err)
	}
	db, err := openDB(filepath.Join(dataDir, "erling.db"), &seed)
	if err != nil {
		log.Fatal(err)
	}

	s := &Server{
		db:        db,
		hub:       newHub(),
		seed:      &seed,
		partyCode: env("PARTY_CODE", ""),
		adminCode: env("ADMIN_CODE", ""),
		uploadDir: uploadDir,
	}
	if s.adminCode == "" {
		log.Println("WARNING: ADMIN_CODE is empty — admin mode cannot be unlocked")
	}

	mux := http.NewServeMux()

	mux.HandleFunc("POST /api/register", s.handleRegister)
	mux.HandleFunc("GET /api/state", s.handleState)
	mux.HandleFunc("GET /ws", s.hub.Serve)

	mux.HandleFunc("POST /api/admin/unlock", s.withPlayer(s.handleUnlockAdmin))
	mux.HandleFunc("POST /api/checklist/add", s.withPlayer(s.handleChecklistAdd))
	mux.HandleFunc("POST /api/checklist/toggle", s.withPlayer(s.handleChecklistToggle))
	mux.HandleFunc("POST /api/quiz/answer", s.withPlayer(s.handleAnswer))
	mux.HandleFunc("POST /api/predictions/bet", s.withPlayer(s.handleBet))
	mux.HandleFunc("POST /api/missions/complete", s.withPlayer(s.handleMissionComplete))

	mux.HandleFunc("POST /api/admin/score", s.withAdmin(s.handleScoreAdd))
	mux.HandleFunc("POST /api/admin/score/delete", s.withAdmin(s.handleScoreDelete))
	mux.HandleFunc("POST /api/admin/team", s.withAdmin(s.handleCreateTeam))
	mux.HandleFunc("POST /api/admin/assign-team", s.withAdmin(s.handleAssignTeam))
	mux.HandleFunc("POST /api/admin/quiz", s.withAdmin(s.handleQuizAdd))
	mux.HandleFunc("POST /api/admin/quiz/update", s.withAdmin(s.handleQuizUpdate))
	mux.HandleFunc("POST /api/admin/quiz/delete", s.withAdmin(s.handleQuizDelete))
	mux.HandleFunc("POST /api/admin/question", s.withAdmin(s.handleQuestionAdd))
	mux.HandleFunc("POST /api/admin/question/update", s.withAdmin(s.handleQuestionUpdate))
	mux.HandleFunc("POST /api/admin/question/delete", s.withAdmin(s.handleQuestionDelete))
	mux.HandleFunc("POST /api/admin/quiz/control", s.withAdmin(s.handleQuizControl))
	mux.HandleFunc("POST /api/admin/media", s.withAdmin(s.handleMediaUpload))
	mux.HandleFunc("POST /api/admin/answer/grade", s.withAdmin(s.handleGradeAnswer))
	mux.HandleFunc("POST /api/admin/predictions/lock", s.withAdmin(s.handlePredictionsLock))
	mux.HandleFunc("POST /api/admin/prediction/resolve", s.withAdmin(s.handlePredictionResolve))
	mux.HandleFunc("POST /api/admin/schedule/update", s.withAdmin(s.handleScheduleUpdate))
	mux.HandleFunc("POST /api/admin/schedule/reveal", s.withAdmin(s.handleScheduleReveal))
	mux.HandleFunc("POST /api/admin/mission", s.withAdmin(s.handleMissionAdd))
	mux.HandleFunc("POST /api/admin/mission/update", s.withAdmin(s.handleMissionUpdate))
	mux.HandleFunc("POST /api/admin/mission/review", s.withAdmin(s.handleMissionReview))

	mux.Handle("GET /uploads/", http.StripPrefix("/uploads/", http.FileServer(http.Dir(uploadDir))))
	static, _ := fs.Sub(staticFS, "static")
	mux.Handle("GET /", noStaleAssets(http.FileServerFS(static)))

	addr := ":" + env("PORT", "8080")
	log.Printf("Erling Open listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
