#!/usr/bin/env bats
#
# Tests for scripts/release/rebase-release-past-metrics.sh (#18175).
#
# Prepare Release may promote a verified release after main moved only when
# every new main commit touches docs/metrics/** alone; it then tags the release
# replayed onto that main. Any other change must refuse promotion.

SCRIPT="${BATS_TEST_DIRNAME}/../../scripts/release/rebase-release-past-metrics.sh"

setup() {
  REPO="$(mktemp -d)"
  export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
  export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
  git -C "$REPO" init --quiet --initial-branch=main
  mkdir -p "$REPO/docs/metrics/data" "$REPO/src"
  echo '{"day":0}' > "$REPO/docs/metrics/data/downloads.jsonl"
  echo 'export const VERSION = "0.0.93";' > "$REPO/src/release.ts"
  echo "guard" > "$REPO/src/guard.ts"
  echo "metrics" > "$REPO/docs/metrics/x"
  commit_all "base"
  BASE="$(git -C "$REPO" rev-parse HEAD)"

  # The verified release: a version bump on a side branch off BASE.
  git -C "$REPO" checkout --quiet -b release
  echo 'export const VERSION = "0.0.94";' > "$REPO/src/release.ts"
  commit_all "chore: bump versions to v0.0.94"
  VERIFIED="$(git -C "$REPO" rev-parse HEAD)"
  git -C "$REPO" checkout --quiet main
}

teardown() {
  rm -rf "$REPO"
}

commit_all() {
  git -C "$REPO" add -A
  git -C "$REPO" commit --quiet -m "$1"
}

metrics_commit() {
  echo "{\"day\":$1}" >> "$REPO/docs/metrics/data/downloads.jsonl"
  commit_all "chore(metrics): daily release download snapshot"
}

run_rebase() {
  run bash -c 'cd "$1" && bash "$2" rebase "$3" "$4" main' _ "$REPO" "$SCRIPT" "$VERIFIED" "$BASE"
}

@test "check-paths accepts only docs/metrics/** paths" {
  run bash "$SCRIPT" check-paths <<< $'docs/metrics/data/downloads.jsonl\ndocs/metrics/usage-data.md'
  [ "$status" -eq 0 ]

  run bash "$SCRIPT" check-paths <<< ''
  [ "$status" -eq 0 ]

  run bash "$SCRIPT" check-paths <<< $'docs/metrics/data/downloads.jsonl\nsrc/release.ts'
  [ "$status" -eq 1 ]
  [[ "$output" == *"src/release.ts"* ]]
  [[ "$output" != *"  docs/metrics/data/downloads.jsonl"* ]]
}

@test "check-paths rejects lookalike prefixes" {
  run bash "$SCRIPT" check-paths <<< 'docs/metrics-extra/file.md'
  [ "$status" -eq 1 ]
  run bash "$SCRIPT" check-paths <<< 'docs/metrics'
  [ "$status" -eq 1 ]
}

@test "rebases the release onto main that moved only by metrics commits" {
  metrics_commit 1
  metrics_commit 2
  local main
  main="$(git -C "$REPO" rev-parse main)"

  run_rebase
  [ "$status" -eq 0 ]
  local rebased="${lines[-1]}"
  [ "$rebased" != "$VERIFIED" ]
  [ "$(git -C "$REPO" rev-parse "$rebased^")" = "$main" ]
  # Release content is preserved and only the metrics data differs.
  [ "$(git -C "$REPO" show "$rebased:src/release.ts")" = 'export const VERSION = "0.0.94";' ]
  [ "$(git -C "$REPO" diff --name-only "$VERIFIED" "$rebased")" = "docs/metrics/data/downloads.jsonl" ]
  [ "$(git -C "$REPO" log -1 --format=%s "$rebased")" = "chore: bump versions to v0.0.94" ]
  # The temporary worktree is cleaned up.
  [ "$(git -C "$REPO" worktree list | wc -l)" -eq 1 ]
}

@test "refuses when main moved by a non-metrics commit" {
  metrics_commit 1
  echo "change" > "$REPO/src/other.ts"
  commit_all "feat: unrelated change"

  run_rebase
  [ "$status" -eq 1 ]
  [[ "$output" == *"src/other.ts"* ]]
  [[ "$output" == *"refusing to promote"* ]]
}

@test "refuses a commit mixing metrics and other paths" {
  echo '{"day":1}' >> "$REPO/docs/metrics/data/downloads.jsonl"
  echo "x" > "$REPO/README.md"
  commit_all "mixed"

  run_rebase
  [ "$status" -eq 1 ]
  [[ "$output" == *"README.md"* ]]
}

@test "refuses a non-metrics change even when a later commit reverts it" {
  echo "x" > "$REPO/src/temp.ts"
  commit_all "add"
  git -C "$REPO" rm --quiet src/temp.ts
  commit_all "revert"

  run_rebase
  [ "$status" -eq 1 ]
  [[ "$output" == *"src/temp.ts"* ]]
}

@test "refuses when main no longer descends from the release base" {
  git -C "$REPO" checkout --quiet --orphan rewritten
  commit_all "rewritten history"
  git -C "$REPO" branch --quiet -f main rewritten

  run_rebase
  [ "$status" -eq 1 ]
  [[ "$output" == *"does not descend from the release base"* ]]
}

@test "refuses merge commits on main" {
  git -C "$REPO" checkout --quiet -b metrics-side
  metrics_commit 1
  git -C "$REPO" checkout --quiet main
  metrics_commit 2
  git -C "$REPO" merge --quiet --no-ff -X ours -m "merge" metrics-side

  run_rebase
  [ "$status" -eq 1 ]
  [[ "$output" == *"merge commits"* ]]
}

@test "refuses when the release commits conflict with main" {
  # A release that edits docs/metrics/** too would conflict with the bot.
  git -C "$REPO" checkout --quiet release
  echo '{"day":"release"}' >> "$REPO/docs/metrics/data/downloads.jsonl"
  commit_all "release touches metrics"
  VERIFIED="$(git -C "$REPO" rev-parse HEAD)"
  git -C "$REPO" checkout --quiet main
  metrics_commit 1

  run_rebase
  [ "$status" -eq 1 ]
  [[ "$output" == *"do not replay cleanly"* ]]
  [ "$(git -C "$REPO" worktree list | wc -l)" -eq 1 ]
}

@test "refuses a rename into docs/metrics from a source path in base" {
  git -C "$REPO" mv src/guard.ts docs/metrics/guard.ts
  commit_all "move source into metrics"

  run_rebase
  [ "$status" -eq 1 ]
  [[ "$output" == *"src/guard.ts"* ]]
  [[ "$output" == *"refusing to promote"* ]]
}

@test "refuses a rename out of docs/metrics" {
  git -C "$REPO" mv docs/metrics/x src/x
  commit_all "move metrics into source"

  run_rebase
  [ "$status" -eq 1 ]
  [[ "$output" == *"src/x"* ]]
  [[ "$output" == *"refusing to promote"* ]]
}

@test "recovers the existing rebased release before a later metrics commit" {
  metrics_commit 1
  run_rebase
  [ "$status" -eq 0 ]
  local rebased="${lines[-1]}"
  git -C "$REPO" merge --quiet --ff-only "$rebased"
  metrics_commit 2

  run_rebase
  [ "$status" -eq 0 ]
  [ "$output" = "$rebased" ]
  [ "$(git -C "$REPO" worktree list | wc -l)" -eq 1 ]
}
