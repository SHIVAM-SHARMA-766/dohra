// Package whisper runs whisper.cpp's command-line tool on one chunk of audio.
//
// A process per chunk is simpler than keeping a server alive, and costs little:
// loading the medium model takes about 0.3 s against roughly two minutes of
// work per chunk.
package whisper

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type Options struct {
	Binary   string // path to whisper-cli
	Model    string // path to a ggml model
	VAD      string // path to the Silero VAD model; empty disables VAD
	Language string // "auto", "en", "hi", ...
	Threads  int
}

type Segment struct {
	FromMs int64  `json:"fromMs"`
	ToMs   int64  `json:"toMs"`
	Text   string `json:"text"`
}

type Result struct {
	Language string // as detected or as requested
	Segments []Segment
}

// Run transcribes 16 kHz mono samples. Timestamps are relative to the chunk.
func Run(ctx context.Context, opts Options, samples []int16) (Result, error) {
	dir, err := os.MkdirTemp("", "dohra-chunk-")
	if err != nil {
		return Result{}, err
	}
	defer os.RemoveAll(dir)

	wav := filepath.Join(dir, "chunk.wav")
	if err := WriteWAV(wav, samples, 16000); err != nil {
		return Result{}, err
	}
	base := filepath.Join(dir, "out")
	args := []string{
		"-m", opts.Model,
		"-f", wav,
		"-t", fmt.Sprint(max(1, opts.Threads)),
		"-l", opts.Language,
		"-oj", "-of", base,
		"-np",
	}
	if opts.VAD != "" {
		args = append(args, "--vad", "-vm", opts.VAD)
	}

	cmd := exec.CommandContext(ctx, opts.Binary, args...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	lowerPriority(cmd)
	if err := cmd.Start(); err != nil {
		return Result{}, fmt.Errorf("start whisper: %w", err)
	}
	afterStart(cmd)
	if err := cmd.Wait(); err != nil {
		return Result{}, fmt.Errorf("whisper failed: %w: %s", err, lastLine(stderr.String()))
	}

	data, err := os.ReadFile(base + ".json")
	if err != nil {
		return Result{}, fmt.Errorf("whisper wrote no output: %w", err)
	}
	return parse(data)
}

type output struct {
	Result struct {
		Language string `json:"language"`
	} `json:"result"`
	Transcription []struct {
		Offsets struct {
			From int64 `json:"from"`
			To   int64 `json:"to"`
		} `json:"offsets"`
		Text string `json:"text"`
	} `json:"transcription"`
}

func parse(data []byte) (Result, error) {
	var out output
	if err := json.Unmarshal(data, &out); err != nil {
		return Result{}, fmt.Errorf("parse whisper output: %w", err)
	}
	res := Result{Language: out.Result.Language}
	for _, t := range out.Transcription {
		text := strings.TrimSpace(t.Text)
		if text == "" || isNoise(text) {
			continue
		}
		res.Segments = append(res.Segments, Segment{FromMs: t.Offsets.From, ToMs: t.Offsets.To, Text: text})
	}
	return res, nil
}

// isNoise drops Whisper's non-speech annotations such as "[Music]" or
// "(upbeat music)", which carry nothing worth revising from.
func isNoise(text string) bool {
	return (strings.HasPrefix(text, "[") && strings.HasSuffix(text, "]")) ||
		(strings.HasPrefix(text, "(") && strings.HasSuffix(text, ")")) ||
		(strings.HasPrefix(text, "*") && strings.HasSuffix(text, "*"))
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return lines[len(lines)-1]
}

// WriteWAV writes 16-bit PCM mono samples as a WAV file.
func WriteWAV(path string, samples []int16, rate int) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	dataLen := uint32(len(samples) * 2)
	header := []any{
		[]byte("RIFF"), 36 + dataLen, []byte("WAVE"),
		[]byte("fmt "), uint32(16), uint16(1), uint16(1), uint32(rate), uint32(rate * 2), uint16(2), uint16(16),
		[]byte("data"), dataLen,
	}
	for _, v := range header {
		if err := binary.Write(f, binary.LittleEndian, v); err != nil {
			return err
		}
	}
	if err := binary.Write(f, binary.LittleEndian, samples); err != nil {
		return err
	}
	return f.Close()
}
