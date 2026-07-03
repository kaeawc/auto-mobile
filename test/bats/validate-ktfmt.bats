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

  # Stub ktfmt: exits 0 for the stdin probe (`--google-style -`) and dry-run.
  # For an in-place `--google-style <file>` it "reformats" (mutating the copy the
  # script made) only when the file contains the marker FORMAT_ME, letting a
  # test simulate a misformatted file deterministically.
  STUB_BIN="$TEST_DIR/bin"
  mkdir -p "$STUB_BIN"
  cat > "$STUB_BIN/ktfmt" <<'STUB'
#!/usr/bin/env bash
last="${@: -1}"
if [[ "$last" == "-" || " $* " == *" --dry-run "* ]]; then
  cat >/dev/null 2>&1 || true
  exit 0
fi
if [[ -f "$last" ]]; then
  if grep -q 'FORMAT_ME' "$last"; then
    sed -i.bak 's/FORMAT_ME//g' "$last" && rm -f "$last.bak"
  fi
  exit 0
fi
exit 0
STUB
  chmod +x "$STUB_BIN/ktfmt"
  export PATH="$STUB_BIN:$PATH"

  # A throwaway git repo that becomes PROJECT_ROOT (script uses `pwd`).
  REPO="$TEST_DIR/repo"
  mkdir -p "$REPO/app/src"
  cd "$REPO"
  git init -q
  git config user.email t@t.t
  git config user.name t
}

teardown() {
  cd /
  rm -rf "$TEST_DIR"
}

# Helper: write a clean (already-formatted) Kotlin file.
clean_kt() { printf 'fun a() {}\n' > "$1"; }

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
    ONLY_TOUCHED_FILES=false bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"does not resolve; falling back to a full-tree ktfmt check"* ]]
  # It must actually validate the tree, not report "No Kotlin files".
  [[ "$output" == *"Found 1 Kotlin file(s) to process"* ]]
  [[ "$output" != *"No Kotlin files to process"* ]]
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
