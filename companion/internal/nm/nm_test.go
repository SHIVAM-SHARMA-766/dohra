package nm

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)
	if err := w.Send(map[string]any{"type": "hello", "n": 1}); err != nil {
		t.Fatal(err)
	}
	if err := w.Send(map[string]string{"type": "bye"}); err != nil {
		t.Fatal(err)
	}
	first, err := Read(&buf)
	if err != nil || string(first) != `{"n":1,"type":"hello"}` {
		t.Fatalf("first = %s, %v", first, err)
	}
	second, err := Read(&buf)
	if err != nil || string(second) != `{"type":"bye"}` {
		t.Fatalf("second = %s, %v", second, err)
	}
	if _, err := Read(&buf); err != io.EOF {
		t.Fatalf("want EOF after last message, got %v", err)
	}
}

func TestLengthIsLittleEndian(t *testing.T) {
	var buf bytes.Buffer
	_ = NewWriter(&buf).Send("x")
	if got := buf.Bytes()[:4]; !bytes.Equal(got, []byte{3, 0, 0, 0}) {
		t.Fatalf("length prefix = %v", got)
	}
}

func TestRejectsOversizedMessages(t *testing.T) {
	if err := NewWriter(io.Discard).Send(strings.Repeat("a", MaxOutgoing)); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("outgoing: %v", err)
	}
	var buf bytes.Buffer
	_ = binary.Write(&buf, binary.LittleEndian, uint32(MaxIncoming+1))
	if _, err := Read(&buf); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("incoming: %v", err)
	}
}

func TestTruncatedMessage(t *testing.T) {
	var buf bytes.Buffer
	_ = binary.Write(&buf, binary.LittleEndian, uint32(10))
	buf.WriteString("abc")
	if _, err := Read(&buf); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("got %v", err)
	}
}
