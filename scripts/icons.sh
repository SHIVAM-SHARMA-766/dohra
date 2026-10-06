#!/bin/sh
# Renders src/icons/icon.svg to the PNG sizes the manifest uses. ImageMagick's own SVG
# renderer drops arcs, so a headless Chromium draws it and ImageMagick only resizes.
# The PNGs are committed, so this only runs when the icon changes.
set -eu
cd "$(dirname "$0")/../src/icons"
CHROME="${CHROME:-chromium}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

printf '<body style="margin:0"><img src="file://%s/icon.svg" width="512" height="512">' "$PWD" > "$tmp/icon.html"
"$CHROME" --headless --disable-gpu --hide-scrollbars --default-background-color=00000000 \
  --window-size=512,512 --screenshot="$tmp/icon.png" "$tmp/icon.html" 2>/dev/null
for size in 16 32 48 128; do
  convert "$tmp/icon.png" -resize "${size}x${size}" "$size.png"
done
echo "icons written to src/icons/"
