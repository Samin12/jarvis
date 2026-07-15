#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODE="${1:-development}"
OUTPUT="${2:-artifacts}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS packaging must run on macOS" >&2
  exit 64
fi

case "$MODE" in
  development|release) ;;
  *)
    echo "mode must be 'development' or 'release'" >&2
    exit 64
    ;;
esac

case "$OUTPUT" in
  artifacts|dir) ;;
  *)
    echo "output must be 'artifacts' or 'dir'" >&2
    exit 64
    ;;
esac

cd "$REPO_ROOT"

HOST_ARCH="$(node -p 'process.arch')"
ELECTRON_ARCH="${TARGET_ARCH:-$HOST_ARCH}"
case "$ELECTRON_ARCH" in
  arm64)
    SWIFT_ARCH="arm64"
    RESOURCE_ARCH="arm64"
    BUILDER_ARCH="--arm64"
    ;;
  x64)
    SWIFT_ARCH="x86_64"
    RESOURCE_ARCH="x86_64"
    BUILDER_ARCH="--x64"
    ;;
  *)
    echo "unsupported Electron architecture: $ELECTRON_ARCH" >&2
    exit 64
    ;;
esac

if [[ "$HOST_ARCH" != "$ELECTRON_ARCH" ]]; then
  echo "cross-packaging is prohibited: runner is $HOST_ARCH, target is $ELECTRON_ARCH" >&2
  exit 64
fi

if [[ -n "${JARVIS_MACOS_SPEECH_ARCH:-}" && "$JARVIS_MACOS_SPEECH_ARCH" != "$SWIFT_ARCH" ]]; then
  echo "JARVIS_MACOS_SPEECH_ARCH does not match target architecture" >&2
  exit 64
fi
if [[ -n "${JARVIS_MACOS_SPEECH_RESOURCE_ARCH:-}" && "$JARVIS_MACOS_SPEECH_RESOURCE_ARCH" != "$RESOURCE_ARCH" ]]; then
  echo "JARVIS_MACOS_SPEECH_RESOURCE_ARCH does not match target architecture" >&2
  exit 64
fi

export JARVIS_MACOS_SPEECH_ARCH="$SWIFT_ARCH"
export JARVIS_MACOS_SPEECH_RESOURCE_ARCH="$RESOURCE_ARCH"

if [[ "${JARVIS_SKIP_APP_BUILD:-0}" != "1" ]]; then
  npm run build
fi
npm run build:native:mac
npm run verify:native-stage

BUILDER=("$REPO_ROOT/node_modules/.bin/electron-builder")
if [[ "$MODE" == "release" ]]; then
  npm run verify:release-secrets
  BUILDER+=(--config electron-builder.release.yml)
fi
BUILDER+=(--mac "$BUILDER_ARCH" --publish never)
if [[ "$OUTPUT" == "dir" ]]; then
  BUILDER+=(--dir)
fi

"${BUILDER[@]}"
