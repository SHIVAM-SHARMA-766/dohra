package chunker

import (
	"math"
	"testing"
)

var small = Params{Target: 1000, Search: 400, Frame: 100}

// tone returns n samples of a loud sine wave, with silence over [quietFrom, quietTo).
func tone(n, quietFrom, quietTo int) []int16 {
	out := make([]int16, n)
	for i := range out {
		if i >= quietFrom && i < quietTo {
			continue
		}
		out[i] = int16(8000 * math.Sin(float64(i)/5))
	}
	return out
}

func TestWaitsUntilTarget(t *testing.T) {
	if got := small.Cut(tone(999, 0, 0), false); got != 0 {
		t.Fatalf("cut %d before target", got)
	}
}

func TestCutsAtQuietestPoint(t *testing.T) {
	got := small.Cut(tone(1500, 700, 800), false)
	if got < 700 || got > 800 {
		t.Fatalf("cut at %d, want inside the silent stretch 700-800", got)
	}
}

func TestIgnoresSilenceOutsideSearchWindow(t *testing.T) {
	// Quiet at 100-200 is too early: chunks would be far shorter than the target.
	got := small.Cut(tone(1500, 100, 200), false)
	if got < small.Target-small.Search || got > small.Target {
		t.Fatalf("cut at %d, want within the search window", got)
	}
}

func TestFinalReturnsRemainder(t *testing.T) {
	if got := small.Cut(tone(300, 0, 0), true); got != 300 {
		t.Fatalf("final cut %d, want 300", got)
	}
	if got := small.Cut(tone(1000, 0, 0), true); got != 1000 {
		t.Fatalf("final cut at exactly target %d, want 1000", got)
	}
	if got := small.Cut(nil, true); got != 0 {
		t.Fatalf("empty final cut %d", got)
	}
}

func TestFinalStillSplitsLongAudio(t *testing.T) {
	got := small.Cut(tone(2500, 0, 0), true)
	if got <= 0 || got > small.Target {
		t.Fatalf("final cut %d of long audio, want a normal chunk", got)
	}
}

func TestSilent(t *testing.T) {
	if !Silent(make([]int16, 1000)) {
		t.Fatal("zeros should be silent")
	}
	if Silent(tone(1000, 0, 0)) {
		t.Fatal("a loud tone should not be silent")
	}
}
