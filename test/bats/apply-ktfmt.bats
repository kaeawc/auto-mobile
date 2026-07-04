#!/usr/bin/env bats
#
# Tests for scripts/ktfmt/apply_ktfmt.sh -- the *mutating* (write) formatter path.
#
# apply_ktfmt.sh reformats files in place, so a ktfmt whose version differs from
# the pin would rewrite the tree with the wrong formatter and could get committed
# -- the exact drift issue #2966 guards against, on the write side. These tests
# lock in that the shared version fingerprint gate (require_pinned_ktfmt_version)
# aborts BEFORE any file is touched when the version drifts.
#
# ktfmt is stubbed so the tests are fast and deterministic.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/ktfmt/apply_ktfmt.sh"

  TEST_DIR="$(mktemp -d)"

  # Stub ktfmt: `--version` reports KTFMT_STUB_VERSION (default 0.64 = pin). For
  # an in-place format run (`--google-style <files...>` via xargs) it strips the
  # FORMAT_ME marker so a test can observe whether formatting actually happened.
  STUB_BIN="$TEST_DIR/bin"
  mkdir -p "$STUB_BIN"
  cat > "$STUB_BIN/ktfmt" <<'STUB'
#!/usr/bin/env bash
if [[ " $* " == *" --version "* ]]; then
  echo "ktfmt version ${KTFMT_STUB_VERSION:-0.64}"
  exit 0
fi
echo "Done formatting"
for f in "$@"; do
  [[ "$f" == "--google-style" ]] && continue
  [[ -f "$f" ]] && sed -i.bak 's/FORMAT_ME//g' "$f" && rm -f "$f.bak"
done
exit 0
STUB
  chmod +x "$STUB_BIN/ktfmt"
  export PATH="$STUB_BIN:$PATH"

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

@test "REGRESSION: apply aborts on a drifted ktfmt and does NOT reformat files" {
  printf 'fun bad() { FORMAT_ME }\n' > app/src/Bad.kt
  git add -A

  run env KTFMT_STUB_VERSION="0.66" ONLY_TOUCHED_FILES=true bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"0.66"* ]]
  [[ "$output" == *"0.64"* ]]
  # It must abort at the gate, before ever formatting.
  [[ "$output" != *"Applying ktfmt formatting"* ]]
  # The file is untouched -- the wrong formatter never ran.
  grep -q 'FORMAT_ME' app/src/Bad.kt
}

@test "apply with the pinned ktfmt passes the gate and formats touched files" {
  printf 'fun bad() { FORMAT_ME }\n' > app/src/Bad.kt
  git add -A

  run env KTFMT_STUB_VERSION="0.64" ONLY_TOUCHED_FILES=true bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Found 1 Kotlin file(s) to process"* ]]
  # The pinned formatter ran and stripped the marker.
  ! grep -q 'FORMAT_ME' app/src/Bad.kt
}
