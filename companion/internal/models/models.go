// Package models downloads, lists and removes speech models on request from
// Dohra's setup and settings pages.
//
// A download runs in the background and reports progress as events, so the page
// can show a progress bar; it carries on if the page is closed, for as long as
// the browser keeps the companion running. An interrupted download is continued,
// not restarted, the next time it is requested.
package models

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/config"
)

// Info describes one model for the extension.
type Info struct {
	Name        string `json:"name"`
	Label       string `json:"label"`
	Size        int64  `json:"size"`
	Installed   bool   `json:"installed"`
	Active      bool   `json:"active"`
	Downloading bool   `json:"downloading"`
	Done        int64  `json:"done"`            // bytes so far, while downloading
	Error       string `json:"error,omitempty"` // why the last download failed
}

// Events sent to the extension.
type (
	Progress struct {
		Type  string `json:"type"` // "model-progress"
		Model string `json:"model"`
		Done  int64  `json:"done"`
		Size  int64  `json:"size"`
	}
	Finished struct {
		Type  string `json:"type"` // "model-done"
		Model string `json:"model"`
		Error string `json:"error,omitempty"`
	}
)

// Fetcher downloads an asset; setup.Fetch in production.
type Fetcher func(ctx context.Context, a config.Asset, dest string, report func(done int64)) error

type download struct {
	cancel context.CancelFunc
	done   int64
}

type Manager struct {
	fetch Fetcher
	emit  func(any)
	// installed is called after a model finishes downloading.
	installed func(name string)

	mu        sync.Mutex
	downloads map[string]*download
	failed    map[string]string
	wg        sync.WaitGroup
}

// ReportEvery limits progress events to a few per second.
const ReportEvery = 250 * time.Millisecond

func New(fetch Fetcher, emit func(any), installed func(name string)) *Manager {
	return &Manager{fetch: fetch, emit: emit, installed: installed, downloads: map[string]*download{}, failed: map[string]string{}}
}

// List reports every model in the catalogue, from fastest to most accurate.
func (m *Manager) List(active string) []Info {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Info, 0, len(config.ModelNames))
	for _, name := range config.ModelNames {
		model := config.Models[name]
		info := Info{
			Name: name, Label: model.Label, Size: model.Size,
			Installed: config.Installed(name), Error: m.failed[name],
		}
		info.Active = info.Installed && name == active
		if d, ok := m.downloads[name]; ok {
			info.Downloading, info.Done = true, d.done
		}
		out = append(out, info)
	}
	return out
}

// Busy reports whether any download is running.
func (m *Manager) Busy() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.downloads) > 0
}

// Install starts downloading a model. It returns at once; progress and the
// result arrive as events.
func (m *Manager) Install(ctx context.Context, name string) error {
	model, ok := config.Models[name]
	if !ok {
		return fmt.Errorf("unknown model %q", name)
	}
	if config.Installed(name) {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.downloads[name]; ok {
		return nil // already on its way
	}
	ctx, cancel := context.WithCancel(ctx)
	d := &download{cancel: cancel}
	m.downloads[name] = d
	delete(m.failed, name)

	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		defer cancel()
		var last time.Time
		err := m.fetch(ctx, model.Asset, config.ModelPath(name), func(done int64) {
			m.mu.Lock()
			d.done = done
			m.mu.Unlock()
			if time.Since(last) >= ReportEvery {
				last = time.Now()
				m.emit(Progress{Type: "model-progress", Model: name, Done: done, Size: model.Size})
			}
		})
		if err == nil {
			// The voice detector is part of the companion install, but a model is no
			// use without it; fetch it here too in case it went missing.
			err = m.fetch(ctx, config.VAD.Asset, config.VADPath(), func(int64) {})
		}
		m.mu.Lock()
		delete(m.downloads, name)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				err = errors.New("cancelled")
			}
			m.failed[name] = err.Error()
		}
		m.mu.Unlock()

		if err == nil && m.installed != nil {
			m.installed(name)
		}
		ev := Finished{Type: "model-done", Model: name}
		if err != nil {
			ev.Error = err.Error()
		}
		m.emit(ev)
	}()
	return nil
}

// Cancel stops a running download. What has arrived is kept, so installing it
// again continues from there.
func (m *Manager) Cancel(name string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if d, ok := m.downloads[name]; ok {
		d.cancel()
	}
}

// Remove deletes a model from disk, along with any half-finished download of it.
// The active model cannot be removed: switch to another first.
func (m *Manager) Remove(name, active string) error {
	if _, ok := config.Models[name]; !ok {
		return fmt.Errorf("unknown model %q", name)
	}
	if name == active && config.Installed(name) {
		return errors.New("this model is in use; switch to another one before removing it")
	}
	m.mu.Lock()
	_, downloading := m.downloads[name]
	delete(m.failed, name)
	m.mu.Unlock()
	if downloading {
		return errors.New("this model is still downloading; cancel it first")
	}
	for _, p := range []string{config.ModelPath(name), config.ModelPath(name) + ".part"} {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

// Wait blocks until every download has ended; for tests and shutdown.
func (m *Manager) Wait() { m.wg.Wait() }
