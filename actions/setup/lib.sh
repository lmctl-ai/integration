#!/usr/bin/env bash
# Shared helpers for the setup action. Sourced, never executed.

die() { echo "::error::$*" >&2; echo "ERROR: $*" >&2; exit 1; }
note() { echo "$*"; if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$*" >> "$GITHUB_STEP_SUMMARY"; fi; }
set_output() { if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi; }
add_path() { if [ -n "${GITHUB_PATH:-}" ]; then echo "$1" >> "$GITHUB_PATH"; fi; export PATH="$1:$PATH"; }

# Scratch root: RUNNER_TEMP on a runner, a private mktemp dir otherwise. Never the home directory.
scratch_root() {
  if [ -n "${INTEGRATION_TEMP:-}" ]; then echo "$INTEGRATION_TEMP"; return; fi
  if [ -n "${RUNNER_TEMP:-}" ]; then echo "$RUNNER_TEMP"; return; fi
  mktemp -d
}

# Platform names used by release assets: NAME-{linux,macos}-{x64,arm64}, NAME-windows-x64.exe
platform_os() {
  if [ -n "${INTEGRATION_OS:-}" ]; then echo "$INTEGRATION_OS"; return; fi
  case "$(uname -s)" in
    Linux*) echo linux ;;
    Darwin*) echo macos ;;
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    *) die "unsupported operating system: $(uname -s)" ;;
  esac
}
platform_arch() {
  if [ -n "${INTEGRATION_ARCH:-}" ]; then echo "$INTEGRATION_ARCH"; return; fi
  case "$(uname -m)" in
    x86_64|amd64) echo x64 ;;
    aarch64|arm64) echo arm64 ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
}
asset_name() { # NAME
  local os arch
  os=$(platform_os); arch=$(platform_arch)
  if [ "$os" = windows ]; then echo "$1-windows-x64.exe"; else echo "$1-$os-$arch"; fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Bounded retry for network downloads only. Verification and tests never retry.
retry_download() { # attempts command...
  local attempts=$1 n=1; shift
  until "$@"; do
    if [ "$n" -ge "$attempts" ]; then return 1; fi
    echo "download failed (attempt $n of $attempts); retrying" >&2
    n=$((n + 1)); sleep $((n * 2))
  done
}
