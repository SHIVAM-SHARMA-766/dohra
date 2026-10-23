package models

import (
	"context"
	"testing"

	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/config"
)

func TestCancelKeepsModelUninstalled(t *testing.T) {
	t.Setenv("DOHRA_HOME", t.TempDir())
	started := make(chan struct{})
	fetch := func(ctx context.Context, a config.Asset, _ string, report func(int64)) error {
		report(a.Size / 3)
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}
	var events []any
	installed := false
	m := New(fetch, func(v any) { events = append(events, v) }, func(string) { installed = true })

	if err := m.Install(context.Background(), "medium"); err != nil {
		t.Fatal(err)
	}
	<-started
	list := m.List("")
	if !list[1].Downloading || list[1].Done != list[1].Size/3 || !m.Busy() {
		t.Fatalf("while downloading: %+v", list[1])
	}
	if err := m.Remove("medium", ""); err == nil {
		t.Fatal("removed a model mid-download")
	}
	m.Cancel("medium")
	m.Wait()

	if installed || m.Busy() {
		t.Fatal("a cancelled download counted as installed")
	}
	if got := m.List("")[1]; got.Downloading || got.Installed || got.Error != "cancelled" {
		t.Fatalf("after cancel: %+v", got)
	}
	if done, ok := events[len(events)-1].(Finished); !ok || done.Error != "cancelled" {
		t.Fatalf("last event %#v", events[len(events)-1])
	}
	if err := m.Install(context.Background(), "nope"); err == nil {
		t.Fatal("unknown model accepted")
	}
}
