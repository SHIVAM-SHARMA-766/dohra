// Package nm implements Chrome's native messaging framing: each message is a
// 32-bit length in native byte order (little-endian on every platform Dohra
// supports) followed by that many bytes of UTF-8 JSON.
package nm

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

// MaxOutgoing is Chrome's limit for a message from the host to the extension.
const MaxOutgoing = 1024 * 1024

// MaxIncoming bounds what the host will accept. Chrome allows up to 4 GiB from
// the extension; Dohra's largest message is about a second of audio.
const MaxIncoming = 8 * 1024 * 1024

var ErrTooLarge = errors.New("native message too large")

// Read returns the next message's JSON. It returns io.EOF when Chrome closes
// the pipe, which is how a disconnect is signalled.
func Read(r io.Reader) (json.RawMessage, error) {
	var size uint32
	if err := binary.Read(r, binary.LittleEndian, &size); err != nil {
		return nil, err
	}
	if size > MaxIncoming {
		return nil, fmt.Errorf("%w: %d bytes", ErrTooLarge, size)
	}
	buf := make([]byte, size)
	if _, err := io.ReadFull(r, buf); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, io.ErrUnexpectedEOF
		}
		return nil, err
	}
	return buf, nil
}

// Writer serialises messages to Chrome. It is safe for concurrent use: the
// transcription worker and the request loop both send.
type Writer struct {
	mu sync.Mutex
	w  io.Writer
}

func NewWriter(w io.Writer) *Writer { return &Writer{w: w} }

func (w *Writer) Send(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(data) > MaxOutgoing {
		return fmt.Errorf("%w: %d bytes", ErrTooLarge, len(data))
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := binary.Write(w.w, binary.LittleEndian, uint32(len(data))); err != nil {
		return err
	}
	_, err = w.w.Write(data)
	return err
}
