// sign signs Dohra releases with the maintainer's Ed25519 key. The companion
// installs an update only when the release's SHA256SUMS carries a valid signature
// from the public key built into it (internal/update), so a release published
// with stolen GitHub access, but without this key, is refused.
//
// The private key never goes to GitHub or CI: it lives on the maintainer's
// computer, and scripts/sign-release.sh signs a release after CI publishes it.
//
//	go run ./tools/sign keygen <private-key-file>    prints the public key to build in
//	go run ./tools/sign sign <private-key-file> <file>    writes <file>.sig
//	go run ./tools/sign verify <public-key> <file>    checks <file>.sig
//
// Key file: base64 of the 32-byte Ed25519 seed. Signature: base64 of the 64-byte
// signature over the file's bytes.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strings"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) < 2 {
		return errors.New("usage: sign keygen <key-file> | sign <key-file> <file> | verify <public-key> <file>")
	}
	switch args[0] {
	case "keygen":
		return keygen(args[1])
	case "sign":
		if len(args) != 3 {
			return errors.New("usage: sign sign <key-file> <file>")
		}
		return sign(args[1], args[2])
	case "verify":
		if len(args) != 3 {
			return errors.New("usage: sign verify <public-key> <file>")
		}
		return verify(args[1], args[2])
	}
	return fmt.Errorf("unknown command %q", args[0])
}

func keygen(path string) error {
	if _, err := os.Stat(path); err == nil {
		return fmt.Errorf("%s already exists; refusing to replace a release key", path)
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	seed := base64.StdEncoding.EncodeToString(priv.Seed())
	if err := os.WriteFile(path, []byte(seed+"\n"), 0o600); err != nil {
		return err
	}
	fmt.Println(base64.StdEncoding.EncodeToString(pub))
	return nil
}

func loadKey(path string) (ed25519.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	seed, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("%s is not a release key", path)
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

func sign(keyPath, file string) error {
	key, err := loadKey(keyPath)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(key, data))
	if err := os.WriteFile(file+".sig", []byte(sig+"\n"), 0o644); err != nil {
		return err
	}
	fmt.Printf("%s.sig (public key %s)\n", file, base64.StdEncoding.EncodeToString(key.Public().(ed25519.PublicKey)))
	return nil
}

func verify(publicKey, file string) error {
	pub, err := base64.StdEncoding.DecodeString(publicKey)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return errors.New("not an Ed25519 public key")
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(file + ".sig")
	if err != nil {
		return err
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || !ed25519.Verify(pub, data, sig) {
		return fmt.Errorf("%s.sig does not match %s for this key", file, file)
	}
	fmt.Println("signature OK")
	return nil
}
