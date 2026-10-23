package engine

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"sync"
	"testing"
	"time"

	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/chunker"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/store"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/whisper"
)

// Chunks of one second (16000 samples), cut anywhere in the last half second.
var testChunk = chunker.Params{Target: 16000, Search: 8000, Frame: 1600}

type call struct {
	lang    string
	threads int
	n       int
}

type fakeRunner struct {
	mu    sync.Mutex
	calls []call
	lang  string // language to report as detected
	fail  error
	gate  chan struct{} // if set, each run waits for a value
}

func (f *fakeRunner) run(_ context.Context, opts whisper.Options, samples []int16) (whisper.Result, error) {
	if f.gate != nil {
		<-f.gate
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call{opts.Language, opts.Threads, len(samples)})
	if f.fail != nil {
		return whisper.Result{}, f.fail
	}
	lang := opts.Language
	if lang == "auto" {
		lang = f.lang
	}
	return whisper.Result{Language: lang, Segments: []whisper.Segment{
		{FromMs: 100, ToMs: 900, Text: fmt.Sprintf("run %d", len(f.calls))},
	}}, nil
}

func (f *fakeRunner) snapshot() []call {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]call(nil), f.calls...)
}

type recorder struct {
	mu     sync.Mutex
	events []any
}

func (r *recorder) emit(v any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, v)
}

func (r *recorder) done(id string) *Done {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, ev := range r.events {
		if d, ok := ev.(Done); ok && d.SessionID == id {
			return &d
		}
	}
	return nil
}

func tone(n int) []int16 {
	out := make([]int16, n)
	for i := range out {
		out[i] = int16(8000 * math.Sin(float64(i)/5))
	}
	return out
}

func setup(t *testing.T, dir string, r *fakeRunner) (*Engine, *recorder) {
	t.Helper()
	rec := &recorder{}
	cfg := Config{ModelName: "medium", LiveThreads: 3, IdleThreads: 6, Chunk: testChunk}
	return New(cfg, store.New(dir), rec.emit, r.run, log.New(io.Discard, "", 0)), rec
}

func waitDone(t *testing.T, rec *recorder, id string) Done {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if d := rec.done(id); d != nil {
			return *d
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("session %s never finished", id)
	return Done{}
}

func TestLiveSessionTranscribesInChunks(t *testing.T) {
	r := &fakeRunner{lang: "hi"}
	e, rec := setup(t, t.TempDir(), r)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.Work(ctx)

	if err := e.Start("s1", "auto"); err != nil {
		t.Fatal(err)
	}
	// 2.5 s of the tab in quarter-second pieces, and a silent microphone.
	for i := 0; i < 10; i++ {
		if err := e.Audio("s1", "them", tone(4000)); err != nil {
			t.Fatal(err)
		}
		if err := e.Audio("s1", "me", make([]int16, 4000)); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.Stop("s1"); err != nil {
		t.Fatal(err)
	}
	if d := waitDone(t, rec, "s1"); d.State != "complete" {
		t.Fatalf("done %+v", d)
	}

	// Only "them" is transcribed: "me" is silent throughout.
	calls := r.snapshot()
	if len(calls) < 3 {
		t.Fatalf("whisper ran %d times for 2.5 s of 1-second chunks: %+v", len(calls), calls)
	}
	total := 0
	for i, c := range calls {
		if c.lang != "auto" {
			t.Fatalf("call %d language %q, want auto for every chunk (classes mix languages): %+v", i, c.lang, calls)
		}
		if c.n > testChunk.Target {
			t.Fatalf("chunk of %d samples exceeds the target", c.n)
		}
		total += c.n
	}
	if total != 40000 {
		t.Fatalf("transcribed %d samples, want all 40000", total)
	}

	lines, count, state, err := e.Transcript("s1", 0, 100)
	if err != nil || count != len(calls) || state != "complete" {
		t.Fatalf("transcript %v %d %s %v", lines, count, state, err)
	}
	for _, l := range lines {
		if l.StartMs != l.Chunk*1000/chunker.SampleRate+100 || l.Speaker != "them" {
			t.Fatalf("line not offset by its chunk's start: %+v", l)
		}
	}
	if _, err := e.store.Read("s1", "them", 0, 1); err == nil {
		t.Fatal("audio should be deleted once complete")
	}
}

func TestThreadsDropWhileRecording(t *testing.T) {
	r := &fakeRunner{lang: "en", gate: make(chan struct{})}
	e, rec := setup(t, t.TempDir(), r)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.Work(ctx)

	_ = e.Start("s", "en")
	_ = e.Audio("s", "them", tone(20000)) // one full chunk queued while recording
	r.gate <- struct{}{}
	for len(r.snapshot()) < 1 {
		time.Sleep(time.Millisecond)
	}
	_ = e.Stop("s")
	r.gate <- struct{}{}
	waitDone(t, rec, "s")

	calls := r.snapshot()
	if calls[0].threads != 3 || calls[1].threads != 6 {
		t.Fatalf("threads %+v, want 3 while live then 6", calls)
	}
}

func TestRunnerErrorFailsSession(t *testing.T) {
	r := &fakeRunner{fail: errors.New("model missing")}
	e, rec := setup(t, t.TempDir(), r)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.Work(ctx)

	_ = e.Start("s", "en")
	_ = e.Audio("s", "them", tone(40000))
	d := waitDone(t, rec, "s")
	if d.State != "failed" || d.Error == "" {
		t.Fatalf("done %+v", d)
	}
	if err := e.Audio("s", "them", tone(10)); err == nil {
		t.Fatal("a failed session should not accept audio")
	}
}

func TestResumeAfterCrash(t *testing.T) {
	dir := t.TempDir()
	r := &fakeRunner{lang: "en"}

	// First run: audio arrives, but the process dies before any transcription.
	e1, _ := setup(t, dir, r)
	_ = e1.Start("s", "auto")
	_ = e1.Audio("s", "them", tone(24000))

	// Second run starts from disk.
	e2, rec := setup(t, dir, r)
	if err := e2.Resume(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e2.Work(ctx)
	if d := waitDone(t, rec, "s"); d.State != "complete" {
		t.Fatalf("done %+v", d)
	}
	lines, count, _, _ := e2.Transcript("s", 0, 10)
	if count != 2 {
		t.Fatalf("lines %+v", lines)
	}
	total := 0
	for _, c := range r.snapshot() {
		total += c.n
	}
	if total != 24000 {
		t.Fatalf("resumed run covered %d samples, want 24000", total)
	}
}

func TestStartRejectsStoppedSession(t *testing.T) {
	r := &fakeRunner{gate: make(chan struct{})}
	e, _ := setup(t, t.TempDir(), r)
	_ = e.Start("s", "en")
	_ = e.Audio("s", "them", tone(100))
	_ = e.Stop("s")
	if err := e.Start("s", "en"); err == nil {
		t.Fatal("restarting a stopped session should fail")
	}
	if err := e.Start("s2", "en"); err != nil {
		t.Fatal(err)
	}
	if err := e.Start("s2", "en"); err != nil {
		t.Fatalf("reconnecting to a live session should be allowed: %v", err)
	}
}

func TestStartReplacesFinishedTranscript(t *testing.T) {
	r := &fakeRunner{lang: "en"}
	dir := t.TempDir()
	e, rec := setup(t, dir, r)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go e.Work(ctx)

	_ = e.Start("s", "en")
	_ = e.Audio("s", "them", tone(20000))
	_ = e.Stop("s")
	waitDone(t, rec, "s")
	_, first, _, _ := e.Transcript("s", 0, 100)

	rec.mu.Lock()
	rec.events = nil
	rec.mu.Unlock()
	_ = e.Start("s", "en")
	_ = e.Audio("s", "them", tone(5000))
	_ = e.Stop("s")
	waitDone(t, rec, "s")
	_, second, _, _ := e.Transcript("s", 0, 100)
	if first < 2 || second != 1 {
		t.Fatalf("first run %d lines, second %d; the second should replace the first", first, second)
	}
}
