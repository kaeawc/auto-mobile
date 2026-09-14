#!/usr/bin/env bats
# bats file_tags=integration
#
# Tests for scripts/shellcheck/validate_workflow_script_exec_bits.sh. Fixtures
# use a temporary Git repository so the validator must inspect index modes.

SCRIPT="scripts/shellcheck/validate_workflow_script_exec_bits.sh"

setup() {
  ABS="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
  FIX="$(mktemp -d)"
  mkdir -p "$FIX/.github/workflows" "$FIX/scripts"
  git -C "$FIX" init -q
  git -C "$FIX" config user.email test@example.com
  git -C "$FIX" config user.name "BATS Test"
}

teardown() {
  rm -rf "$FIX"
}

write() {
  local path="$FIX/$1"
  shift
  mkdir -p "$(dirname "$path")"
  printf '%s\n' "$@" > "$path"
}

write_lines() {
  local path="$FIX/$1"
  mkdir -p "$(dirname "$path")"
  cat > "$path"
}

track_script_with_mode() {
  local script_path="$1" mode="$2"
  git -C "$FIX" add "$script_path"
  if [ "$mode" = "100755" ]; then
    git -C "$FIX" update-index --chmod=+x "$script_path"
  else
    git -C "$FIX" update-index --chmod=-x "$script_path"
  fi
  local index_entry
  index_entry="$(git -C "$FIX" ls-files -s -- "$script_path")"
  [[ "$index_entry" == "$mode"* ]]
}

@test "fails for a directly invoked non-executable workflow script" {
  write ".github/workflows/ci.yml" "jobs:" "  test:" "    steps:" "      - run: ./scripts/x.sh"
  write scripts/x.sh "#!/usr/bin/env bash" "echo test"
  track_script_with_mode scripts/x.sh 100644

  run env WORKFLOW_EXEC_BITS_PROJECT_ROOT="$FIX" bash "$ABS" "$FIX/.github/workflows"
  [ "$status" -ne 0 ]
  [[ "$output" == *"scripts/x.sh"* ]]
  [[ "$output" == *"git update-index --chmod=+x"* ]]
}

@test "passes for a directly invoked executable workflow script" {
  write ".github/workflows/ci.yml" "jobs:" "  test:" "    steps:" "      - run: ./scripts/x.sh"
  write scripts/x.sh "#!/usr/bin/env bash" "echo test"
  track_script_with_mode scripts/x.sh 100755

  run env WORKFLOW_EXEC_BITS_PROJECT_ROOT="$FIX" bash "$ABS" "$FIX/.github/workflows"
  [ "$status" -eq 0 ]
}

@test "ignores an interpreter-prefixed workflow script" {
  write ".github/workflows/ci.yml" "jobs:" "  test:" "    steps:" "      - run: bash scripts/y.sh"
  write scripts/y.sh "#!/usr/bin/env bash" "echo test"
  track_script_with_mode scripts/y.sh 100644

  run env WORKFLOW_EXEC_BITS_PROJECT_ROOT="$FIX" bash "$ABS" "$FIX/.github/workflows"
  [ "$status" -eq 0 ]
}

@test "scans every non-blank line in a block scalar" {
  write_lines ".github/workflows/ci.yml" <<'YAML'
jobs:
  test:
    steps:
      - run: |
          set -e
          ./scripts/block.sh --check
YAML
  write scripts/block.sh "#!/usr/bin/env bash" "echo test"
  track_script_with_mode scripts/block.sh 100644

  run env WORKFLOW_EXEC_BITS_PROJECT_ROOT="$FIX" bash "$ABS" "$FIX/.github/workflows"
  [ "$status" -ne 0 ]
  [[ "$output" == *"scripts/block.sh"* ]]
}
