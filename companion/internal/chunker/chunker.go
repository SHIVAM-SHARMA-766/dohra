// Package chunker decides where to cut a growing audio stream into pieces for
// Whisper.
//
// Whisper encodes audio in fixed 30-second windows and re-encodes from the last
// complete line at the end of every run, so each run pays roughly one extra
// window. Long chunks keep that overhead small; measured on a 6-core laptop CPU,
// a 2-minute chunk runs at about real time where a 28-second one runs at 0.7x.
// Cuts are placed at the quietest moment near the target length so that words
// are not split between chunks.
package chunker

import "math"

// SampleRate is the rate of all audio the companion handles: 16 kHz mono, which
// is what Whisper consumes.
const SampleRate = 16000

type Params struct {
	Target int // preferred chunk length, in samples
	Search int // how far before Target to look for a quiet cut point
	Frame  int // length of the window whose energy is compared
}

var Default = Params{
	Target: 120 * SampleRate,
	Search: 30 * SampleRate,
	Frame:  SampleRate / 2,
}

// Cut returns how many samples from the start of pending (the audio not yet
// chunked) form the next chunk, or 0 to wait for more audio. With final set, no
// more audio is coming and any remainder is returned.
func (p Params) Cut(pending []int16, final bool) int {
	n := len(pending)
	switch {
	case n == 0:
		return 0
	case n < p.Target:
		if final {
			return n
		}
		return 0
	case final && n <= p.Target:
		return n
	}

	best, bestEnergy := p.Target, math.Inf(1)
	for start := p.Target - p.Search; start+p.Frame <= p.Target; start += p.Frame / 2 {
		if e := energy(pending[start : start+p.Frame]); e < bestEnergy {
			best, bestEnergy = start+p.Frame/2, e
		}
	}
	return best
}

func energy(samples []int16) float64 {
	var sum float64
	for _, s := range samples {
		sum += float64(s) * float64(s)
	}
	return sum / float64(len(samples))
}

// Silent reports whether a chunk is too quiet to contain speech. Skipping such
// chunks saves a Whisper run, and Whisper tends to invent text ("Thank you.")
// on silence. The threshold is about -50 dBFS.
func Silent(samples []int16) bool {
	if len(samples) == 0 {
		return true
	}
	return math.Sqrt(energy(samples)) < 100
}
