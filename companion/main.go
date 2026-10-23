// dohra-companion transcribes Dohra recordings on this computer.
//
// The browser starts it through native messaging (it is passed the extension's
// origin as its first argument); everything else is a command run by hand:
//
//	dohra-companion install [--model medium|small|both]
//	dohra-companion status
//	dohra-companion bench <file.wav>
//	dohra-companion uninstall [--purge]
//	dohra-companion register --browser-dir <dir>   (development and tests)
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"time"

	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/config"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/engine"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/host"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/nm"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/paths"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/setup"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/store"
	"github.com/SHIVAM-SHARMA-766/dohra/companion/internal/whisper"
)

var version = "dev" // set at build time with -ldflags "-X main.version=..."

func main() {
	cmd := ""
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	var err error
	switch cmd {
	case "install":
		err = install(os.Args[2:])
	case "uninstall":
		fs := flag.NewFlagSet("uninstall", flag.ExitOnError)
		purge := fs.Bool("purge", false, "also delete models, config and unfinished transcripts")
		_ = fs.Parse(os.Args[2:])
		err = setup.Uninstall(*purge, os.Stdout)
	case "status":
		err = status()
	case "bench":
		err = bench(os.Args[2:])
	case "register":
		fs := flag.NewFlagSet("register", flag.ExitOnError)
		dir := fs.String("browser-dir", "", "browser user-data directory to register in")
		_ = fs.Parse(os.Args[2:])
		err = registerIn(*dir)
	case "version", "--version":
		fmt.Println(version)
	case "help", "-h", "--help":
		usage()
	default:
		// Started by the browser. stdout is the message channel, so nothing else
		// may be printed; diagnostics go to the log file.
		err = serve()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Print(`dohra-companion — local transcription for Dohra

  install [--model medium|small|both]   download whisper.cpp and models, register with the browser
  status                                show what is installed and what is in progress
  bench <file.wav>                      time the configured model on a 16 kHz WAV
  uninstall [--purge]                   unregister; --purge also deletes all downloaded files
  version
`)
}

func install(args []string) error {
	fs := flag.NewFlagSet("install", flag.ExitOnError)
	model := fs.String("model", "medium", "medium, small, or both")
	_ = fs.Parse(args)
	models := []string{*model}
	if *model == "both" {
		models = []string{"medium", "small"}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	return setup.Install(ctx, setup.Options{Models: models, Out: os.Stdout})
}

func registerIn(dir string) error {
	if dir == "" {
		return fmt.Errorf("--browser-dir is required")
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	path, err := setup.RegisterInDir(dir, exe)
	if err == nil {
		fmt.Println(path)
	}
	return err
}

func status() error {
	cfg, err := config.Load()
	fmt.Printf("version     %s\ndata        %s\nmodel       %s\nlanguage    %s\nthreads     %d while recording, %d after\n",
		version, paths.DataDir(), cfg.Model, cfg.Language, cfg.LiveThreads, cfg.IdleThreads)
	if err != nil {
		fmt.Println("config      ", err)
	}
	if p, err := config.FindWhisper(); err == nil {
		fmt.Printf("whisper     %s\n", p)
	}
	problems := config.Problems(cfg)
	if len(problems) == 0 {
		fmt.Println("ready       yes")
	}
	for _, p := range problems {
		fmt.Println("problem    ", p)
	}
	metas, _ := store.New(paths.SessionsDir()).List()
	for _, m := range metas {
		if m.State != store.Complete {
			fmt.Printf("session     %s  %s %s\n", m.ID, m.State, m.Error)
		}
	}
	return nil
}

func bench(args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: dohra-companion bench <file.wav>")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if problems := config.Problems(cfg); len(problems) > 0 {
		return fmt.Errorf("%s", strings.Join(problems, "; "))
	}
	bin, _ := config.FindWhisper()
	info, err := os.Stat(args[0])
	if err != nil {
		return err
	}
	seconds := float64(info.Size()-44) / 32000 // 16 kHz, 16-bit, mono
	for _, threads := range []int{cfg.LiveThreads, cfg.IdleThreads} {
		start := time.Now()
		cmd := exec.Command(bin, "-m", config.ModelPath(cfg.Model), "-f", args[0], "-t", fmt.Sprint(threads), "-l", "auto", "-np")
		cmd.Stdout = io.Discard
		if err := cmd.Run(); err != nil {
			return err
		}
		took := time.Since(start).Seconds()
		fmt.Printf("%s, %d threads: %.0f s of audio in %.0f s — %.2fx real time\n", cfg.Model, threads, seconds, took, seconds/took)
	}
	return nil
}

func serve() error {
	if err := os.MkdirAll(paths.DataDir(), 0o700); err != nil {
		return err
	}
	if info, err := os.Stat(paths.LogFile()); err == nil && info.Size() > 5<<20 {
		_ = os.Rename(paths.LogFile(), paths.LogFile()+".old")
	}
	logFile, err := os.OpenFile(paths.LogFile(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer logFile.Close()
	logger := log.New(logFile, "", log.LstdFlags)
	logger.Printf("started %s (args %q)", version, os.Args[1:])

	cfg, cfgErr := config.Load()
	problems := config.Problems(cfg)
	if cfgErr != nil {
		problems = append(problems, cfgErr.Error())
	}
	out := nm.NewWriter(os.Stdout)
	h := &host.Host{
		Hello: host.Hello{Version: version, Ready: len(problems) == 0, Problems: problems, Model: cfg.Model, Language: cfg.Language},
		Out:   out,
		Log:   logger,
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if h.Hello.Ready {
		bin, _ := config.FindWhisper()
		vad := config.VADPath()
		if _, err := os.Stat(vad); err != nil {
			vad = ""
		}
		emit := func(v any) {
			if err := out.Send(v); err != nil {
				logger.Printf("send: %v", err)
			}
		}
		e := engine.New(engine.Config{
			Whisper: bin, Model: config.ModelPath(cfg.Model), ModelName: cfg.Model, VAD: vad,
			LiveThreads: cfg.LiveThreads, IdleThreads: cfg.IdleThreads,
		}, store.New(paths.SessionsDir()), emit, whisper.Run, logger)
		if err := e.Resume(); err != nil {
			logger.Printf("resume: %v", err)
		}
		go e.Work(ctx)
		h.Engine = e
	} else {
		logger.Printf("not ready: %v", problems)
	}

	err = h.Serve(ctx, os.Stdin)
	logger.Printf("disconnected: %v", err)
	return err
}
