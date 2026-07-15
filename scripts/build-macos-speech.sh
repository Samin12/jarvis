#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGE_PATH="$REPO_ROOT/native/macos-speech"
STAGE_ROOT="$REPO_ROOT/build/native/macos-speech"
CONFIGURATION="${1:-release}"
ARCHITECTURE="${JARVIS_MACOS_SPEECH_ARCH:-$(uname -m)}"

case "$CONFIGURATION" in
  debug|release) ;;
  *)
    echo "configuration must be 'debug' or 'release'" >&2
    exit 64
    ;;
esac

case "$ARCHITECTURE" in
  arm64)
    RESOURCE_ARCH="arm64"
    ;;
  x86_64)
    RESOURCE_ARCH="x86_64"
    ;;
  *)
    echo "unsupported macOS architecture: $ARCHITECTURE" >&2
    exit 64
    ;;
esac

for HELPER_NAME in jarvis-macos-speech jarvis-workspace-helper; do
  swift build \
    --package-path "$PACKAGE_PATH" \
    --configuration "$CONFIGURATION" \
    --arch "$ARCHITECTURE" \
    --product "$HELPER_NAME"
done

BIN_DIR="$(swift build \
  --package-path "$PACKAGE_PATH" \
  --configuration "$CONFIGURATION" \
  --arch "$ARCHITECTURE" \
  --show-bin-path)"
EXPECTED_RESOURCE_ARCH="${JARVIS_MACOS_SPEECH_RESOURCE_ARCH:-$RESOURCE_ARCH}"

if [[ "$EXPECTED_RESOURCE_ARCH" != "$RESOURCE_ARCH" ]]; then
  echo "resource architecture $EXPECTED_RESOURCE_ARCH does not match Swift architecture $ARCHITECTURE" >&2
  exit 64
fi

STAGE_DIR="$STAGE_ROOT/$RESOURCE_ARCH"
install -d -m 0755 "$STAGE_DIR"

# Treat the generated staging tree as a two-file allowlist. Refuse to overwrite
# a contaminated tree instead of silently packaging an unexpected native file.
shopt -s dotglob nullglob
for ENTRY in "$STAGE_ROOT"/*; do
  if [[ "$ENTRY" != "$STAGE_DIR" ]]; then
    echo "unexpected native staging entry: $ENTRY" >&2
    exit 65
  fi
done
for ENTRY in "$STAGE_DIR"/*; do
  case "$(basename "$ENTRY")" in
    jarvis-macos-speech|jarvis-workspace-helper)
      if [[ -L "$ENTRY" || ! -f "$ENTRY" ]]; then
        echo "native staging entry must be a physical file: $ENTRY" >&2
        exit 65
      fi
      ;;
    *)
      echo "unexpected native helper staging entry: $ENTRY" >&2
      exit 65
      ;;
  esac
done

for HELPER_NAME in jarvis-macos-speech jarvis-workspace-helper; do
  BINARY_PATH="$BIN_DIR/$HELPER_NAME"
  STAGED_BINARY="$STAGE_DIR/$HELPER_NAME"
  if [[ -L "$BINARY_PATH" || ! -f "$BINARY_PATH" || ! -x "$BINARY_PATH" ]]; then
    echo "Swift did not produce a physical executable: $BINARY_PATH" >&2
    exit 65
  fi
  test -x "$BINARY_PATH"
  install -m 0755 "$BINARY_PATH" "$STAGED_BINARY"
  if [[ "$HELPER_NAME" == "jarvis-macos-speech" ]]; then
    ENTITLEMENTS="$REPO_ROOT/build/entitlements.mac.speech.plist"
  else
    ENTITLEMENTS="$REPO_ROOT/build/entitlements.mac.tools.plist"
  fi
  /usr/bin/plutil -lint "$ENTITLEMENTS" >/dev/null
  /usr/bin/codesign \
    --force \
    --sign - \
    --timestamp=none \
    --entitlements "$ENTITLEMENTS" \
    "$STAGED_BINARY"
  /usr/bin/codesign --verify --strict "$STAGED_BINARY"
  test -x "$STAGED_BINARY"
  file "$STAGED_BINARY"
  lipo -archs "$STAGED_BINARY" | grep -qw "$ARCHITECTURE"
  shasum -a 256 "$STAGED_BINARY"
  echo "$STAGED_BINARY"
done
