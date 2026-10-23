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

// Download fetches an asset to dest, printing progress. An already-correct
// file is left alone.
func Download(ctx context.Context, a config.Asset, dest string, out io.Writer) error {
	if Verify(dest, a.SHA256) {
		fmt.Fprintf(out, "  %s already present\n", filepath.Base(dest))
		return nil
	}
	name := filepath.Base(dest)
	var last time.Time
	err := Fetch(ctx, a, dest, func(done int64) {
		if time.Since(last) > 500*time.Millisecond {
			last = time.Now()
			fmt.Fprintf(out, "\r  %s  %3.0f%%  (%d / %d MB)", name, 100*float64(done)/float64(max(a.Size, 1)), done>>20, a.Size>>20)
		}
	})
	if err == nil {
		fmt.Fprintf(out, "\r  %s  done (%d MB)%s\n", name, a.Size>>20, strings.Repeat(" ", 20))
	}
	return err
}

// Fetch downloads an asset to dest, calling report with the bytes so far, and
// checks its hash before moving it into place. An interrupted download is kept
// as dest.part and continued from where it stopped; a part that turns out
// corrupt is deleted, so the next attempt starts over.
func Fetch(ctx context.Context, a config.Asset, dest string, report func(done int64)) error {
	if Verify(dest, a.SHA256) {
		report(a.Size)
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	part := dest + ".part"
	f, err := os.OpenFile(part, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()

	// Hash what is already there, then ask only for the rest.
	h := sha256.New()
	have, err := io.Copy(h, f)
	if err != nil {
		return err
	}
	if have == a.Size && hex.EncodeToString(h.Sum(nil)) == a.SHA256 {
		// Complete, but stopped before the rename.
		report(have)
		if err := f.Close(); err != nil {
			return err
		}
		return os.Rename(part, dest)
	}
	if have >= a.Size {
		have = 0
		h.Reset()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.URL, nil)
	if err != nil {
		return err
	}
	if have > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", have))
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusPartialContent && have > 0:
	case resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusRequestedRangeNotSatisfiable:
		// The server sent the whole file (or the part is unusable): start over.
		if resp.StatusCode != http.StatusOK {
			_ = os.Remove(part)
			return fmt.Errorf("download %s: %s; try again", a.URL, resp.Status)
		}
		have = 0
		h.Reset()
		if err := f.Truncate(0); err != nil {
			return err
		}
	default:
		return fmt.Errorf("download %s: %s", a.URL, resp.Status)
	}
	if _, err := f.Seek(have, io.SeekStart); err != nil {
		return err
	}
	report(have)
	cw := &counter{done: have, report: report}
	if _, err := io.Copy(io.MultiWriter(f, h, cw), resp.Body); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != a.SHA256 {
		_ = os.Remove(part)
		return fmt.Errorf("%s: checksum mismatch (got %s, want %s)", a.URL, got, a.SHA256)
	}
	return os.Rename(part, dest)
}

type counter struct {
	done   int64
	report func(int64)
}

func (c *counter) Write(b []byte) (int, error) {
	c.done += int64(len(b))
	c.report(c.done)
	return len(b), nil
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
