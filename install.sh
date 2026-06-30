#!/usr/bin/env bash
set -e

UUID="twingate-gnome@mhsiddiqui.github.io"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$DEST"
cp -R icons/ extension.js metadata.json stylesheet.css LICENSE "$DEST"

echo "Installed to $DEST"
echo "Run the following inside the new shell if not already enabled:"
echo "  gnome-extensions enable $UUID"
