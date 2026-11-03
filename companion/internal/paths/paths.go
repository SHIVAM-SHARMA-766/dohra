// Package paths says where the companion keeps its files on each OS.
package paths

import (
	"os"
	"path/filepath"
	"runtime"
)

// DataDir is the root for everything the companion installs or writes:
//
//	Linux    $XDG_DATA_HOME/dohra, default ~/.local/share/dohra
//	macOS    ~/Library/Application Support/Dohra
//	Windows  %LOCALAPPDATA%\Dohra
//
// DOHRA_HOME overrides it, which tests use.
func DataDir() string {
	if dir := os.Getenv("DOHRA_HOME"); dir != "" {
		return dir
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		if dir := os.Getenv("LOCALAPPDATA"); dir != "" {
			return filepath.Join(dir, "Dohra")
		}
		return filepath.Join(home, "AppData", "Local", "Dohra")
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Dohra")
	default:
		if dir := os.Getenv("XDG_DATA_HOME"); dir != "" {
			return filepath.Join(dir, "dohra")
		}
		return filepath.Join(home, ".local", "share", "dohra")
	}
}

func BinDir() string      { return filepath.Join(DataDir(), "bin") }
func WhisperDir() string  { return filepath.Join(DataDir(), "whisper") }
func ModelsDir() string   { return filepath.Join(DataDir(), "models") }
func SessionsDir() string { return filepath.Join(DataDir(), "sessions") }
func ConfigFile() string  { return filepath.Join(DataDir(), "config.json") }
func LogFile() string     { return filepath.Join(DataDir(), "companion.log") }

// Exe appends ".exe" on Windows.
func Exe(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

// BrowserDataDirs are the per-user data directories of the Chromium browsers
// Dohra supports, whether or not they exist: Chrome, Chromium, Brave, Edge.
// DOHRA_BROWSER_DIRS (a path list) replaces them, which tests use.
func BrowserDataDirs() []string {
	if dirs := os.Getenv("DOHRA_BROWSER_DIRS"); dirs != "" {
		return filepath.SplitList(dirs)
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			base = filepath.Join(home, "AppData", "Local")
		}
		return []string{
			filepath.Join(base, "Google", "Chrome", "User Data"),
			filepath.Join(base, "Chromium", "User Data"),
			filepath.Join(base, "BraveSoftware", "Brave-Browser", "User Data"),
			filepath.Join(base, "Microsoft", "Edge", "User Data"),
		}
	case "darwin":
		base := filepath.Join(home, "Library", "Application Support")
		return []string{
			filepath.Join(base, "Google", "Chrome"),
			filepath.Join(base, "Chromium"),
			filepath.Join(base, "BraveSoftware", "Brave-Browser"),
			filepath.Join(base, "Microsoft Edge"),
		}
	default:
		base := os.Getenv("XDG_CONFIG_HOME")
		if base == "" {
			base = filepath.Join(home, ".config")
		}
		return []string{
			filepath.Join(base, "google-chrome"),
			filepath.Join(base, "chromium"),
			filepath.Join(base, "BraveSoftware", "Brave-Browser"),
			filepath.Join(base, "microsoft-edge"),
		}
	}
}
