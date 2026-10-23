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
