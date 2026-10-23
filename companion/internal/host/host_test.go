package host

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/config"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/engine"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/models"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/nm"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/store"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/whisper"
)

func TestDecodePCM(t *testing.T) {
	got, err := DecodePCM(base64.StdEncoding.EncodeToString([]byte{0x01, 0x00, 0xff, 0xff, 0x00, 0x80}))
	if err != nil || len(got) != 3 || got[0] != 1 || got[1] != -1 || got[2] != -32768 {
		t.Fatalf("got %v, %v", got, err)
	}
	if _, err := DecodePCM(base64.StdEncoding.EncodeToString([]byte{1})); err == nil {
		t.Fatal("odd length accepted")
	}
}

// run feeds requests to a Host and returns everything it sent back.
func run(t *testing.T, h *Host, reqs ...any) []map[string]any {
	t.Helper()
	var in, out bytes.Buffer
	w := nm.NewWriter(&in)
	for _, r := range reqs {
		_ = w.Send(r)
	}
	h.Out = nm.NewWriter(&out)
	h.Log = log.New(io.Discard, "", 0)
	if err := h.Serve(context.Background(), &in); err != nil {
		t.Fatal(err)
	}
	var msgs []map[string]any
	for {
		raw, err := nm.Read(&out)
		if err != nil {
			break
		}
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		msgs = append(msgs, m)
	}
	return msgs
}

func TestNotReady(t *testing.T) {
	h := &Host{Version: "test", State: func() (config.Config, []string) { return config.Config{}, []string{"model missing"} }}
	msgs := run(t, h,
		map[string]any{"id": 1, "type": "hello"},
		map[string]any{"id": 2, "type": "start", "sessionId": "s"},
	)
	if len(msgs) != 2 || msgs[0]["ok"] != true || msgs[1]["ok"] != false {
		t.Fatalf("replies %v", msgs)
	}
	if data := msgs[0]["data"].(map[string]any); data["ready"] != false {
		t.Fatalf("hello %v", data)
	}
}

func TestRequestFlow(t *testing.T) {
	noop := func(context.Context, whisper.Options, []int16) (whisper.Result, error) { return whisper.Result{}, nil }
	e := engine.New(engine.Config{LiveThreads: 1, IdleThreads: 1}, store.New(t.TempDir()), func(any) {}, noop, log.New(io.Discard, "", 0))
	h := &Host{State: func() (config.Config, []string) { return config.Config{Language: "hi"}, nil }}
	h.SetEngine(e)
	pcm := base64.StdEncoding.EncodeToString(make([]byte, 3200))
	msgs := run(t, h,
		map[string]any{"id": 1, "type": "start", "sessionId": "s"},
		map[string]any{"type": "audio", "sessionId": "s", "stream": "them", "pcm": pcm},
		map[string]any{"type": "audio", "sessionId": "nope", "stream": "them", "pcm": pcm},
		map[string]any{"id": 2, "type": "status"},
		map[string]any{"id": 3, "type": "bogus"},
	)
	// start reply, an error event for the unknown session's audio, status reply, bogus reply.
	if len(msgs) != 4 {
		t.Fatalf("messages %v", msgs)
	}
	if msgs[0]["ok"] != true || msgs[1]["type"] != "error" || msgs[2]["ok"] != true || msgs[3]["ok"] != false {
		t.Fatalf("messages %v", msgs)
	}
	status := msgs[2]["data"].([]any)
	if len(status) != 1 || status[0].(map[string]any)["receivedMs"] != float64(100) {
		t.Fatalf("status %v", status)
	}
}

// A companion installed without a model: setup downloads one, it becomes
// active, and the engine starts without a restart.
func TestFirstModelStartsEngine(t *testing.T) {
	t.Setenv("DOHRA_HOME", t.TempDir())
	model := "small"
	fake := func(_ context.Context, a config.Asset, dest string, report func(int64)) error {
		report(a.Size / 2)
		if a.SHA256 == config.Models[model].SHA256 {
			// Stand in for the real file: Installed only checks the size.
			if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
				return err
			}
			f, err := os.Create(dest)
			if err != nil {
				return err
			}
			defer f.Close()
			return f.Truncate(a.Size)
		}
		return nil
	}
	active := ""
	started := 0
	h := &Host{
		State: func() (config.Config, []string) {
			if !config.Installed(active) {
				return config.Config{Model: active}, []string{"no model"}
			}
			return config.Config{Model: active}, nil
		},
		SaveModel: func(name string) error { active = name; return nil },
		StartEngine: func(context.Context, config.Config) *engine.Engine {
			started++
			return engine.New(engine.Config{}, store.New(t.TempDir()), func(any) {}, nil, log.New(io.Discard, "", 0))
		},
	}
	var events []any
	var mu sync.Mutex
	h.Models = models.New(fake, func(v any) { mu.Lock(); events = append(events, v); mu.Unlock() }, h.ModelInstalled)

	msgs := run(t, h, map[string]any{"id": 1, "type": "model-install", "model": model})
	h.Models.Wait()
	if msgs[0]["ok"] != true {
		t.Fatalf("install reply %v", msgs[0])
	}
	if active != model || started != 1 || h.Engine() == nil {
		t.Fatalf("after install: active %q, engine started %d times", active, started)
	}
	if last, ok := events[len(events)-1].(models.Finished); !ok || last.Error != "" {
		t.Fatalf("last event %#v", events[len(events)-1])
	}

	hello := h.Hello()
	if !hello.Ready || hello.Model != model {
		t.Fatalf("hello %+v", hello)
	}
	for _, m := range hello.Models {
		if (m.Name == model) != (m.Installed && m.Active) {
			t.Fatalf("model list %+v", hello.Models)
		}
	}

	// The active model cannot be removed; another, absent one can.
	msgs = run(t, h,
		map[string]any{"id": 2, "type": "model-remove", "model": model},
		map[string]any{"id": 3, "type": "model-use", "model": "medium"},
		map[string]any{"id": 4, "type": "model-remove", "model": "medium"},
	)
	if msgs[0]["ok"] != false || msgs[1]["ok"] != false || msgs[2]["ok"] != true {
		t.Fatalf("replies %v", msgs)
	}
	if started != 1 {
		t.Fatalf("engine started %d times", started)
	}
}
