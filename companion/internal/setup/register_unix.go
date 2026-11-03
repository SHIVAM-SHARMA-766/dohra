//go:build !windows

package setup

import (
	"os"
	"path/filepath"

	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/config"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/paths"
)

// browserDirs are the per-user data directories of the Chromium browsers Dohra
// supports.
func browserDirs() []string { return paths.BrowserDataDirs() }

// Register installs the host manifest for every browser that exists here, or
// for Chrome alone if none does yet.
func Register(exe string) ([]string, error) {
	var done []string
	dirs := browserDirs()
	for _, dir := range dirs {
		if _, err := os.Stat(dir); err != nil {
			continue
		}
		path, err := RegisterInDir(dir, exe)
		if err != nil {
			return done, err
		}
		done = append(done, path)
	}
	if len(done) == 0 {
		path, err := RegisterInDir(dirs[0], exe)
		if err != nil {
			return nil, err
		}
		done = append(done, path)
	}
	return done, nil
}

func Unregister() []string {
	var removed []string
	for _, dir := range browserDirs() {
		path := filepath.Join(dir, "NativeMessagingHosts", config.HostName+".json")
		if os.Remove(path) == nil {
			removed = append(removed, path)
		}
	}
	return removed
}
