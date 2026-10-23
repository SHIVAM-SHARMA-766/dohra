// Package host speaks to the extension over native messaging.
//
// Requests carry an "id" and get exactly one {"type":"reply"}; "audio" is
// fire-and-forget, since it arrives every second and a reply each time would
// only add traffic. Events from the engine ("lines", "progress", "done") are
// sent as they happen.
package host

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"

	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/engine"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/nm"
)

type Request struct {
	ID        int    `json:"id"`
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	Language  string `json:"language"`
	Stream    string `json:"stream"`
	PCM       string `json:"pcm"` // base64 of 16 kHz mono int16 little-endian
	From      int    `json:"from"`
}

type Reply struct {
	Type  string `json:"type"` // "reply"
	ID    int    `json:"id"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	Data  any    `json:"data,omitempty"`
}

type Hello struct {
	Version  string   `json:"version"`
	Ready    bool     `json:"ready"`
	Problems []string `json:"problems"`
	Model    string   `json:"model"`
	Language string   `json:"language"`
}

type TranscriptPage struct {
	Lines any    `json:"lines"`
	Next  int    `json:"next"`
	Total int    `json:"total"`
	State string `json:"state"`
}

// PageSize keeps each transcript page well under Chrome's 1 MiB message limit.
const PageSize = 500

type Host struct {
	Engine *engine.Engine // nil when not ready
	Hello  Hello
	Out    *nm.Writer
	Log    *log.Logger
}

// Serve handles requests until Chrome disconnects (EOF) or ctx ends.
func (h *Host) Serve(ctx context.Context, in io.Reader) error {
	for ctx.Err() == nil {
		raw, err := nm.Read(in)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		var req Request
		if err := json.Unmarshal(raw, &req); err != nil {
			h.Log.Printf("bad request: %v", err)
			continue
		}
		data, err := h.handle(req)
		if req.Type == "audio" {
			if err != nil {
				h.send(map[string]string{"type": "error", "sessionId": req.SessionID, "error": err.Error()})
			}
			continue
		}
		reply := Reply{Type: "reply", ID: req.ID, OK: err == nil, Data: data}
		if err != nil {
			reply.Error = err.Error()
		}
		h.send(reply)
	}
	return ctx.Err()
}

func (h *Host) send(v any) {
	if err := h.Out.Send(v); err != nil {
		h.Log.Printf("send: %v", err)
	}
}

func (h *Host) handle(req Request) (any, error) {
	if req.Type == "hello" {
		return h.Hello, nil
	}
	if h.Engine == nil {
		return nil, fmt.Errorf("transcription is not set up: %v", h.Hello.Problems)
	}
	switch req.Type {
	case "start":
		if req.Language == "" {
			req.Language = h.Hello.Language
		}
		return nil, h.Engine.Start(req.SessionID, req.Language)
	case "audio":
		samples, err := DecodePCM(req.PCM)
		if err != nil {
			return nil, err
		}
		return nil, h.Engine.Audio(req.SessionID, req.Stream, samples)
	case "stop":
		return nil, h.Engine.Stop(req.SessionID)
	case "status":
		return h.Engine.Status(), nil
	case "transcript":
		lines, total, state, err := h.Engine.Transcript(req.SessionID, req.From, PageSize)
		if err != nil {
			return nil, err
		}
		return TranscriptPage{Lines: lines, Next: req.From + len(lines), Total: total, State: state}, nil
	}
	return nil, fmt.Errorf("unknown request %q", req.Type)
}

func DecodePCM(b64 string) ([]int16, error) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, fmt.Errorf("pcm: %w", err)
	}
	if len(raw)%2 != 0 {
		return nil, errors.New("pcm: odd number of bytes")
	}
	out := make([]int16, len(raw)/2)
	for i := range out {
		out[i] = int16(binary.LittleEndian.Uint16(raw[2*i:]))
	}
	return out, nil
}
