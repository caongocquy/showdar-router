#!/usr/bin/env bash
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  TARGET="$(readlink "$SOURCE")"
  [[ "$TARGET" == /* ]] && SOURCE="$TARGET" || SOURCE="$DIR/$TARGET"
done
ROOT="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"
mkdir -p "$HOME/.local/bin"
ln -sf "$ROOT/showdar-router" "$HOME/.local/bin/showdar-router"
echo "Installed showdar-router -> $ROOT/showdar-router"
