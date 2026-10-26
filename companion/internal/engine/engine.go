// Package engine turns streams of audio into transcript lines.
//
// Audio arrives per session and per stream ("them" is the tab, "me" the
// microphone, "mixed" a finished recording). It is written to disk, cut into
// chunks, and queued. One worker runs Whisper on the queue in order — one at a
// time, since Whisper already uses several threads and the class being recorded
// needs the rest of the CPU. While any session is still recording, Whisper gets
// fewer threads; once all recordings have stopped it gets more and the queue
// catches up.
//
// Dohra asks for "hinglish": Hindi and English as spoken, in Roman script (see
// package whisper). "auto" still works and detects the language of every chunk,
// at the cost of an extra encoder pass; a short or English-heavy chunk is then
// taken for English and its Hindi lost.
package engine

import (
	"context"
	"fmt"
	"log"
	"sync"

	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/chunker"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/store"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/whisper"
)

type Config struct {
	Whisper   string // whisper-cli path
	Model     string // model file path
	ModelName string // "small", "medium", "large"; recorded in each session
	// NativeHinglish: the model writes Roman Hinglish itself (see whisper.Options).
	NativeHinglish bool
	VAD            string // VAD model path, or empty
	LiveThreads    int    // while any session is recording
	IdleThreads    int    // once none is
	Chunk          chunker.Params
}

// Runner transcribes one chunk; whisper.Run in production, a fake in tests.
type Runner func(ctx context.Context, opts whisper.Options, samples []int16) (whisper.Result, error)

// Events sent to the extension.
type (
	Progress struct {
		Type       string `json:"type"` // "progress"
		SessionID  string `json:"sessionId"`
		State      string `json:"state"`
		ReceivedMs int64  `json:"receivedMs"`
		DoneMs     int64  `json:"doneMs"`
		Queued     int    `json:"queued"` // chunks waiting, across all sessions
	}
	Lines struct {
		Type      string       `json:"type"` // "lines"
		SessionID string       `json:"sessionId"`
		Lines     []store.Line `json:"lines"`
	}
	Done struct {
		Type      string `json:"type"` // "done"
		SessionID string `json:"sessionId"`
		State     string `json:"state"`
		Error     string `json:"error,omitempty"`
	}
)

type job struct {
	id, stream string
	start, end int64 // samples
}

type session struct {
	meta    *store.Meta
	live    bool               // still receiving audio
	pending map[string][]int16 // per stream: received but not yet chunked
}

type Engine struct {
	cfg   Config
	store *store.Store
	emit  func(any)
	run   Runner
	log   *log.Logger

	mu       sync.Mutex
	wake     *sync.Cond
	sessions map[string]*session
	queue    []job
}

func New(cfg Config, st *store.Store, emit func(any), run Runner, logger *log.Logger) *Engine {
	if cfg.Chunk.Target == 0 {
		cfg.Chunk = chunker.Default
	}
	e := &Engine{cfg: cfg, store: st, emit: emit, run: run, log: logger, sessions: map[string]*session{}}
	e.wake = sync.NewCond(&e.mu)
	return e
}

func ms(samples int64) int64 { return samples * 1000 / chunker.SampleRate }

// Resume re-queues work left unfinished when the companion last exited. A
// session that was still receiving then has lost its connection to the
// recording, so whatever audio arrived is treated as all there is.
func (e *Engine) Resume() error {
	metas, err := e.store.List()
	if err != nil {
		return err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, meta := range metas {
		if meta.State != store.Receiving && meta.State != store.Transcribing {
			continue
		}
		s := &session{meta: meta, pending: map[string][]int16{}}
		e.sessions[meta.ID] = s
		meta.State = store.Transcribing
		for name, st := range meta.Streams {
			if st.Received > st.Done {
				samples, err := e.store.Read(meta.ID, name, st.Done, st.Received)
				if err != nil {
					e.failLocked(s, fmt.Errorf("resume %s: %w", name, err))
					break
				}
				st.Chunked = st.Done
				s.pending[name] = samples
			}
			e.chunkLocked(s, name, true)
		}
		e.log.Printf("resumed %s", meta.ID)
		e.saveLocked(s)
		e.finishIfDoneLocked(s)
	}
	e.wake.Broadcast()
	return nil
}

// Start begins a session, or continues one that is still receiving (the
// extension reconnected mid-recording). Starting a session that already
// finished replaces its transcript.
func (e *Engine) Start(id, language string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if s, ok := e.sessions[id]; ok {
		if !s.live {
			return fmt.Errorf("session %s has already stopped", id)
		}
		return nil
	}
	if language == "" {
		language = whisper.Hinglish
	}
	if err := e.store.Delete(id); err != nil {
		return err
	}
	meta := &store.Meta{ID: id, Language: language, Model: e.cfg.ModelName, State: store.Receiving, Streams: map[string]*store.Stream{}}
	if err := e.store.Create(meta); err != nil {
		return err
	}
	e.sessions[id] = &session{meta: meta, live: true, pending: map[string][]int16{}}
	e.log.Printf("start %s (language %s, model %s)", id, language, e.cfg.ModelName)
	return nil
}

// SetModel switches the model for every chunk not yet transcribed, including
// those of sessions already in progress. The chunk running now finishes with
// the old one.
func (e *Engine) SetModel(name, path string, nativeHinglish bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.cfg.ModelName, e.cfg.Model, e.cfg.NativeHinglish = name, path, nativeHinglish
	e.log.Printf("model is now %s", name)
}

// Audio appends samples to one stream of a live session.
func (e *Engine) Audio(id, stream string, samples []int16) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	s, ok := e.sessions[id]
	if !ok || !s.live {
		return fmt.Errorf("session %s is not receiving", id)
	}
	if err := e.store.Append(id, stream, samples); err != nil {
		return err
	}
	st := s.meta.Streams[stream]
	if st == nil {
		st = &store.Stream{}
		s.meta.Streams[stream] = st
	}
	st.Received += int64(len(samples))
	s.pending[stream] = append(s.pending[stream], samples...)
	e.chunkLocked(s, stream, false)
	e.saveLocked(s)
	return nil
}

// Stop marks a session's input complete; its remaining audio is queued.
func (e *Engine) Stop(id string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	s, ok := e.sessions[id]
	if !ok {
		return fmt.Errorf("unknown session %s", id)
	}
	if !s.live {
		return nil
	}
	s.live = false
	s.meta.State = store.Transcribing
	for name := range s.meta.Streams {
		e.chunkLocked(s, name, true)
	}
	e.saveLocked(s)
	e.log.Printf("stop %s", id)
	e.finishIfDoneLocked(s)
	e.wake.Broadcast()
	return nil
}

func (e *Engine) chunkLocked(s *session, stream string, final bool) {
	st := s.meta.Streams[stream]
	for {
		n := e.cfg.Chunk.Cut(s.pending[stream], final)
		if n == 0 {
			break
		}
		e.queue = append(e.queue, job{id: s.meta.ID, stream: stream, start: st.Chunked, end: st.Chunked + int64(n)})
		st.Chunked += int64(n)
		s.pending[stream] = s.pending[stream][n:]
	}
	if len(s.pending[stream]) == 0 {
		s.pending[stream] = nil // release the backing array
	}
	e.wake.Broadcast()
}

func (e *Engine) saveLocked(s *session) {
	if err := e.store.SaveMeta(s.meta); err != nil {
		e.log.Printf("save %s: %v", s.meta.ID, err)
	}
}

func (e *Engine) progressLocked(s *session) Progress {
	p := Progress{Type: "progress", SessionID: s.meta.ID, State: string(s.meta.State), Queued: len(e.queue)}
	first := true
	for _, st := range s.meta.Streams {
		p.ReceivedMs = max(p.ReceivedMs, ms(st.Received))
		if first || ms(st.Done) < p.DoneMs {
			p.DoneMs = ms(st.Done)
		}
		first = false
	}
	return p
}

func (e *Engine) hasWorkLocked(id string) bool {
	for _, j := range e.queue {
		if j.id == id {
			return true
		}
	}
	return false
}

// finishIfDoneLocked completes a stopped session whose queue has drained.
func (e *Engine) finishIfDoneLocked(s *session) {
	if s.live || s.meta.State != store.Transcribing || e.hasWorkLocked(s.meta.ID) {
		return
	}
	for _, st := range s.meta.Streams {
		if st.Done < st.Received {
			return // the worker is still on this session's last chunk
		}
	}
	s.meta.State = store.Complete
	e.saveLocked(s)
	if err := e.store.DropAudio(s.meta.ID); err != nil {
		e.log.Printf("drop audio %s: %v", s.meta.ID, err)
	}
	delete(e.sessions, s.meta.ID)
	e.log.Printf("complete %s", s.meta.ID)
	e.emit(e.progressLocked(s))
	e.emit(Done{Type: "done", SessionID: s.meta.ID, State: string(store.Complete)})
}

func (e *Engine) failLocked(s *session, err error) {
	s.meta.State = store.Failed
	s.meta.Error = err.Error()
	s.live = false
	e.saveLocked(s)
	kept := e.queue[:0]
	for _, j := range e.queue {
		if j.id != s.meta.ID {
			kept = append(kept, j)
		}
	}
	e.queue = kept
	delete(e.sessions, s.meta.ID)
	e.log.Printf("failed %s: %v", s.meta.ID, err)
	e.emit(Done{Type: "done", SessionID: s.meta.ID, State: string(store.Failed), Error: err.Error()})
}

func (e *Engine) liveCountLocked() int {
	n := 0
	for _, s := range e.sessions {
		if s.live {
			n++
		}
	}
	return n
}

// Work runs the queue until ctx is cancelled.
func (e *Engine) Work(ctx context.Context) {
	go func() {
		<-ctx.Done()
		e.mu.Lock()
		e.wake.Broadcast()
		e.mu.Unlock()
	}()
	for {
		e.mu.Lock()
		for len(e.queue) == 0 && ctx.Err() == nil {
			e.wake.Wait()
		}
		if ctx.Err() != nil {
			e.mu.Unlock()
			return
		}
		j := e.queue[0]
		e.queue = e.queue[1:]
		s := e.sessions[j.id]
		if s == nil { // failed meanwhile
			e.mu.Unlock()
			continue
		}
		lang := s.meta.Language
		threads := e.cfg.IdleThreads
		if e.liveCountLocked() > 0 {
			threads = e.cfg.LiveThreads
		}
		model, native := e.cfg.Model, e.cfg.NativeHinglish
		e.mu.Unlock()

		e.process(ctx, s, j, lang, model, native, threads)
	}
}

func (e *Engine) process(ctx context.Context, s *session, j job, lang, model string, native bool, threads int) {
	samples, err := e.store.Read(j.id, j.stream, j.start, j.end)
	var res whisper.Result
	if err == nil && !chunker.Silent(samples) {
		res, err = e.run(ctx, whisper.Options{
			Binary: e.cfg.Whisper, Model: model, VAD: e.cfg.VAD, Language: lang, Threads: threads,
			NativeHinglish: native,
		}, samples)
	}
	if ctx.Err() != nil {
		return // shutting down; Resume will redo this chunk
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	if err != nil {
		e.failLocked(s, fmt.Errorf("chunk %s@%ds: %w", j.stream, j.start/chunker.SampleRate, err))
		return
	}
	if s.meta.Language == "auto" && s.meta.Detected == "" && res.Language != "" && res.Language != "auto" {
		s.meta.Detected = res.Language
		e.log.Printf("%s: detected language %s", j.id, res.Language)
	}

	lines := make([]store.Line, 0, len(res.Segments))
	offset := ms(j.start)
	for _, seg := range res.Segments {
		lines = append(lines, store.Line{
			Speaker: j.stream, StartMs: offset + seg.FromMs, EndMs: offset + seg.ToMs,
			Text: seg.Text, Lang: res.Language, Chunk: j.start,
		})
	}
	if err := e.store.AppendLines(j.id, lines); err != nil {
		e.failLocked(s, err)
		return
	}
	s.meta.Streams[j.stream].Done = j.end
	e.saveLocked(s)
	if len(lines) > 0 {
		e.emit(Lines{Type: "lines", SessionID: j.id, Lines: lines})
	}
	e.emit(e.progressLocked(s))
	e.finishIfDoneLocked(s)
}

// Status reports every session that is not yet complete, plus any named one.
func (e *Engine) Status() []Progress {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := []Progress{}
	for _, s := range e.sessions {
		out = append(out, e.progressLocked(s))
	}
	return out
}

// Transcript returns up to limit committed lines starting at index from, and
// the session's state.
func (e *Engine) Transcript(id string, from, limit int) ([]store.Line, int, string, error) {
	e.mu.Lock()
	var meta *store.Meta
	if s, ok := e.sessions[id]; ok {
		copied := *s.meta
		copied.Streams = map[string]*store.Stream{}
		for k, v := range s.meta.Streams {
			st := *v
			copied.Streams[k] = &st
		}
		meta = &copied
	}
	e.mu.Unlock()

	if meta == nil {
		var err error
		if meta, err = e.store.Load(id); err != nil {
			return nil, 0, "", err
		}
	}
	lines, err := e.store.Lines(meta)
	if err != nil {
		return nil, 0, "", err
	}
	total := len(lines)
	from = min(max(from, 0), total)
	end := min(from+limit, total)
	return lines[from:end], total, string(meta.State), nil
}
