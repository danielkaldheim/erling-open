package main

import (
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Hub is a deliberately dumb broadcast channel: every mutation on the
// server pokes all clients, and clients refetch the filtered state over
// HTTP. With ten players and one venue this beats granular sync on both
// simplicity and robustness (a missed frame heals on the next poke).
type Hub struct {
	mu    sync.Mutex
	conns map[*websocket.Conn]chan []byte
}

var upgrader = websocket.Upgrader{
	// Same-origin app; the state endpoint does its own token filtering.
	CheckOrigin: func(r *http.Request) bool { return true },
}

func newHub() *Hub {
	return &Hub{conns: map[*websocket.Conn]chan []byte{}}
}

func (h *Hub) Broadcast(message []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, send := range h.conns {
		select {
		case send <- message:
		default: // Slow client; it will catch up on its next refetch.
		}
	}
}

func (h *Hub) Poke() {
	h.Broadcast([]byte(`{"type":"update"}`))
}

func (h *Hub) Serve(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	send := make(chan []byte, 8)
	h.mu.Lock()
	h.conns[conn] = send
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		delete(h.conns, conn)
		h.mu.Unlock()
		conn.Close()
	}()

	// Writer: pushes pokes and keeps the connection alive through
	// proxies with periodic pings.
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case msg, ok := <-send:
				if !ok {
					return
				}
				conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if conn.WriteMessage(websocket.TextMessage, msg) != nil {
					return
				}
			case <-ticker.C:
				conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if conn.WriteMessage(websocket.PingMessage, nil) != nil {
					return
				}
			}
		}
	}()

	// Reader: we ignore everything the client says, but reading is what
	// notices a dead connection.
	conn.SetReadLimit(1024)
	conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		return nil
	})
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			close(send)
			return
		}
		conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	}
}
