package store

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func newMeta(id string) *Meta {
	return &Meta{ID: id, Language: "auto", State: Receiving, Streams: map[string]*Stream{"them": {}, "me": {}}}
}

func TestAudioRoundTrip(t *testing.T) {
	s := New(t.TempDir())
	if err := s.Create(newMeta("a")); err != nil {
		t.Fatal(err)
	}
	_ = s.Append("a", "them", []int16{1, 2, 3})
	_ = s.Append("a", "them", []int16{4, 5})
	got, err := s.Read("a", "them", 1, 4)
	if err != nil || !reflect.DeepEqual(got, []int16{2, 3, 4}) {
		t.Fatalf("read %v, %v", got, err)
	}
	if _, err := s.Read("a", "them", 3, 9); err == nil {
		t.Fatal("reading past the end should fail")
	}
	if err := s.DropAudio("a"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Read("a", "them", 0, 1); err == nil {
		t.Fatal("audio should be gone")
	}
}

func TestMetaRoundTrip(t *testing.T) {
	s := New(t.TempDir())
	m := newMeta("2026-10-23_190000_dsa")
	m.Streams["them"].Received = 480000
	_ = s.Create(m)
	got, err := s.Load(m.ID)
	if err != nil || got.Streams["them"].Received != 480000 || got.State != Receiving || got.CreatedAt.IsZero() {
		t.Fatalf("load %+v, %v", got, err)
	}
	list, _ := s.List()
	if len(list) != 1 {
		t.Fatalf("list %d", len(list))
	}
}

func TestRejectsPathTraversal(t *testing.T) {
	s := New(t.TempDir())
	for _, id := range []string{"..", "../x", "a/b", "", `a\b`} {
		if err := s.Create(newMeta(id)); err == nil {
			t.Fatalf("id %q accepted", id)
		}
	}
	_ = s.Create(newMeta("ok"))
	if err := s.Append("ok", "../evil", []int16{1}); err == nil {
		t.Fatal("stream name with a path accepted")
	}
}

func TestLinesSkipsUncommittedAndDuplicateRuns(t *testing.T) {
	s := New(t.TempDir())
	m := newMeta("s")
	_ = s.Create(m)

	// Chunk 0 of "them" ran twice (interrupted after writing the first time);
	// chunk 100 of "me" is written but not yet marked done.
	_ = s.AppendLines("s", []Line{{Speaker: "them", StartMs: 0, Text: "first try", Chunk: 0}})
	_ = s.AppendLines("s", []Line{
		{Speaker: "them", StartMs: 0, Text: "hello", Chunk: 0},
		{Speaker: "them", StartMs: 3000, Text: "class", Chunk: 0},
	})
	_ = s.AppendLines("s", []Line{{Speaker: "me", StartMs: 1000, Text: "question", Chunk: 0}})
	_ = s.AppendLines("s", []Line{{Speaker: "me", StartMs: 9000, Text: "pending", Chunk: 100}})
	m.Streams["them"].Done = 50
	m.Streams["me"].Done = 50

	lines, err := s.Lines(m)
	if err != nil {
		t.Fatal(err)
	}
	var texts []string
	for _, l := range lines {
		texts = append(texts, l.Text)
	}
	if want := []string{"hello", "question", "class"}; !reflect.DeepEqual(texts, want) {
		t.Fatalf("lines %v, want %v", texts, want)
	}
}

func TestLinesToleratesTornLastLine(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	m := newMeta("s")
	_ = s.Create(m)
	_ = s.AppendLines("s", []Line{{Speaker: "them", Text: "ok", Chunk: 0}})
	f, _ := os.OpenFile(filepath.Join(dir, "s", "lines.jsonl"), os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"speaker":"them","te`)
	f.Close()
	m.Streams["them"].Done = 1
	lines, err := s.Lines(m)
	if err != nil || len(lines) != 1 {
		t.Fatalf("lines %v, %v", lines, err)
	}
}
