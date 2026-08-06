#!/usr/bin/env bats
#
# Tests for scripts/oxlint-baseline.sh -- the oxlint ratchet gate that replaces
# ESLint's eslint-suppressions.json (oxlint has no native bulk-suppressions).
#
# oxlint is stubbed via OXLINT_JSON_CMD so the tests are fast and deterministic --
# they never invoke the real linter. The baseline is redirected to a temp file
# via OXLINT_BASELINE so the committed baseline is never touched.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  SCRIPT="$REPO_ROOT/scripts/oxlint-baseline.sh"

  TEST_DIR="$(mktemp -d)"
  export OXLINT_BASELINE="$TEST_DIR/baseline.txt"

  # A canned oxlint JSON report: two ratcheted diagnostics in one file plus one
  # in another, and one NON-ratcheted diagnostic that must be ignored entirely.
  FIXTURE_JSON='printf "%s" "{\"diagnostics\":[
    {\"code\":\"eslint(complexity)\",\"filename\":\"src/a.ts\"},
    {\"code\":\"eslint(max-depth)\",\"filename\":\"src/a.ts\"},
    {\"code\":\"auto-mobile(catch-convention)\",\"filename\":\"src/b.ts\"},
    {\"code\":\"eslint(no-debugger)\",\"filename\":\"src/a.ts\"}
  ]}"'
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "update mode records only the ratcheted codes, per file+rule" {
  OXLINT_JSON_CMD="$FIXTURE_JSON" run bash "$SCRIPT" --update
  [ "$status" -eq 0 ]

  # 3 ratcheted diagnostics captured; the non-ratcheted no-debugger is dropped.
  run bash -c "grep -vE '^#|^$' '$OXLINT_BASELINE' | wc -l | tr -d ' '"
  [ "$output" -eq 3 ]
  ! grep -q 'eslint(no-debugger)' "$OXLINT_BASELINE"
}

@test "check passes when current matches the baseline" {
  OXLINT_JSON_CMD="$FIXTURE_JSON" bash "$SCRIPT" --update
  OXLINT_JSON_CMD="$FIXTURE_JSON" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"no new violations"* ]]
}

@test "check fails on a NEW file+rule pair" {
  OXLINT_JSON_CMD="$FIXTURE_JSON" bash "$SCRIPT" --update
  local more='printf "%s" "{\"diagnostics\":[
    {\"code\":\"eslint(complexity)\",\"filename\":\"src/a.ts\"},
    {\"code\":\"eslint(max-depth)\",\"filename\":\"src/a.ts\"},
    {\"code\":\"auto-mobile(catch-convention)\",\"filename\":\"src/b.ts\"},
    {\"code\":\"eslint(complexity)\",\"filename\":\"src/new.ts\"}
  ]}"'
  OXLINT_JSON_CMD="$more" run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"src/new.ts"* ]]
}

@test "check fails on an INCREASED count for an existing pair" {
  OXLINT_JSON_CMD="$FIXTURE_JSON" bash "$SCRIPT" --update
  local more='printf "%s" "{\"diagnostics\":[
    {\"code\":\"eslint(complexity)\",\"filename\":\"src/a.ts\"},
    {\"code\":\"eslint(complexity)\",\"filename\":\"src/a.ts\"},
    {\"code\":\"eslint(max-depth)\",\"filename\":\"src/a.ts\"},
    {\"code\":\"auto-mobile(catch-convention)\",\"filename\":\"src/b.ts\"}
  ]}"'
  OXLINT_JSON_CMD="$more" run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"src/a.ts"* ]]
}

@test "check passes when a violation is FIXED (lower count is fine)" {
  OXLINT_JSON_CMD="$FIXTURE_JSON" bash "$SCRIPT" --update
  local fewer='printf "%s" "{\"diagnostics\":[
    {\"code\":\"eslint(complexity)\",\"filename\":\"src/a.ts\"}
  ]}"'
  OXLINT_JSON_CMD="$fewer" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"no new violations"* ]]
}

@test "update refuses to grow the baseline without --allow-grow" {
  OXLINT_JSON_CMD="$FIXTURE_JSON" bash "$SCRIPT" --update
  local more='printf "%s" "{\"diagnostics\":[
    {\"code\":\"eslint(complexity)\",\"filename\":\"src/a.ts\"},
    {\"code\":\"eslint(max-depth)\",\"filename\":\"src/a.ts\"},
    {\"code\":\"auto-mobile(catch-convention)\",\"filename\":\"src/b.ts\"},
    {\"code\":\"eslint(complexity)\",\"filename\":\"src/new.ts\"}
  ]}"'
  OXLINT_JSON_CMD="$more" run bash "$SCRIPT" --update
  [ "$status" -eq 1 ]
  [[ "$output" == *"refusing to grow"* ]]

  OXLINT_JSON_CMD="$more" run bash "$SCRIPT" --update --allow-grow
  [ "$status" -eq 0 ]
}

@test "update refuses a count-neutral SWAP (fix one key, add another) without --allow-grow" {
  OXLINT_JSON_CMD="$FIXTURE_JSON" bash "$SCRIPT" --update
  # Same aggregate total (3), but src/a.ts complexity is fixed and a NEW
  # src/c.ts complexity appears. An aggregate-only guard would accept this and
  # let the subsequent check pass over the new defect.
  local swap='printf "%s" "{\"diagnostics\":[
    {\"code\":\"eslint(max-depth)\",\"filename\":\"src/a.ts\"},
    {\"code\":\"auto-mobile(catch-convention)\",\"filename\":\"src/b.ts\"},
    {\"code\":\"eslint(complexity)\",\"filename\":\"src/c.ts\"}
  ]}"'
  OXLINT_JSON_CMD="$swap" run bash "$SCRIPT" --update
  [ "$status" -eq 1 ]
  [[ "$output" == *"refusing to grow"* ]]
  [[ "$output" == *"src/c.ts"* ]]

  OXLINT_JSON_CMD="$swap" run bash "$SCRIPT" --update --allow-grow
  [ "$status" -eq 0 ]
}

@test "path separators are normalized so a Windows (backslash) report matches a forward-slash baseline" {
  OXLINT_JSON_CMD="$FIXTURE_JSON" bash "$SCRIPT" --update
  # Same violations, but reported with Windows backslash paths (as oxlint may emit
  # on windows-latest). Without normalization every key would read as NEW.
  local win='printf "%s" "{\"diagnostics\":[
    {\"code\":\"eslint(complexity)\",\"filename\":\"src\\\\a.ts\"},
    {\"code\":\"eslint(max-depth)\",\"filename\":\"src\\\\a.ts\"},
    {\"code\":\"auto-mobile(catch-convention)\",\"filename\":\"src\\\\b.ts\"}
  ]}"'
  OXLINT_JSON_CMD="$win" run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"no new violations"* ]]
}

@test "check fails closed when the baseline is missing" {
  OXLINT_JSON_CMD="$FIXTURE_JSON" run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"baseline missing"* ]]
}
