package host

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"testing"

	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/engine"
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
	h := &Host{Hello: Hello{Version: "test", Problems: []string{"model missing"}}}
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
	h := &Host{Engine: e, Hello: Hello{Ready: true, Language: "hi"}}
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
