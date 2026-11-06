package update

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/config"
)

func TestNewer(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"0.6.1", "0.6.0", true},
		{"0.10.0", "0.9.2", true},
		{"1.0.0", "0.99.99", true},
		{"0.6.0", "0.6.0", false},
		{"0.5.9", "0.6.0", false},
		{"v0.7.0", "0.6.0", true},
		{"0.7.0", "dev", false},
		{"dev", "0.1.0", false},
	} {
		if got := Newer(c.a, c.b); got != c.want {
			t.Errorf("Newer(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func extensionZip(t *testing.T, version string, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	all := map[string]string{"manifest.json": fmt.Sprintf(`{"name":"Dohra","version":%q}`, version)}
	for k, v := range files {
		all[k] = v
	}
	for name, body := range all {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(body))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// signing says how fakeGitHub signs SHA256SUMS: with the key the companion trusts,
// another key, or not at all.
type signing int

const (
	signed signing = iota
	wrongKey
	unsigned
)

// trustKey makes the companion trust a fresh test key for this test and returns it.
func trustKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	old := releaseKey
	releaseKey = base64.StdEncoding.EncodeToString(pub)
	t.Cleanup(func() { releaseKey = old })
	return priv
}

// fakeGitHub serves github.com's releases as Dohra reads them: /latest
// redirects to the tag, files are under /download/<tag>/. A corrupt zip is
// listed with the checksum of the good one.
func fakeGitHub(t *testing.T, version string, zipBytes []byte, corrupt bool, sig ...signing) {
	t.Helper()
	key := trustKey(t)
	sum := sha256.Sum256(zipBytes)
	served := zipBytes
	if corrupt {
		served = append(append([]byte{}, zipBytes...), 'x')
	}
	sums := fmt.Sprintf("%s  %s\n%s  other-file\n", hex.EncodeToString(sum[:]), ExtensionAsset, strings.Repeat("0", 64))
	mode := signed
	if len(sig) > 0 {
		mode = sig[0]
	}
	tag := "v" + version
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	mux.HandleFunc("/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, srv.URL+"/releases/tag/"+tag, http.StatusFound)
	})
	mux.HandleFunc("/releases/download/"+tag+"/"+SumsAsset, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, sums) })
	if mode != unsigned {
		signer := key
		if mode == wrongKey {
			_, signer, _ = ed25519.GenerateKey(rand.Reader)
		}
		mux.HandleFunc("/releases/download/"+tag+"/"+SigAsset, func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprintln(w, base64.StdEncoding.EncodeToString(ed25519.Sign(signer, []byte(sums))))
		})
	}
	mux.HandleFunc("/releases/download/"+tag+"/"+ExtensionAsset, func(w http.ResponseWriter, r *http.Request) { w.Write(served) })
	old := ReleasesURL
	ReleasesURL = srv.URL + "/releases"
	t.Cleanup(func() { ReleasesURL = old })
}

func TestLatestRequiresTheReleaseKey(t *testing.T) {
	zip := extensionZip(t, "0.7.0", nil)
	fakeGitHub(t, "0.7.0", zip, false)
	if _, err := Latest(context.Background()); err != nil {
		t.Fatalf("signed release refused: %v", err)
	}
	for _, c := range []struct {
		name string
		mode signing
		want string
	}{
		{"unsigned", unsigned, "not signed yet"},
		{"signed with another key", wrongKey, "not signed with Dohra's release key"},
	} {
		t.Run(c.name, func(t *testing.T) {
			fakeGitHub(t, "0.7.0", zip, false, c.mode)
			_, err := Latest(context.Background())
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("error %v, want %q", err, c.want)
			}
		})
	}
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func prefs(dir string, location int) string {
	b, _ := json.Marshal(map[string]any{"extensions": map[string]any{"settings": map[string]any{
		config.ExtensionID:     map[string]any{"location": location, "path": dir},
		"someotherextensionid": map[string]any{"location": unpacked, "path": "/elsewhere"},
	}}})
	return string(b)
}

func TestFindExtension(t *testing.T) {
	root := t.TempDir()
	friend := filepath.Join(root, "Downloads", "dohra")
	write(t, filepath.Join(friend, "manifest.json"), `{"name":"Dohra","version":"0.5.0"}`)
	dev := filepath.Join(root, "code", "dohra", "dist")
	write(t, filepath.Join(dev, "manifest.json"), `{"name":"Dohra","version":"0.6.0"}`)
	write(t, filepath.Join(root, "code", "dohra", "package.json"), `{}`)
	write(t, filepath.Join(root, "code", "dohra", "src", "manifest.json"), `{}`)
	gone := filepath.Join(root, "deleted")

	chrome := filepath.Join(root, "chrome")
	write(t, filepath.Join(chrome, "Default", "Preferences"), prefs(friend, unpacked))
	write(t, filepath.Join(chrome, "Profile 1", "Secure Preferences"), prefs(dev, unpacked))
	write(t, filepath.Join(chrome, "Profile 2", "Preferences"), prefs(friend, unpacked)) // same folder again
	write(t, filepath.Join(chrome, "Profile 3", "Preferences"), prefs(gone, unpacked))
	write(t, filepath.Join(chrome, "Profile 4", "Preferences"), prefs(friend, 1)) // from the store
	brave := filepath.Join(root, "brave")
	write(t, filepath.Join(brave, "Default", "Preferences"), "not json")

	got := FindExtension([]string{chrome, brave, filepath.Join(root, "missing")})
	byDir := map[string]string{}
	for _, p := range got {
		byDir[p.Dir] = p.Skip
	}
	if len(got) != 3 {
		t.Fatalf("found %d places, want 3: %+v", len(got), got)
	}
	if s, ok := byDir[friend]; !ok || s != "" {
		t.Errorf("friend's folder: skip %q, found %v", s, ok)
	}
	if !strings.Contains(byDir[dev], "development build") {
		t.Errorf("dev folder: skip %q", byDir[dev])
	}
	if !strings.Contains(byDir[gone], "no longer holds Dohra") {
		t.Errorf("deleted folder: skip %q", byDir[gone])
	}
}

func TestApplyUpdatesFolder(t *testing.T) {
	t.Setenv("DOHRA_HOME", t.TempDir())
	dir := filepath.Join(t.TempDir(), "dohra")
	write(t, filepath.Join(dir, "manifest.json"), `{"name":"Dohra","version":"0.5.0"}`)
	write(t, filepath.Join(dir, "popup.js"), "old popup")
	write(t, filepath.Join(dir, "notes.txt"), "the user's own file")
	fakeGitHub(t, "0.6.0", extensionZip(t, "0.6.0", map[string]string{"popup.js": "new popup", "lib/x.js": "x"}), false)

	rel, err := Latest(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if rel.Version != "0.6.0" || !strings.HasSuffix(rel.URL, "/releases/tag/v0.6.0") {
		t.Fatalf("release %+v", rel)
	}
	places := []Place{{Dir: dir}, {Dir: "/never/touched", Skip: "a development build"}}
	// The companion is already this version, so only the folder changes.
	res, err := Apply(context.Background(), rel, places, "0.6.0", t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Updated) != 1 || res.Updated[0] != dir || res.Companion {
		t.Fatalf("result %+v", res)
	}
	for name, want := range map[string]string{
		"popup.js":  "new popup",
		"lib/x.js":  "x",
		"notes.txt": "the user's own file",
	} {
		got, _ := os.ReadFile(filepath.Join(dir, name))
		if string(got) != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	if m, _ := os.ReadFile(filepath.Join(dir, "manifest.json")); !strings.Contains(string(m), `"0.6.0"`) {
		t.Errorf("manifest not updated: %s", m)
	}
	if _, err := os.Stat(dir + ".dohra-update"); !os.IsNotExist(err) {
		t.Errorf("staging folder left behind")
	}
}

func TestApplyRefusesBadDownload(t *testing.T) {
	t.Setenv("DOHRA_HOME", t.TempDir())
	dir := filepath.Join(t.TempDir(), "dohra")
	write(t, filepath.Join(dir, "manifest.json"), `{"name":"Dohra","version":"0.5.0"}`)
	write(t, filepath.Join(dir, "popup.js"), "old popup")

	for _, c := range []struct {
		name    string
		zip     []byte
		corrupt bool
	}{
		{"checksum mismatch", extensionZip(t, "0.6.0", map[string]string{"popup.js": "evil"}), true},
		{"zip for another version", extensionZip(t, "0.5.5", map[string]string{"popup.js": "wrong"}), false},
	} {
		t.Run(c.name, func(t *testing.T) {
			fakeGitHub(t, "0.6.0", c.zip, c.corrupt)
			rel, err := Latest(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if _, err := Apply(context.Background(), rel, []Place{{Dir: dir}}, "0.6.0", t.Logf); err == nil {
				t.Fatal("no error")
			}
			if got, _ := os.ReadFile(filepath.Join(dir, "popup.js")); string(got) != "old popup" {
				t.Errorf("folder changed: popup.js = %q", got)
			}
		})
	}
}
