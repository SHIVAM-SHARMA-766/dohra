#!/bin/sh
# Signs and publishes a draft release made by the release workflow.
#
#   scripts/sign-release.sh v0.7.0 [private-key-file]
#
# It downloads every file of the draft, checks each against SHA256SUMS (and that
# SHA256SUMS lists them all), signs SHA256SUMS with the maintainer's Ed25519 key,
# checks the signature against the public key built into the companion, uploads
# SHA256SUMS.sig, and publishes the release. Installed copies update only to a
# release signed this way (companion/internal/update).
#
# The key comes from, in order: the file given as the second argument, the file
# named by $DOHRA_RELEASE_KEY, or the key itself in $DOHRA_RELEASE_SIGNING_KEY_B64
# (as kept in a credentials .env: `set -a; . path/to/.env; set +a`). It stays on
# this computer: never commit it, and keep a backup somewhere safe, since releases
# cannot be signed without it. Needs gh (logged in), sha256sum and Go.
set -eu

repo=SHIVAM-SHARMA-766/dohra
tag=${1:?usage: scripts/sign-release.sh <tag> [private-key-file]}
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
key=${2:-${DOHRA_RELEASE_KEY:-}}
if [ -z "$key" ]; then
  : "${DOHRA_RELEASE_SIGNING_KEY_B64:?pass the private key file, or set DOHRA_RELEASE_KEY or DOHRA_RELEASE_SIGNING_KEY_B64}"
  key="$work/release.key"
  (umask 077 && printf '%s\n' "$DOHRA_RELEASE_SIGNING_KEY_B64" > "$key")
fi

echo "Downloading $tag"
gh release download "$tag" --repo "$repo" --dir "$work" --pattern '*'
rm -f "$work/SHA256SUMS.sig"

echo "Checking every file against SHA256SUMS"
(cd "$work" && sha256sum --quiet -c SHA256SUMS)
for f in "$work"/*; do
  name=$(basename "$f")
  [ "$name" = SHA256SUMS ] && continue
  grep -q "  $name\$" "$work/SHA256SUMS" || { echo "$name is not listed in SHA256SUMS" >&2; exit 1; }
done

echo "Signing"
public=$(sed -n 's/^var releaseKey = "\(.*\)"$/\1/p' "$root/companion/internal/update/update.go")
(cd "$root/companion" && go run ./tools/sign sign "$key" "$work/SHA256SUMS" && go run ./tools/sign verify "$public" "$work/SHA256SUMS")

echo "Publishing"
gh release upload "$tag" "$work/SHA256SUMS.sig" --repo "$repo" --clobber
gh release edit "$tag" --repo "$repo" --draft=false --latest
echo "Done: https://github.com/$repo/releases/tag/$tag"
