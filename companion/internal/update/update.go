// Package update brings Dohra up to date from its GitHub releases: the
// extension's folder and the companion itself.
//
// Chrome never updates an extension loaded with "Load unpacked"; it only reads
// the folder again when the extension reloads. The companion runs as the user,
// so it can rewrite that folder, and the extension then reloads itself. Chrome
// records where each unpacked extension was loaded from in the profile's
// Preferences (extensions.settings.<id>.path), which is how the folder is found.
//
// Every file comes from the latest release and is checked against the release's
// SHA256SUMS before anything is replaced. A folder that is a development build
// (dist/ in a checkout) is never touched.
package update

import (
	"bufio"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/config"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/paths"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/setup"
)

// LatestURL is the GitHub API address of the newest release. Tests replace it,
// and DOHRA_UPDATE_URL does for the end-to-end test.
var LatestURL = cmp.Or(os.Getenv("DOHRA_UPDATE_URL"), "https://api.github.com/repos/SHIVAM-SHARMA-766/dohra/releases/latest")

const (
	ExtensionAsset = "dohra-extension.zip"
	SumsAsset      = "SHA256SUMS"
	// unpacked is Chrome's location code for an extension loaded with "Load unpacked".
	unpacked = 4
)

// Release is the newest published version and its files.
type Release struct {
	Version string            `json:"version"` // "0.6.1", without the v
	URL     string            `json:"url"`     // the release's page
	Notes   string            `json:"notes"`
	assets  map[string]asset  // by file name
	sums    map[string]string // file name -> SHA-256
}

type asset struct {
	URL  string
	Size int64
}

// CompanionAsset is this platform's companion binary in a release.
func CompanionAsset() string {
	name := fmt.Sprintf("dohra-companion-%s-%s", runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return name
}

// Latest asks GitHub for the newest release and reads its checksums.
func Latest(ctx context.Context) (Release, error) {
	var body struct {
		Tag    string `json:"tag_name"`
		URL    string `json:"html_url"`
		Notes  string `json:"body"`
		Assets []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
			Size int64  `json:"size"`
		} `json:"assets"`
	}
	if err := getJSON(ctx, LatestURL, &body); err != nil {
		return Release{}, fmt.Errorf("could not reach GitHub to check for updates: %w", err)
	}
	rel := Release{
		Version: strings.TrimPrefix(body.Tag, "v"),
		URL:     body.URL,
		Notes:   body.Notes,
		assets:  map[string]asset{},
		sums:    map[string]string{},
	}
	for _, a := range body.Assets {
		rel.assets[a.Name] = asset{URL: a.URL, Size: a.Size}
	}
	sums, ok := rel.assets[SumsAsset]
	if !ok {
		return Release{}, fmt.Errorf("release %s has no %s", body.Tag, SumsAsset)
	}
	text, err := get(ctx, sums.URL, 1<<20)
	if err != nil {
		return Release{}, fmt.Errorf("read %s: %w", SumsAsset, err)
	}
	sc := bufio.NewScanner(strings.NewReader(string(text)))
	for sc.Scan() {
		// sha256sum's format: "<hash>  <name>", with "*" before binary-mode names.
		fields := strings.Fields(sc.Text())
		if len(fields) == 2 {
			rel.sums[strings.TrimPrefix(fields[1], "*")] = fields[0]
		}
	}
	return rel, nil
}

// file is a release file as a pinned download, or an error if it is missing or unlisted.
func (r Release) file(name string) (config.Asset, error) {
	a, ok := r.assets[name]
	if !ok {
		return config.Asset{}, fmt.Errorf("release %s has no %s", r.Version, name)
	}
	sum, ok := r.sums[name]
	if !ok {
		return config.Asset{}, fmt.Errorf("%s is not in the release's %s", name, SumsAsset)
	}
	return config.Asset{URL: a.URL, SHA256: sum, Size: a.Size}, nil
}

// Newer reports whether version a is newer than b ("0.10.0" > "0.9.2"). Either
// one not numeric, such as a development build's "dev", means no: a build from
// source is never replaced by a release.
func Newer(a, b string) bool {
	pa, okA := parse(a)
	pb, okB := parse(b)
	if !okA || !okB {
		return false
	}
	for i := range pa {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return false
}

func parse(v string) ([3]int, bool) {
	var out [3]int
	parts := strings.Split(strings.TrimPrefix(v, "v"), ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// ---- where the extension is loaded from ----------------------------------------

// Place is a folder a browser profile loads Dohra from.
type Place struct {
	Dir string `json:"dir"`
	// Why it cannot be updated, or "" if it can.
	Skip string `json:"skip,omitempty"`
}

// FindExtension lists the folders Dohra is loaded unpacked from, in every
// profile of every supported browser, each folder once.
func FindExtension(browserDirs []string) []Place {
	seen := map[string]bool{}
	var places []Place
	for _, browser := range browserDirs {
		profiles, err := os.ReadDir(browser)
		if err != nil {
			continue
		}
		for _, p := range profiles {
			if !p.IsDir() {
				continue
			}
			for _, prefs := range []string{"Secure Preferences", "Preferences"} {
				dir := loadedFrom(filepath.Join(browser, p.Name(), prefs))
				if dir == "" || seen[dir] {
					continue
				}
				seen[dir] = true
				places = append(places, Place{Dir: dir, Skip: checkDir(dir)})
			}
		}
	}
	return places
}

func loadedFrom(prefsFile string) string {
	data, err := os.ReadFile(prefsFile)
	if err != nil {
		return ""
	}
	var prefs struct {
		Extensions struct {
			Settings map[string]struct {
				Location int    `json:"location"`
				Path     string `json:"path"`
			} `json:"settings"`
		} `json:"extensions"`
	}
	if json.Unmarshal(data, &prefs) != nil {
		return ""
	}
	s, ok := prefs.Extensions.Settings[config.ExtensionID]
	if !ok || s.Location != unpacked || !filepath.IsAbs(s.Path) {
		return ""
	}
	return filepath.Clean(s.Path)
}

// checkDir says why a folder must not be updated, or "" if it may.
func checkDir(dir string) string {
	var m struct {
		Name string `json:"name"`
	}
	data, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil || json.Unmarshal(data, &m) != nil || m.Name != "Dohra" {
		return "the folder no longer holds Dohra"
	}
	parent := filepath.Dir(dir)
	if exists(filepath.Join(parent, "package.json")) && exists(filepath.Join(parent, "src", "manifest.json")) {
		return "a development build: update it with git pull and npm run build"
	}
	return ""
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// ---- applying ---------------------------------------------------------------------

// Result says what Apply changed.
type Result struct {
	Version   string   `json:"version"`
	Updated   []string `json:"updated"`   // extension folders rewritten
	Companion bool     `json:"companion"` // the companion binary was replaced
}

// Apply updates every updatable folder in places to rel, then the companion
// itself when it is older than rel. Downloads go to DataDir/downloads.
func Apply(ctx context.Context, rel Release, places []Place, companionVersion string, log func(string, ...any)) (Result, error) {
	res := Result{Version: rel.Version}
	var targets []string
	for _, p := range places {
		if p.Skip == "" {
			targets = append(targets, p.Dir)
		}
	}
	if len(targets) > 0 {
		zipAsset, err := rel.file(ExtensionAsset)
		if err != nil {
			return res, err
		}
		archive := filepath.Join(paths.DataDir(), "downloads", "dohra-extension-"+rel.Version+".zip")
		if err := setup.Fetch(ctx, zipAsset, archive, func(int64) {}); err != nil {
			return res, err
		}
		for _, dir := range targets {
			if err := ReplaceFolder(archive, dir, rel.Version); err != nil {
				return res, fmt.Errorf("update %s: %w", dir, err)
			}
			log("updated extension in %s to %s", dir, rel.Version)
			res.Updated = append(res.Updated, dir)
		}
		_ = os.Remove(archive)
	}

	if Newer(rel.Version, companionVersion) {
		if err := replaceCompanion(ctx, rel, log); err != nil {
			return res, fmt.Errorf("update the companion: %w", err)
		}
		res.Companion = true
	}
	return res, nil
}

// ReplaceFolder writes the extension zip's files into dir; the zip must be for
// version. It is unpacked beside dir first and checked, so a bad download never
// touches dir.
func ReplaceFolder(archive, dir, version string) error {
	staging := dir + ".dohra-update"
	_ = os.RemoveAll(staging)
	defer os.RemoveAll(staging)
	if err := setup.Extract(archive, staging); err != nil {
		return err
	}
	var m struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	data, err := os.ReadFile(filepath.Join(staging, "manifest.json"))
	if err != nil || json.Unmarshal(data, &m) != nil || m.Name != "Dohra" || m.Version != version {
		return fmt.Errorf("the downloaded extension is not Dohra %s", version)
	}

	// Files are written over, never deleted: the folder is the user's, and may hold
	// other things too. A file an older version had and this one does not is
	// unused, and harmless.
	return filepath.WalkDir(staging, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(staging, p)
		return copyFile(p, filepath.Join(dir, rel))
	})
}

func copyFile(src, dest string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	tmp := dest + ".dohra-new"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, dest)
}

// replaceCompanion swaps in the release's companion binary, then runs its
// install, which fetches any newer whisper.cpp it pins. The browsers'
// registration already points at this path, so it is not redone.
// The running process carries on with the old code until the browser
// disconnects; the next connection starts the new one.
func replaceCompanion(ctx context.Context, rel Release, log func(string, ...any)) error {
	a, err := rel.file(CompanionAsset())
	if err != nil {
		return err
	}
	installed := filepath.Join(paths.BinDir(), paths.Exe("dohra-companion"))
	next := installed + ".next"
	if err := setup.Fetch(ctx, a, next, func(int64) {}); err != nil {
		return err
	}
	if err := os.Chmod(next, 0o755); err != nil {
		return err
	}
	// Windows cannot overwrite a running .exe, but can rename it.
	old := installed + ".old"
	_ = os.Remove(old)
	if err := os.Rename(installed, old); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := os.Rename(next, installed); err != nil {
		_ = os.Rename(old, installed)
		return err
	}
	if runtime.GOOS != "windows" {
		_ = os.Remove(old)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	out, err := exec.CommandContext(ctx, installed, "install", "--no-register").CombinedOutput()
	log("companion %s install: %s", rel.Version, strings.TrimSpace(string(out)))
	if err != nil {
		return fmt.Errorf("install %s: %w", rel.Version, err)
	}
	return nil
}

// ---- http -------------------------------------------------------------------------

var client = &http.Client{Timeout: 30 * time.Second}

func get(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "dohra-companion")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: %s", url, resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

func getJSON(ctx context.Context, url string, v any) error {
	data, err := get(ctx, url, 4<<20)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}
