// Package store keeps each transcription session on disk, so that work survives
// the companion being killed — which happens whenever Chrome closes.
//
//	sessions/<id>/
//	  meta.json        progress per stream; replaced atomically
//	  them.pcm, me.pcm 16 kHz mono int16 audio as received; deleted once done
//	  lines.jsonl      transcript lines, appended one chunk at a time
//
// Each stream tracks three positions, in samples: Received (audio on disk),
// Chunked (handed to the transcription queue) and Done (transcribed and its
// lines written). Lines are appended before Done advances, so a crash in
// between leaves lines for a chunk that will run again; Lines() keeps only the
// last run of each chunk.
package store

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync/atomic"
	"time"
)

type State string

const (
	Receiving    State = "receiving"    // the recording is still sending audio
	Transcribing State = "transcribing" // all audio received, queue not yet empty
	Complete     State = "complete"
	Failed       State = "failed"
)

type Stream struct {
	Received int64 `json:"received"`
	Chunked  int64 `json:"chunked"`
	Done     int64 `json:"done"`
}

type Meta struct {
	ID        string             `json:"id"`
	Language  string             `json:"language"` // as requested: "auto", "hi", "en"
	Detected  string             `json:"detected"` // set from the first chunk when Language is "auto"
	Model     string             `json:"model"`
	State     State              `json:"state"`
	Streams   map[string]*Stream `json:"streams"`
	Error     string             `json:"error,omitempty"`
	CreatedAt time.Time          `json:"createdAt"`
	UpdatedAt time.Time          `json:"updatedAt"`
}

// Line is one transcribed utterance. Chunk is the first sample of the chunk it
// came from and Run identifies the AppendLines call that wrote it; together they
// let Lines discard the output of an interrupted run.
type Line struct {
	Speaker string `json:"speaker"` // the stream: "them", "me" or "mixed"
	StartMs int64  `json:"startMs"`
	EndMs   int64  `json:"endMs"`
	Text    string `json:"text"`
	Lang    string `json:"lang,omitempty"`
	Chunk   int64  `json:"chunk"`
	Run     int64  `json:"run"`
}

// lastRun makes run IDs strictly increasing even if the clock is coarse.
var lastRun atomic.Int64

func nextRun() int64 {
	for {
		prev := lastRun.Load()
		next := max(time.Now().UnixNano(), prev+1)
		if lastRun.CompareAndSwap(prev, next) {
			return next
		}
	}
}

var validID = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)

type Store struct{ root string }

func New(root string) *Store { return &Store{root: root} }

func (s *Store) dir(id string) (string, error) {
	if !validID.MatchString(id) || id == "." || id == ".." {
		return "", fmt.Errorf("invalid session id %q", id)
	}
	return filepath.Join(s.root, id), nil
}

func (s *Store) Create(meta *Meta) error {
	dir, err := s.dir(meta.ID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if meta.CreatedAt.IsZero() {
		meta.CreatedAt = time.Now().UTC()
	}
	return s.SaveMeta(meta)
}

func (s *Store) SaveMeta(meta *Meta) error {
	dir, err := s.dir(meta.ID)
	if err != nil {
		return err
	}
	meta.UpdatedAt = time.Now().UTC()
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, "meta.json.tmp")
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, "meta.json"))
}

func (s *Store) Load(id string) (*Meta, error) {
	dir, err := s.dir(id)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		return nil, err
	}
	var meta Meta
	if err := json.Unmarshal(data, &meta); err != nil {
		return nil, fmt.Errorf("session %s: %w", id, err)
	}
	if meta.Streams == nil {
		meta.Streams = map[string]*Stream{}
	}
	return &meta, nil
}

func (s *Store) List() ([]*Meta, error) {
	entries, err := os.ReadDir(s.root)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []*Meta
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if meta, err := s.Load(e.Name()); err == nil {
			out = append(out, meta)
		}
	}
	return out, nil
}

func (s *Store) pcmPath(id, stream string) (string, error) {
	dir, err := s.dir(id)
	if err != nil {
		return "", err
	}
	if !validID.MatchString(stream) {
		return "", fmt.Errorf("invalid stream %q", stream)
	}
	return filepath.Join(dir, stream+".pcm"), nil
}

// Append adds samples to a stream's audio and syncs them to disk.
func (s *Store) Append(id, stream string, samples []int16) error {
	path, err := s.pcmPath(id, stream)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := binary.Write(f, binary.LittleEndian, samples); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	return f.Close()
}

// Read returns samples [from, to) of a stream.
func (s *Store) Read(id, stream string, from, to int64) ([]int16, error) {
	path, err := s.pcmPath(id, stream)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if _, err := f.Seek(from*2, io.SeekStart); err != nil {
		return nil, err
	}
	out := make([]int16, to-from)
	if err := binary.Read(f, binary.LittleEndian, out); err != nil {
		return nil, fmt.Errorf("read %s [%d,%d): %w", stream, from, to, err)
	}
	return out, nil
}

// Delete removes a session entirely.
func (s *Store) Delete(id string) error {
	dir, err := s.dir(id)
	if err != nil {
		return err
	}
	return os.RemoveAll(dir)
}

// DropAudio deletes a session's audio once it is no longer needed. The
// recording itself stays in the extension; only the companion's copy goes.
func (s *Store) DropAudio(id string) error {
	dir, err := s.dir(id)
	if err != nil {
		return err
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "*.pcm"))
	for _, m := range matches {
		if err := os.Remove(m); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) AppendLines(id string, lines []Line) error {
	if len(lines) == 0 {
		return nil
	}
	dir, err := s.dir(id)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(dir, "lines.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	w := bufio.NewWriter(f)
	run := nextRun()
	for _, l := range lines {
		l.Run = run
		data, _ := json.Marshal(l)
		w.Write(data)
		w.WriteByte('\n')
	}
	if err := w.Flush(); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	return f.Close()
}

// Lines returns the committed transcript, ordered by time. Lines from chunks
// not yet marked done are left out, and a chunk written more than once (a run
// interrupted after writing) contributes only its latest run.
func (s *Store) Lines(meta *Meta) ([]Line, error) {
	dir, err := s.dir(meta.ID)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(filepath.Join(dir, "lines.jsonl"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()

	type key struct {
		speaker string
		chunk   int64
	}
	type batch struct {
		run   int64
		lines []Line
	}
	latest := map[key]*batch{}
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		var l Line
		if json.Unmarshal(scanner.Bytes(), &l) != nil {
			continue // a torn final line from a crash
		}
		k := key{l.Speaker, l.Chunk}
		b := latest[k]
		switch {
		case b == nil || l.Run > b.run: // a later run of this chunk replaces earlier ones
			latest[k] = &batch{run: l.Run, lines: []Line{l}}
		case l.Run == b.run:
			b.lines = append(b.lines, l)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	var out []Line
	for k, b := range latest {
		if st := meta.Streams[k.speaker]; st != nil && k.chunk < st.Done {
			out = append(out, b.lines...)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].StartMs != out[j].StartMs {
			return out[i].StartMs < out[j].StartMs
		}
		return out[i].Speaker < out[j].Speaker
	})
	return out, nil
}
