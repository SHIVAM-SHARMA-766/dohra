// Package config holds the companion's settings and the catalogue of files it
// downloads, pinned by version and SHA-256.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/paths"
)

// ExtensionID is fixed by the "key" in the extension's manifest.json, so the
// same ID holds on every machine. Only this extension may start the companion.
const ExtensionID = "dkihabdjpgkkichdojcgbplmjkcboipg"

// HostName is the native messaging host name the extension connects to.
const HostName = "com.dohra.companion"

type Config struct {
	Model       string `json:"model"`    // active model: "small", "medium" or "large" (High); chosen in Dohra
	Language    string `json:"language"` // default for new sessions: "hinglish", "auto", "hi", "en", ...
	LiveThreads int    `json:"liveThreads"`
	IdleThreads int    `json:"idleThreads"`
}

// Default threads: a few while the class is running, half the logical CPUs
// once it has ended. Measured on a 6-core/12-thread laptop CPU, the medium model
// runs at about real time with 3 threads and 1.6x with 6.
func Default() Config {
	return Config{
		Model:       "", // none until the user installs one from Dohra
		Language:    "hinglish",
		LiveThreads: 3,
		IdleThreads: max(2, min(8, runtime.NumCPU()/2)),
	}
}

func Load() (Config, error) {
	cfg := Default()
	data, err := os.ReadFile(paths.ConfigFile())
	if errors.Is(err, os.ErrNotExist) {
		data = []byte("{}")
		err = nil
	}
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Default(), fmt.Errorf("config.json: %w", err)
	}
	if !Installed(cfg.Model) {
		// The active model was removed by hand: fall back to any installed one.
		for _, name := range []string{"medium", "small", "large"} {
			if Installed(name) {
				cfg.Model = name
				break
			}
		}
	}
	return cfg, nil
}

func Save(cfg Config) error {
	if err := os.MkdirAll(paths.DataDir(), 0o700); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(cfg, "", "  ")
	return os.WriteFile(paths.ConfigFile(), append(data, '\n'), 0o600)
}

// Asset is a pinned download.
type Asset struct {
	URL    string
	SHA256 string
	Size   int64
}

// Model is a speech model the user can install from Dohra's setup or settings.
type Model struct {
	File  string
	Label string // what Dohra shows: Small, Medium, High
	Asset
	// NativeHinglish: fine-tuned to write Roman Hinglish itself, so it needs no prompt.
	NativeHinglish bool
}

// ModelNames lists the models from fastest to most accurate.
var ModelNames = []string{"small", "medium", "large"}

// Models are quantized ggml builds from the whisper.cpp project.
var Models = map[string]Model{
	"small": {"ggml-small-q5_1.bin", "Small", Asset{
		"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
		"ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb", 190085487}, false},
	"medium": {"ggml-medium-q5_0.bin", "Medium", Asset{
		"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q5_0.bin",
		"19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f", 539212467}, false},
	// Oriserve's Hindi2Hinglish Apex: large-v3-turbo fine-tuned on ~700 hours of noisy
	// Indian-accented Hindi to write Roman Hinglish. Converted and quantized for
	// whisper.cpp in SHIVAM-SHARMA-766/dohra-models, whose README says how. Same speed
	// as plain turbo, and far better on real Hindi speech ("Haan haan, dekhe hain"
	// where turbo heard "Uh-huh. They can't.").
	"large": {"ggml-hindi2hinglish-apex-q5_0.bin", "High", Asset{
		"https://github.com/SHIVAM-SHARMA-766/dohra-models/releases/download/hindi2hinglish-apex-v1/ggml-hindi2hinglish-apex-q5_0.bin",
		"676c257cd9eaf065328e9432cb2bd8465146920f4e4e6783743c0562b61d5104", 574041195}, true},
}

// Retired lists model files earlier versions installed and nothing uses now.
var Retired = []string{"ggml-large-v3-turbo-q5_0.bin"}

// RemoveRetired deletes retired model files, freeing their space.
func RemoveRetired() {
	for _, name := range Retired {
		_ = os.Remove(filepath.Join(paths.ModelsDir(), name))
	}
}

// VAD lets Whisper skip non-speech, where it otherwise tends to invent text.
var VAD = struct {
	File string
	Asset
}{"ggml-silero-v5.1.2.bin", Asset{
	"https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
	"29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf", 885098}}

// WhisperRelease is the whisper.cpp build whose binaries are installed. macOS
// has no prebuilt command-line binary; there it comes from Homebrew.
const WhisperRelease = "b5454"

var WhisperBinaries = map[string]Asset{
	"linux/amd64": {"https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-ubuntu-x64.tar.gz",
		"a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c", 10364195},
	"linux/arm64": {"https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-ubuntu-arm64.tar.gz",
		"6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149", 4608377},
	"windows/amd64": {"https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip",
		"6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb", 8928640},
	"windows/arm64": {"https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-win-cpu-arm64.zip",
		"28c37e7b598c3d9bbfef94f3bd67f2ee6f12b7c86f3da5edcf5e4308d615ff6d", 4371193},
}

func ModelPath(name string) string { return filepath.Join(paths.ModelsDir(), Models[name].File) }
func VADPath() string              { return filepath.Join(paths.ModelsDir(), VAD.File) }

// FindWhisper locates whisper-cli: the installed copy first, then (macOS) PATH.
func FindWhisper() (string, error) {
	var found string
	root := paths.WhisperDir()
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		root = resolved // WalkDir does not descend into a symlinked root
	}
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && d.Name() == paths.Exe("whisper-cli") {
			found = p
			return filepath.SkipAll
		}
		return nil
	})
	if found != "" {
		return found, nil
	}
	if p, err := exec.LookPath(paths.Exe("whisper-cli")); err == nil {
		return p, nil
	}
	return "", errors.New("whisper-cli not found; run `dohra-companion install`")
}

// Installed reports whether a model's file is present and complete. The hash
// was checked when it was downloaded; checking it again on every start would
// read up to a gigabyte.
func Installed(name string) bool {
	m, ok := Models[name]
	if !ok {
		return false
	}
	info, err := os.Stat(ModelPath(name))
	return err == nil && info.Size() == m.Size
}

// Problems lists what stops transcription from working, for the extension to show.
func Problems(cfg Config) []string {
	var out []string
	if _, ok := Models[cfg.Model]; !ok && cfg.Model != "" {
		out = append(out, fmt.Sprintf("unknown model %q in config.json", cfg.Model))
	} else if !Installed(cfg.Model) {
		out = append(out, "No speech model is installed yet. Choose one in Dohra's Settings.")
	}
	if _, err := FindWhisper(); err != nil {
		out = append(out, err.Error())
	}
	return out
}
