package setup

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/config"
)

// hostManifest is the file that tells a browser how to start the companion and
// which extension may do so.
func hostManifest(exe string) []byte {
	data, _ := json.MarshalIndent(map[string]any{
		"name":            config.HostName,
		"description":     "Dohra transcription companion",
		"path":            exe,
		"type":            "stdio",
		"allowed_origins": []string{"chrome-extension://" + config.ExtensionID + "/"},
	}, "", "  ")
	return append(data, '\n')
}

// RegisterInDir writes the host manifest into <browserDir>/NativeMessagingHosts.
// Linux and macOS browsers read it from there, including a browser started with
// --user-data-dir, which is how the end-to-end test registers the companion.
func RegisterInDir(browserDir, exe string) (string, error) {
	dir := filepath.Join(browserDir, "NativeMessagingHosts")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, config.HostName+".json")
	return path, os.WriteFile(path, hostManifest(exe), 0o644)
}
