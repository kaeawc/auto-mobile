#!/usr/bin/env bats
#
# Tests for scripts/ktfmt/install_ktfmt.sh -- specifically that the macOS path
# HONORS THE PIN (issue #2966). Homebrew has no `ktfmt@<version>` formula, so
# `brew install ktfmt` installs whatever the current formula ships. When that
# differs from KTFMT_VERSION the installer must fall back to the pinned fat JAR
# (install_manual) rather than leaving a drifted formatter in place.
#
# brew / java / curl / uname / ktfmt are all stubbed so the test is fast,
# deterministic, and performs no network or system installs.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/ktfmt/install_ktfmt.sh"

  TEST_DIR="$(mktemp -d)"
  STUB_BIN="$TEST_DIR/bin"
  mkdir -p "$STUB_BIN"

  # Sandbox HOME so install_manual writes into the temp dir, not the real ~.
  export HOME="$TEST_DIR/home"
  mkdir -p "$HOME"

  # Records what curl was asked to download, so a test can assert the pinned
  # JAR (v0.64) was fetched on the fallback path.
  export CURL_LOG="$TEST_DIR/curl.log"

  # Force detect_os -> macos regardless of the real host.
  cat > "$STUB_BIN/uname" <<'STUB'
#!/usr/bin/env bash
echo "Darwin"
STUB

  # brew: `install`/`unlink` succeed and do nothing. The version brew "installed"
  # is whatever the ktfmt stub reports (see BREW_KTFMT_VERSION below).
  cat > "$STUB_BIN/brew" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

  # java present and new enough for install_manual's Java >= 11 gate.
  cat > "$STUB_BIN/java" <<'STUB'
#!/usr/bin/env bash
echo 'openjdk version "21.0.2" 2024-01-16' >&2
STUB

  # curl: log the URL, write a non-empty file to the -o target, succeed.
  cat > "$STUB_BIN/curl" <<'STUB'
#!/usr/bin/env bash
out=""
prev=""
for a in "$@"; do
  if [[ "$prev" == "-o" ]]; then out="$a"; fi
  prev="$a"
done
echo "$*" >> "${CURL_LOG:-/dev/null}"
[[ -n "$out" ]] && printf 'FAKEJAR' > "$out"
exit 0
STUB

  # ktfmt --version reports the version brew "installed" (default 0.64 = matches).
  cat > "$STUB_BIN/ktfmt" <<'STUB'
#!/usr/bin/env bash
if [[ " $* " == *" --version "* ]]; then
  echo "ktfmt version ${BREW_KTFMT_VERSION:-0.64}"
  exit 0
fi
exit 0
STUB

  chmod +x "$STUB_BIN"/*
  export PATH="$STUB_BIN:$PATH"
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "macOS: brew version matching the pin does NOT trigger a manual JAR download" {
  run env BREW_KTFMT_VERSION="0.64" bash "$SCRIPT"
  [ "$status" -eq 0 ]
  # No fallback -> curl was never invoked to fetch a JAR.
  [ ! -s "$CURL_LOG" ]
}

@test "macOS: brew version != pin falls back to the pinned manual JAR (honors pin)" {
  run env BREW_KTFMT_VERSION="0.66" bash "$SCRIPT"
  [ "$status" -eq 0 ]
  # Fallback fetched the pinned fat JAR from the v0.64 GitHub release.
  [ -s "$CURL_LOG" ]
  grep -q "v0.64/ktfmt-0.64-with-dependencies.jar" "$CURL_LOG"
  # The pinned wrapper was installed into the sandboxed ~/.local/bin.
  [ -x "$HOME/.local/bin/ktfmt" ]
}
