package whisper

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParse(t *testing.T) {
	data := []byte(`{"result":{"language":"hi"},"transcription":[
		{"offsets":{"from":0,"to":2500},"text":" आज हम graphs पढ़ेंगे"},
		{"offsets":{"from":2500,"to":4000},"text":" [Music]"},
		{"offsets":{"from":4000,"to":5000},"text":"   "},
		{"offsets":{"from":5000,"to":7000},"text":" (upbeat music)"},
		{"offsets":{"from":7000,"to":9000},"text":" Okay, next slide."}]}`)
	res, err := parse(data)
	if err != nil {
		t.Fatal(err)
	}
	if res.Language != "hi" {
		t.Fatalf("language %q", res.Language)
	}
	want := []Segment{{0, 2500, "आज हम graphs पढ़ेंगे"}, {7000, 9000, "Okay, next slide."}}
	if len(res.Segments) != len(want) {
		t.Fatalf("segments %+v", res.Segments)
	}
	for i := range want {
		if res.Segments[i] != want[i] {
			t.Fatalf("segment %d = %+v, want %+v", i, res.Segments[i], want[i])
		}
	}
}

func TestWriteWAV(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.wav")
	if err := WriteWAV(path, []int16{1, -1, 300}, 16000); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if len(data) != 44+6 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WAVE" || string(data[36:40]) != "data" {
		t.Fatalf("bad header: % x", data[:44])
	}
	if data[24] != 0x80 || data[25] != 0x3e { // 16000 little-endian
		t.Fatalf("sample rate bytes % x", data[24:28])
	}
}

func TestCollapseRepeats(t *testing.T) {
	cases := map[string]string{
		"hello hello hello hello hello hello":   "hello hello hello …",
		"Hello, hello, hello, hello. Theek hai": "Hello, hello, hello, … Theek hai",
		"haan haan haan":                        "haan haan haan",
		"ab hum dekhenge":                       "ab hum dekhenge",
		"— — — —":                               "— — — —", // no letters: left alone
	}
	for in, want := range cases {
		if got := collapseRepeats(in); got != want {
			t.Errorf("collapseRepeats(%q) = %q, want %q", in, got, want)
		}
	}
}
