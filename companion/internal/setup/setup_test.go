package setup

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/config"
)

type entry struct {
	name, body, link string
}

func makeTarGz(t *testing.T, entries ...entry) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "a.tar.gz")
	f, _ := os.Create(path)
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		if e.link != "" {
			_ = tw.WriteHeader(&tar.Header{Name: e.name, Typeflag: tar.TypeSymlink, Linkname: e.link})
			continue
		}
		_ = tw.WriteHeader(&tar.Header{Name: e.name, Typeflag: tar.TypeReg, Mode: 0o755, Size: int64(len(e.body))})
		_, _ = tw.Write([]byte(e.body))
	}
	tw.Close()
	gz.Close()
	f.Close()
	return path
}

func TestExtractTarGz(t *testing.T) {
	archive := makeTarGz(t,
		entry{name: "pkg/whisper-cli", body: "bin"},
		entry{name: "pkg/libggml.so.0", body: "lib"},
		entry{name: "pkg/libggml.so", link: "libggml.so.0"},
	)
	dir := t.TempDir()
	if err := Extract(archive, dir); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(filepath.Join(dir, "pkg", "libggml.so")); string(data) != "lib" {
		t.Fatalf("symlink not followed: %q", data)
	}
	if info, _ := os.Stat(filepath.Join(dir, "pkg", "whisper-cli")); info.Mode()&0o100 == 0 {
		t.Fatal("binary lost its executable bit")
	}
}

func TestExtractRejectsEscapes(t *testing.T) {
	for _, e := range []entry{
		{name: "../evil", body: "x"},
		{name: "pkg/../../evil", body: "x"},
		{name: "pkg/link", link: "../../etc/passwd"},
		{name: "pkg/abs", link: "/etc/passwd"},
	} {
		if err := Extract(makeTarGz(t, e), t.TempDir()); err == nil {
			t.Fatalf("entry %+v accepted", e)
		}
	}
}

func TestExtractZipRejectsEscape(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.zip")
	f, _ := os.Create(path)
	zw := zip.NewWriter(f)
	w, _ := zw.Create("../evil.exe")
	_, _ = w.Write([]byte("x"))
	zw.Close()
	f.Close()
	if err := Extract(path, t.TempDir()); err == nil {
		t.Fatal("zip slip accepted")
	}
}

func TestDownloadVerifiesChecksum(t *testing.T) {
	body := "model bytes"
	sum := sha256.Sum256([]byte(body))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, body) }))
	defer srv.Close()
	dest := filepath.Join(t.TempDir(), "m.bin")

	bad := config.Asset{URL: srv.URL, SHA256: strings.Repeat("0", 64), Size: int64(len(body))}
	if err := Download(context.Background(), bad, dest, io.Discard); err == nil {
		t.Fatal("checksum mismatch accepted")
	}
	if _, err := os.Stat(dest); err == nil {
		t.Fatal("a file that failed verification was left in place")
	}

	good := config.Asset{URL: srv.URL, SHA256: hex.EncodeToString(sum[:]), Size: int64(len(body))}
	if err := Download(context.Background(), good, dest, io.Discard); err != nil {
		t.Fatal(err)
	}
	if !Verify(dest, good.SHA256) {
		t.Fatal("downloaded file does not verify")
	}
}

func TestHostManifest(t *testing.T) {
	path, err := RegisterInDir(t.TempDir(), "/opt/dohra/dohra-companion")
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	data, _ := os.ReadFile(path)
	_ = json.Unmarshal(data, &m)
	if m["name"] != config.HostName || m["type"] != "stdio" || m["path"] != "/opt/dohra/dohra-companion" {
		t.Fatalf("manifest %v", m)
	}
	origins := m["allowed_origins"].([]any)
	if len(origins) != 1 || origins[0] != "chrome-extension://"+config.ExtensionID+"/" {
		t.Fatalf("origins %v", origins)
	}
}
