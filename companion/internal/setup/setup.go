// Package setup installs the companion: its own binary, whisper.cpp, the
// models, and the registration that lets the browser start it.
package setup

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/config"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/paths"
)

type Options struct {
	Models []string // which models to download; the first becomes the default
	Out    io.Writer
}

// Install is idempotent: files already present with the right checksum are
// kept, so re-running it after a failure picks up where it stopped.
func Install(ctx context.Context, opts Options) error {
	out := opts.Out
	if len(opts.Models) == 0 {
		opts.Models = []string{config.Default().Model}
	}
	for _, m := range opts.Models {
		if _, ok := config.Models[m]; !ok {
			return fmt.Errorf("unknown model %q (choose small or medium)", m)
		}
	}

	fmt.Fprintf(out, "Installing into %s\n", paths.DataDir())
	exe, err := installSelf()
	if err != nil {
		return fmt.Errorf("copy companion: %w", err)
	}
	fmt.Fprintf(out, "  companion  %s\n", exe)

	fmt.Fprintln(out, "whisper.cpp:")
	if err := installWhisper(ctx, out); err != nil {
		return err
	}

	fmt.Fprintln(out, "Models:")
	if err := Download(ctx, config.VAD.Asset, config.VADPath(), out); err != nil {
		return err
	}
	for _, m := range opts.Models {
		if err := Download(ctx, config.Models[m].Asset, config.ModelPath(m), out); err != nil {
			return err
		}
	}

	cfg, _ := config.Load()
	cfg.Model = opts.Models[0]
	if err := config.Save(cfg); err != nil {
		return err
	}

	registered, err := Register(exe)
	if err != nil {
		return fmt.Errorf("register with the browser: %w", err)
	}
	fmt.Fprintln(out, "Registered for:")
	for _, r := range registered {
		fmt.Fprintf(out, "  %s\n", r)
	}
	fmt.Fprintf(out, "\nDone. Default model: %s. Reload Dohra in the browser to pick it up.\n", cfg.Model)
	return nil
}

// installSelf copies the running binary to the data directory, so the browser
// starts a stable path no matter where the download was run from.
func installSelf() (string, error) {
	src, err := os.Executable()
	if err != nil {
		return "", err
	}
	src, _ = filepath.EvalSymlinks(src)
	dest := filepath.Join(paths.BinDir(), paths.Exe("dohra-companion"))
	if same, _ := filepath.EvalSymlinks(dest); same == src {
		return dest, nil
	}
	if err := os.MkdirAll(paths.BinDir(), 0o755); err != nil {
		return "", err
	}
	in, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer in.Close()
	tmp := dest + ".new"
	if err := writeFile(tmp, in, 0o755); err != nil {
		return "", err
	}
	return dest, os.Rename(tmp, dest)
}

func installWhisper(ctx context.Context, out io.Writer) error {
	platform := runtime.GOOS + "/" + runtime.GOARCH
	asset, ok := config.WhisperBinaries[platform]
	if !ok {
		if runtime.GOOS == "darwin" {
			if p, err := exec.LookPath("whisper-cli"); err == nil {
				fmt.Fprintf(out, "  using %s\n", p)
				return nil
			}
			return errors.New("whisper.cpp has no prebuilt macOS binary: install it with `brew install whisper-cpp`, then run this again")
		}
		return fmt.Errorf("no whisper.cpp build for %s", platform)
	}

	marker := filepath.Join(paths.WhisperDir(), "RELEASE")
	if data, _ := os.ReadFile(marker); string(data) == config.WhisperRelease {
		if _, err := config.FindWhisper(); err == nil {
			fmt.Fprintf(out, "  release %s already present\n", config.WhisperRelease)
			return nil
		}
	}
	archive := filepath.Join(paths.DataDir(), "downloads", filepath.Base(asset.URL))
	if err := Download(ctx, asset, archive, out); err != nil {
		return err
	}
	if err := os.RemoveAll(paths.WhisperDir()); err != nil {
		return err
	}
	if err := Extract(archive, paths.WhisperDir()); err != nil {
		return err
	}
	if _, err := config.FindWhisper(); err != nil {
		return errors.New("whisper-cli missing from the downloaded archive")
	}
	_ = os.Remove(archive)
	return os.WriteFile(marker, []byte(config.WhisperRelease), 0o644)
}

// Uninstall removes the browser registration and, with purge, every file the
// companion installed or wrote — models, transcripts in progress, config.
func Uninstall(purge bool, out io.Writer) error {
	for _, r := range Unregister() {
		fmt.Fprintf(out, "unregistered %s\n", r)
	}
	if purge {
		if err := os.RemoveAll(paths.DataDir()); err != nil {
			return err
		}
		fmt.Fprintf(out, "removed %s\n", paths.DataDir())
	}
	return nil
}
