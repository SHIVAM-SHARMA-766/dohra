//go:build windows

package setup

import (
	"os"
	"os/exec"
	"path/filepath"

	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/config"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/paths"
)

// On Windows a browser finds the host manifest through a registry key per
// browser, set with reg.exe so that no extra dependency is needed.
var registryKeys = []string{
	`HKCU\Software\Google\Chrome\NativeMessagingHosts\`,
	`HKCU\Software\Chromium\NativeMessagingHosts\`,
	`HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\`,
	`HKCU\Software\Microsoft\Edge\NativeMessagingHosts\`,
}

func Register(exe string) ([]string, error) {
	manifest := filepath.Join(paths.DataDir(), config.HostName+".json")
	if err := os.WriteFile(manifest, hostManifest(exe), 0o644); err != nil {
		return nil, err
	}
	var done []string
	for _, key := range registryKeys {
		key += config.HostName
		if err := exec.Command("reg", "add", key, "/ve", "/t", "REG_SZ", "/d", manifest, "/f").Run(); err != nil {
			return done, err
		}
		done = append(done, key)
	}
	return done, nil
}

func Unregister() []string {
	var removed []string
	for _, key := range registryKeys {
		key += config.HostName
		if exec.Command("reg", "delete", key, "/f").Run() == nil {
			removed = append(removed, key)
		}
	}
	_ = os.Remove(filepath.Join(paths.DataDir(), config.HostName+".json"))
	return removed
}
