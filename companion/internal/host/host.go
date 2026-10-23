// Package host speaks to the extension over native messaging.
//
// Requests carry an "id" and get exactly one {"type":"reply"}; "audio" is
// fire-and-forget, since it arrives every second and a reply each time would
// only add traffic. Events from the engine ("lines", "progress", "done") and
// from model downloads ("model-progress", "model-done") are sent as they happen.
//
// The companion can run without a speech model: that is how Dohra's setup finds
// it right after installation. Once a model is installed and chosen, the engine
// starts without the companion having to restart.
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
	"runtime"
	"sync"

	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/config"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/engine"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/models"
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
	Model     string `json:"model"`
}

type Reply struct {
	Type  string `json:"type"` // "reply"
	ID    int    `json:"id"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	Data  any    `json:"data,omitempty"`
}

type Hello struct {
	Version  string        `json:"version"`
	Ready    bool          `json:"ready"`
	Problems []string      `json:"problems"`
	Model    string        `json:"model"`
	Language string        `json:"language"`
	CPUs     int           `json:"cpus"`
	Models   []models.Info `json:"models"`
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
	Version string
	Out     *nm.Writer
	Log     *log.Logger
	// State reads the configuration and what keeps transcription from working;
	// config.Load and config.Problems in production.
	State func() (config.Config, []string)
	// SaveModel makes a model the active one; config.Save in production.
	SaveModel func(name string) error
	// StartEngine builds and starts the engine once a model is ready.
	StartEngine func(ctx context.Context, cfg config.Config) *engine.Engine
	// Models handles model downloads; nil turns those requests off.
	Models *models.Manager

	mu     sync.Mutex
	ctx    context.Context
	engine *engine.Engine // nil until transcription is ready
}

// SetEngine installs an already running engine; for tests.
func (h *Host) SetEngine(e *engine.Engine) { h.engine = e }

// Engine returns the running engine, or nil.
func (h *Host) Engine() *engine.Engine {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.engine
}

// Hello reports the companion's state, starting the engine if it has become ready.
func (h *Host) Hello() Hello {
	cfg, problems := h.State()
	hello := Hello{
		Version: h.Version, Ready: len(problems) == 0, Problems: problems,
		Model: cfg.Model, Language: cfg.Language, CPUs: runtime.NumCPU(),
	}
	if h.Models != nil {
		hello.Models = h.Models.List(cfg.Model)
	}
	if hello.Ready {
		h.ensureEngine(cfg)
	}
	return hello
}

func (h *Host) ensureEngine(cfg config.Config) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.engine != nil || h.StartEngine == nil || h.ctx == nil {
		return
	}
	h.engine = h.StartEngine(h.ctx, cfg)
}

// UseModel makes an installed model the active one, for the engine too.
func (h *Host) UseModel(name string) error {
	if !config.Installed(name) {
		return fmt.Errorf("the %s model is not installed", name)
	}
	if err := h.SaveModel(name); err != nil {
		return err
	}
	if e := h.Engine(); e != nil {
		e.SetModel(name, config.ModelPath(name))
	}
	cfg, problems := h.State()
	if len(problems) == 0 {
		h.ensureEngine(cfg)
	}
	return nil
}

// ModelInstalled runs when a download finishes. With no usable model active
// yet — the first one installed during setup — the new one becomes active.
func (h *Host) ModelInstalled(name string) {
	cfg, _ := h.State()
	if config.Installed(cfg.Model) && cfg.Model != name {
		return
	}
	if err := h.UseModel(name); err != nil {
		h.Log.Printf("activate %s: %v", name, err)
	}
}

// Serve handles requests until Chrome disconnects (EOF) or ctx ends.
func (h *Host) Serve(ctx context.Context, in io.Reader) error {
	h.mu.Lock()
	h.ctx = ctx
	h.mu.Unlock()
	// With a model ready, start now, so unfinished sessions resume at once.
	h.Hello()
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
		data, err := h.handle(ctx, req)
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

func (h *Host) handle(ctx context.Context, req Request) (any, error) {
	switch req.Type {
	case "hello":
		return h.Hello(), nil
	case "models", "model-install", "model-cancel", "model-remove", "model-use":
		return h.handleModels(ctx, req)
	}
	e := h.Engine()
	if e == nil {
		_, problems := h.State()
		return nil, fmt.Errorf("transcription is not set up: %v", problems)
	}
	switch req.Type {
	case "start":
		if req.Language == "" {
			cfg, _ := h.State()
			req.Language = cfg.Language
		}
		return nil, e.Start(req.SessionID, req.Language)
	case "audio":
		samples, err := DecodePCM(req.PCM)
		if err != nil {
			return nil, err
		}
		return nil, e.Audio(req.SessionID, req.Stream, samples)
	case "stop":
		return nil, e.Stop(req.SessionID)
	case "status":
		return e.Status(), nil
	case "transcript":
		lines, total, state, err := e.Transcript(req.SessionID, req.From, PageSize)
		if err != nil {
			return nil, err
		}
		return TranscriptPage{Lines: lines, Next: req.From + len(lines), Total: total, State: state}, nil
	}
	return nil, fmt.Errorf("unknown request %q", req.Type)
}

// handleModels answers model requests with the updated list of models.
func (h *Host) handleModels(ctx context.Context, req Request) (any, error) {
	if h.Models == nil {
		return nil, errors.New("this companion cannot manage models")
	}
	cfg, _ := h.State()
	var err error
	switch req.Type {
	case "model-install":
		// Downloads belong to the companion, not to this request: they go on
		// until finished or cancelled.
		err = h.Models.Install(context.WithoutCancel(ctx), req.Model)
	case "model-cancel":
		h.Models.Cancel(req.Model)
	case "model-remove":
		err = h.Models.Remove(req.Model, cfg.Model)
	case "model-use":
		err = h.UseModel(req.Model)
	}
	if err != nil {
		return nil, err
	}
	return h.Hello(), nil
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
