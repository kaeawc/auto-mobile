#!/usr/bin/env bats
#
# Tests for scripts/ktfmt/validate_ktfmt.sh file-selection modes.
#
# CI (pull_request.yml, fast-validation) now scopes the Kotlin format check to a
# PR's changed files via ONLY_CHANGED_SINCE_SHA. These tests lock in that path
# and, critically, the fallback behavior for an unresolvable base SHA -- which
# must NOT silently pass (a false green is the worst outcome for a linter).
#
# ktfmt itself is stubbed so the tests are fast and deterministic and exercise
# only the selection/dispatch logic, not the real formatter.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/ktfmt/validate_ktfmt.sh"

  TEST_DIR="$(mktemp -d)"

  # Stub ktfmt:
  #  * `--version` prints "ktfmt version <KTFMT_STUB_VERSION>" (default 0.64, the
  #    pin). Tests override KTFMT_STUB_VERSION to simulate formatter-version drift,
  #    or set KTFMT_STUB_VERSION="" to simulate an unparseable/failing --version.
  #  * exits 0 for the stdin probe (`--google-style -`) and dry-run.
  #  * for an in-place `--google-style <files...>` it "reformats" (mutating the
  #    copies the script made) only when a file contains FORMAT_ME, letting a test
  #    simulate a misformatted file deterministically. It also records each
  #    formatting invocation when KTFMT_STUB_LOG is set.
  STUB_BIN="$TEST_DIR/bin"
  mkdir -p "$STUB_BIN"
  cat > "$STUB_BIN/ktfmt" <<'STUB'
#!/usr/bin/env bash
if [[ " $* " == *" --version "* ]]; then
  # An empty override simulates a ktfmt whose --version emits no parseable
  # version (or a broken binary); exit non-zero so the gate treats it as unknown.
  if [[ -z "${KTFMT_STUB_VERSION-0.64}" ]]; then
    exit 1
  fi
  # KTFMT_STUB_NOISE simulates a JVM warning printed to stderr *before* ktfmt's
  # own line (the CI ktfmt runs `java -jar`); the gate must not parse its version.
  if [[ -n "${KTFMT_STUB_NOISE:-}" ]]; then
    echo "$KTFMT_STUB_NOISE" >&2
  fi
  if [[ -n "${KTFMT_STUB_CRLF:-}" ]]; then
    printf 'ktfmt version %s\r\n' "${KTFMT_STUB_VERSION:-0.64}"
    exit 0
  fi
  echo "ktfmt version ${KTFMT_STUB_VERSION:-0.64}"
  exit 0
fi
last="${@: -1}"
if [[ "$last" == "-" || " $* " == *" --dry-run "* ]]; then
  cat >/dev/null 2>&1 || true
  exit 0
fi
if [[ -n "${KTFMT_STUB_LOG:-}" ]]; then
  printf '%s\n' "$#" >> "$KTFMT_STUB_LOG"
  printf '%s\n' "$@" >> "$KTFMT_STUB_LOG"
fi
for file in "$@"; do
  [[ "$file" == "--google-style" ]] && continue
  if [[ -f "$file" ]] && grep -q 'FORMAT_ME' "$file"; then
    sed -i.bak 's/FORMAT_ME//g' "$file" && rm -f "$file.bak"
  fi
done
exit 0
STUB
  chmod +x "$STUB_BIN/ktfmt"
  export PATH="$STUB_BIN:$PATH"

  # A throwaway git repo that becomes PROJECT_ROOT (script uses `pwd`).
  # Mirror the standard Codex worktree layout. The validator must not exclude
  # Kotlin files merely because a parent directory is hidden (`.codex`).
  REPO="$TEST_DIR/.codex/worktrees/ktfmt"
  mkdir -p "$REPO/app/src"
  cd "$REPO" || return 1
  git init -q
  git config user.email t@t.t
  git config user.name t
}

teardown() {
  cd /
  rm -rf "$TEST_DIR"
}

# Helper: write a clean (already-formatted) Kotlin file.
clean_kt() { mkdir -p "$(dirname "$1")" && printf 'fun a() {}\n' > "$1"; }

@test "validator runs under strict bash mode" {
  grep -qx 'set -euo pipefail' "$SCRIPT"
}

@test "empty SHA processes the whole tree" {
  clean_kt app/src/Base.kt
  git add -A && git commit -qm base

  run env ONLY_CHANGED_SINCE_SHA="" ONLY_TOUCHED_FILES=false bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Processing all Kotlin files in the project"* ]]
  [[ "$output" == *"Found 1 Kotlin file(s) to process"* ]]
}

@test "valid base SHA scopes to only the PR's changed Kotlin files" {
  clean_kt app/src/Base.kt
  git add -A && git commit -qm base
  local base; base="$(git rev-parse HEAD)"
  clean_kt app/src/Feature.kt
  git add -A && git commit -qm feature

  run env ONLY_CHANGED_SINCE_SHA="$base" ONLY_TOUCHED_FILES=false bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Processing files changed since SHA: $base"* ]]
  # Only Feature.kt changed since base; Base.kt is untouched and must be skipped.
  [[ "$output" == *"Found 1 Kotlin file(s) to process"* ]]
}

@test "a deleted .kt in the range is excluded (not sent to ktfmt)" {
  clean_kt app/src/Old.kt
  git add -A && git commit -qm base
  local base; base="$(git rev-parse HEAD)"
  git rm -q app/src/Old.kt
  git commit -qm delete

  run env ONLY_CHANGED_SINCE_SHA="$base" ONLY_TOUCHED_FILES=false bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"No Kotlin files to process"* ]]
}

@test "REGRESSION: unresolvable base SHA falls back to full-tree, never a silent pass" {
  clean_kt app/src/Base.kt
  git add -A && git commit -qm base

  run env ONLY_CHANGED_SINCE_SHA="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" \
    ONLY_TOUCHED_FILES=true bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"does not resolve; falling back to a full-tree ktfmt check"* ]]
  # It must actually validate the tree, not report "No Kotlin files".
  [[ "$output" == *"Found 1 Kotlin file(s) to process"* ]]
  [[ "$output" != *"No Kotlin files to process"* ]]
}

@test "REGRESSION: full-tree file discovery failure does not pass with zero files" {
  clean_kt app/src/Base.kt
  git add -A && git commit -qm base

  cat > "$STUB_BIN/find" <<'STUB'
#!/usr/bin/env bash
echo "find exploded" >&2
exit 42
STUB
  chmod +x "$STUB_BIN/find"

  run env ONLY_CHANGED_SINCE_SHA="" ONLY_TOUCHED_FILES=false bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Failed to collect Kotlin files"* ]]
  [[ "$output" != *"No Kotlin files to process"* ]]
  [[ "$output" != *"properly formatted"* ]]
}

@test "REGRESSION: touched-file git diff failure does not pass with zero files" {
  clean_kt app/src/Base.kt
  git add -A && git commit -qm base

  local bash_env="$TEST_DIR/git-diff-fails.bash"
  cat > "$bash_env" <<'STUB'
git() {
  if [[ "${1:-}" == "diff" ]]; then
    echo "git diff exploded" >&2
    return 42
  fi
  command git "$@"
}
STUB

  run env BASH_ENV="$bash_env" ONLY_CHANGED_SINCE_SHA="" ONLY_TOUCHED_FILES=true bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Failed to collect Kotlin files"* ]]
  [[ "$output" != *"No Kotlin files to process"* ]]
  [[ "$output" != *"properly formatted"* ]]
}

@test "a misformatted changed file fails the scoped check (not a no-op)" {
  clean_kt app/src/Base.kt
  git add -A && git commit -qm base
  local base; base="$(git rev-parse HEAD)"
  printf 'fun bad() { FORMAT_ME }\n' > app/src/Bad.kt
  git add -A && git commit -qm bad

  run env ONLY_CHANGED_SINCE_SHA="$base" ONLY_TOUCHED_FILES=false bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Formatting issues found"* ]]
  [[ "$output" == *"Bad.kt"* ]]
}

@test "formats isolated copies in one invocation and preserves duplicate basenames" {
  clean_kt app/one/Same.kt
  clean_kt app/two/Same.kt
  local ktfmt_log="$TEST_DIR/ktfmt.log"

  run env KTFMT_STUB_LOG="$ktfmt_log" ONLY_CHANGED_SINCE_SHA="" \
    ONLY_TOUCHED_FILES=false bash "$SCRIPT"
  [ "$status" -eq 0 ]

  # One formatter process handles both copies, and their relative paths remain
  # distinct so a Same.kt in one directory cannot overwrite the other copy.
  [ "$(wc -l < "$ktfmt_log")" -eq 4 ]
  [[ "$(sed -n '1p' "$ktfmt_log")" == "3" ]]
  [[ "$(sed -n '2p' "$ktfmt_log")" == "--google-style" ]]
  [[ "$(sed -n '3p' "$ktfmt_log")" == */app/one/Same.kt ]]
  [[ "$(sed -n '4p' "$ktfmt_log")" == */app/two/Same.kt ]]
}

@test "formatter input changes force a full-tree check" {
  clean_kt app/src/Base.kt
  git add -A && git commit -qm base
  local base; base="$(git rev-parse HEAD)"
  clean_kt app/src/Feature.kt
  mkdir -p scripts/ktfmt
  printf 'changed formatter input\n' > scripts/ktfmt/config
  git add -A && git commit -qm formatter-change

  run env ONLY_CHANGED_SINCE_SHA="$base" ONLY_TOUCHED_FILES=true bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Ktfmt inputs changed since the base SHA; running a full-tree ktfmt check"* ]]
  [[ "$output" == *"Found 2 Kotlin file(s) to process"* ]]
}

# ---------------------------------------------------------------------------
# Version fingerprint gate (issue #2966): the scoped PR check only looks at a
# PR's changed files, so a formatter whose version differs from the pin would
# reformat *untouched* files the scoped check never inspects -- passing the PR,
# then reddening main when merge.yml reformats the whole tree. Enforce the pin
# up front: a ktfmt whose version != KTFMT_VERSION must fail loudly, never
# silently scoped-pass.
# ---------------------------------------------------------------------------

@test "version matching the pin passes the gate and processes files" {
  clean_kt app/src/Base.kt
  git add -A && git commit -qm base

  run env KTFMT_STUB_VERSION="0.64" ONLY_CHANGED_SINCE_SHA="" \
    ONLY_TOUCHED_FILES=false bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Found 1 Kotlin file(s) to process"* ]]
}

@test "REGRESSION: a newer ktfmt (version != pin) fails loudly, does not scoped-pass" {
  clean_kt app/src/Base.kt
  git add -A && git commit -qm base
  local base; base="$(git rev-parse HEAD)"
  clean_kt app/src/Feature.kt
  git add -A && git commit -qm feature

  run env KTFMT_STUB_VERSION="0.66" ONLY_CHANGED_SINCE_SHA="$base" \
    ONLY_TOUCHED_FILES=false bash "$SCRIPT"
  [ "$status" -ne 0 ]
  # Names both the found and the pinned version so the failure is actionable.
  [[ "$output" == *"0.66"* ]]
  [[ "$output" == *"0.64"* ]]
  # It must abort BEFORE doing any per-file work -- a scoped pass is the bug.
  [[ "$output" != *"Kotlin file(s) to process"* ]]
  [[ "$output" != *"properly formatted"* ]]
}

@test "an unparseable/failing --version fails loudly (treated as drift)" {
  clean_kt app/src/Base.kt
  git add -A && git commit -qm base

  run env KTFMT_STUB_VERSION="" ONLY_CHANGED_SINCE_SHA="" \
    ONLY_TOUCHED_FILES=false bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"0.64"* ]]
  [[ "$output" != *"Kotlin file(s) to process"* ]]
}

@test "a JVM warning before the version line is not mistaken for the ktfmt version" {
  clean_kt app/src/Base.kt
  git add -A && git commit -qm base

  # A stderr warning carrying its own version must not be grabbed by the parse;
  # the gate should still read ktfmt's real 0.64 and pass.
  run env KTFMT_STUB_VERSION="0.64" \
    KTFMT_STUB_NOISE="OpenJDK 64-Bit Server VM warning: using JDK 11.0.2" \
    ONLY_CHANGED_SINCE_SHA="" ONLY_TOUCHED_FILES=false bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Found 1 Kotlin file(s) to process"* ]]
  [[ "$output" != *"version mismatch"* ]]
}

@test "CRLF version output still passes the pin gate" {
  clean_kt app/src/Base.kt
  git add -A && git commit -qm base

  run env KTFMT_STUB_VERSION="0.64" KTFMT_STUB_CRLF=true \
    ONLY_CHANGED_SINCE_SHA="" ONLY_TOUCHED_FILES=false bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Found 1 Kotlin file(s) to process"* ]]
  [[ "$output" != *"version mismatch"* ]]
}

@test "a 3-part x.y.0 version equals the 2-part pin (issue #3004)" {
  clean_kt app/src/Base.kt
  git add -A && git commit -qm base

  # A future ktfmt that prints "ktfmt version 0.64.0" must still match the
  # 2-part pin "0.64": the trailing ".0" is a redundant patch component. Without
  # normalization this false-fails the gate ("0.64.0" != "0.64").
  run env KTFMT_STUB_VERSION="0.64.0" ONLY_CHANGED_SINCE_SHA="" \
    ONLY_TOUCHED_FILES=false bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Found 1 Kotlin file(s) to process"* ]]
  [[ "$output" != *"version mismatch"* ]]
}

@test "a non-zero patch (x.y.1) still fails the pin gate (issue #3004)" {
  clean_kt app/src/Base.kt
  git add -A && git commit -qm base

  # Only a redundant trailing ".0" is normalized away; a real patch build like
  # "0.64.1" IS a different formatter and must still fail loudly.
  run env KTFMT_STUB_VERSION="0.64.1" ONLY_CHANGED_SINCE_SHA="" \
    ONLY_TOUCHED_FILES=false bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"version mismatch"* ]]
  [[ "$output" == *"0.64.1"* ]]
  [[ "$output" != *"Kotlin file(s) to process"* ]]
}

@test "the gate reads the pin from the shared ktfmt_version.sh (single source)" {
  # Prove single-sourcing without mutating the tracked tree: copy the validator
  # and its sibling pin file into a temp dir, bump the *copy's* pin to 0.99, and
  # confirm a 0.64 ktfmt now fails against that copy. If the validator hardcoded
  # the version instead of sourcing the sibling, editing the copy would be inert.
  local copy_dir="$TEST_DIR/ktfmt_copy"
  mkdir -p "$copy_dir"
  cp "$REPO_ROOT/scripts/ktfmt/validate_ktfmt.sh" "$copy_dir/"
  cp "$REPO_ROOT/scripts/ktfmt/ktfmt_version.sh" "$copy_dir/"
  # The validator sources ../lib/file-selection.sh relative to its own dir
  # (issue #2823), so mirror scripts/lib next to the copied ktfmt dir.
  mkdir -p "$TEST_DIR/lib"
  cp "$REPO_ROOT/scripts/lib/file-selection.sh" "$TEST_DIR/lib/"
  cp "$REPO_ROOT/scripts/lib/vcs-diff.sh" "$TEST_DIR/lib/"
  # Bump ONLY the pin line in the copy, preserving the shared helper functions.
  sed -i.bak 's/^KTFMT_VERSION=.*/KTFMT_VERSION="0.99"/' "$copy_dir/ktfmt_version.sh"
  rm -f "$copy_dir/ktfmt_version.sh.bak"

  clean_kt app/src/Base.kt
  git add -A && git commit -qm base
  run env KTFMT_STUB_VERSION="0.64" ONLY_CHANGED_SINCE_SHA="" \
    ONLY_TOUCHED_FILES=false bash "$copy_dir/validate_ktfmt.sh"
  [ "$status" -ne 0 ]
  [[ "$output" == *"0.99"* ]]
}
