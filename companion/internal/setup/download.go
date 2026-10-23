package setup

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/config"
)

// Verify reports whether path exists with the expected SHA-256.
func Verify(path, sha string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return false
	}
	return hex.EncodeToString(h.Sum(nil)) == sha
}

// Download fetches an asset to dest, checking its hash before moving it into
// place. An already-correct file is left alone.
func Download(ctx context.Context, a config.Asset, dest string, out io.Writer) error {
	if Verify(dest, a.SHA256) {
		fmt.Fprintf(out, "  %s already present\n", filepath.Base(dest))
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.URL, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: %s", a.URL, resp.Status)
	}

	part := dest + ".part"
	f, err := os.Create(part)
	if err != nil {
		return err
	}
	defer os.Remove(part)
	h := sha256.New()
	pw := &progress{name: filepath.Base(dest), total: a.Size, out: out}
	if _, err := io.Copy(io.MultiWriter(f, h, pw), resp.Body); err != nil {
		f.Close()
		return err
	}
	pw.finish()
	if err := f.Close(); err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != a.SHA256 {
		return fmt.Errorf("%s: checksum mismatch (got %s, want %s)", a.URL, got, a.SHA256)
	}
	return os.Rename(part, dest)
}

type progress struct {
	name  string
	total int64
	done  int64
	last  time.Time
	out   io.Writer
}

func (p *progress) Write(b []byte) (int, error) {
	p.done += int64(len(b))
	if time.Since(p.last) > 500*time.Millisecond {
		p.last = time.Now()
		fmt.Fprintf(p.out, "\r  %s  %3.0f%%  (%d / %d MB)", p.name, 100*float64(p.done)/float64(max(p.total, 1)), p.done>>20, p.total>>20)
	}
	return len(b), nil
}

func (p *progress) finish() {
	fmt.Fprintf(p.out, "\r  %s  done (%d MB)%s\n", p.name, p.done>>20, strings.Repeat(" ", 20))
}

func within(dir, p string) bool {
	dir = filepath.Clean(dir)
	return p == dir || strings.HasPrefix(p, dir+string(os.PathSeparator))
}

// safeJoin rejects archive entries that would escape dir.
func safeJoin(dir, name string) (string, error) {
	p := filepath.Join(dir, name)
	if !within(dir, p) {
		return "", fmt.Errorf("archive entry %q escapes the target directory", name)
	}
	return p, nil
}

// Extract unpacks a .tar.gz or .zip into dir.
func Extract(archive, dir string) error {
	if strings.HasSuffix(archive, ".zip") {
		return extractZip(archive, dir)
	}
	return extractTarGz(archive, dir)
}

func extractTarGz(archive, dir string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		target, err := safeJoin(dir, hdr.Name)
		if err != nil {
			return err
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := writeFile(target, tr, os.FileMode(hdr.Mode)&0o755|0o600); err != nil {
				return err
			}
		case tar.TypeSymlink:
			// The Linux build links libfoo.so -> libfoo.so.N; only allow links
			// that stay inside the directory.
			resolved := filepath.Join(filepath.Dir(target), hdr.Linkname)
			if filepath.IsAbs(hdr.Linkname) || !within(dir, resolved) {
				return fmt.Errorf("archive symlink %q -> %q escapes the target directory", hdr.Name, hdr.Linkname)
			}
			_ = os.Remove(target)
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			if err := os.Symlink(hdr.Linkname, target); err != nil {
				return err
			}
		}
	}
}

func extractZip(archive, dir string) error {
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, zf := range zr.File {
		target, err := safeJoin(dir, zf.Name)
		if err != nil {
			return err
		}
		if zf.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		rc, err := zf.Open()
		if err != nil {
			return err
		}
		err = writeFile(target, rc, 0o755)
		rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func writeFile(path string, r io.Reader, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, r); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
