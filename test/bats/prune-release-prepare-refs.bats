#!/usr/bin/env bats

SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)/scripts/release/prune-release-prepare-refs.sh"

setup() {
  TEST_ROOT="$(mktemp -d)"
  STUB_DIR="${TEST_ROOT}/bin"
  mkdir -p "$STUB_DIR"

  cat >"${STUB_DIR}/gh" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "${GH_CALLS:?}"

case "$*" in
  "api repos/kaeawc/auto-mobile/git/matching-refs/heads/release-prepare/")
    case "${GH_SCENARIO:?}" in
      mixed)
        printf '%s\n' '[{"ref":"refs/heads/release-prepare/old","object":{"sha":"old-sha"}},{"ref":"refs/heads/release-prepare/new","object":{"sha":"new-sha"}},{"ref":"refs/heads/main","object":{"sha":"main-sha"}},{"ref":"refs/heads/not-release-prepare/old","object":{"sha":"other-sha"}}]'
        ;;
      empty) printf '%s\n' '[]' ;;
    esac
    ;;
  "api repos/kaeawc/auto-mobile/git/commits/old-sha --jq .commit.committer.date")
    printf '%s\n' '2026-01-01T00:00:00Z'
    ;;
  "api repos/kaeawc/auto-mobile/git/commits/new-sha --jq .commit.committer.date")
    printf '%s\n' '2026-01-09T00:00:01Z'
    ;;
  "api -X DELETE repos/kaeawc/auto-mobile/git/refs/heads/release-prepare/old")
    ;;
  *)
    echo "unexpected gh call: $*" >&2
    exit 99
    ;;
esac
SHIM
  chmod +x "${STUB_DIR}/gh"
}

teardown() {
  rm -rf "$TEST_ROOT"
}

run_script() {
  run env \
    PATH="${STUB_DIR}:/bin:/usr/bin:/opt/homebrew/bin" \
    GH_CALLS="${TEST_ROOT}/gh-calls" \
    GH_SCENARIO="$1" \
    GH_TOKEN=test-token \
    GITHUB_REPOSITORY=kaeawc/auto-mobile \
    PRUNE_RELEASE_PREPARE_NOW_EPOCH=1768003200 \
    /bin/bash "$SCRIPT" 3
}

@test "deletes only stale release-prepare refs" {
  run_script mixed

  [ "$status" -eq 0 ]
  [[ "$output" == *"Deleting stale staging ref release-prepare/old"* ]]
  [[ "$output" == *"Skipping staging ref release-prepare/new"* ]]
  grep -q 'refs/heads/release-prepare/old' "${TEST_ROOT}/gh-calls"
  ! grep -q 'refs/heads/main\|not-release-prepare' "${TEST_ROOT}/gh-calls"
  ! grep -q 'DELETE .*release-prepare/new' "${TEST_ROOT}/gh-calls"
}

@test "no-ops when GitHub returns no release-prepare refs" {
  run_script empty

  [ "$status" -eq 0 ]
  [[ "$output" == *"No release-prepare/ staging refs found."* ]]
  [ "$(wc -l < "${TEST_ROOT}/gh-calls")" -eq 1 ]
}
