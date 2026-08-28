package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// The frontend ships inside the binary, where files have no modification time,
// so a browser has nothing to revalidate against and may keep running the
// app.js it cached before a mid-party deploy. assetServer stamps every asset
// reference with a hash of the frontend at boot — `app.js?v=1f3c…` — so a new
// build means new URLs. Nothing to bump by hand, and the stamped files can be
// cached forever.
type assetServer struct {
	files map[string][]byte
	tag   string
}

// Only these get rewritten: the vendored Vue bundle is 400 kB of minified code
// that could easily contain something resembling an asset reference.
var rewritable = map[string]bool{"index.html": true, "app.js": true}

var (
	markupRef = regexp.MustCompile(`(href|src)="([^"?]+\.(?:css|js|svg|webmanifest))(?:\?[^"]*)?"`)
	importRef = regexp.MustCompile(`from '(\./[^'?]+\.js)(?:\?[^']*)?'`)
)

func newAssetServer(files fs.FS) (*assetServer, error) {
	raw := map[string][]byte{}
	sum := sha256.New()
	err := fs.WalkDir(files, ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := fs.ReadFile(files, path)
		if err != nil {
			return err
		}
		raw[path] = data
		sum.Write([]byte(path))
		sum.Write(data)
		return nil
	})
	if err != nil {
		return nil, err
	}

	server := &assetServer{files: map[string][]byte{}, tag: hex.EncodeToString(sum.Sum(nil)[:8])}
	for path, data := range raw {
		if rewritable[path] {
			data = server.stamp(data)
		}
		server.files[path] = data
	}
	return server, nil
}

// stamp rewrites `href="style.css"` and `from './vue.esm-browser.prod.js'`
// into versioned URLs, replacing any query string already there.
func (a *assetServer) stamp(data []byte) []byte {
	out := markupRef.ReplaceAllString(string(data), `${1}="${2}?v=`+a.tag+`"`)
	return []byte(importRef.ReplaceAllString(out, `from '${1}?v=`+a.tag+`'`))
}

func (a *assetServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/")
	if path == "" {
		path = "index.html"
	}
	body, ok := a.files[path]
	if !ok {
		http.NotFound(w, r)
		return
	}
	// index.html carries the stamps, so it must never be served from cache.
	// A stamped URL, on the other hand, can only ever mean this one build.
	if path != "index.html" && r.URL.Query().Get("v") == a.tag {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	w.Header().Set("ETag", `"`+a.tag+`-`+path+`"`)
	http.ServeContent(w, r, path, time.Time{}, bytes.NewReader(body))
}
