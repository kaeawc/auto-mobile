#!/usr/bin/env bats
# bats file_tags=parallel-within-file
#
# Tests for scripts/ci/install-claude-code.sh (#16963) and its CI cache (#16985).
#
# `curl` and `sha256sum` are stubbed on PATH: curl copies a local tarball that
# holds a fake `claude`, and sha256sum prints a chosen digest, so no case reaches
# the network or depends on the pinned release bytes.

load yq-helpers

SCRIPT_SRC="scripts/ci/install-claude-code.sh"
X64_SHA="2a4d5e3bd0f5bd2959bb1955bd99ea97f57af162681991dcae00fee82f9d554f"

setup() {
  SCRIPT_ABS="$(pwd)/${SCRIPT_SRC}"
  WORK="$(mktemp -d)"
  STUB_BIN="${WORK}/bin"
  mkdir -p "${STUB_BIN}" "${WORK}/src/package"
  printf '#!/usr/bin/env bash\necho "9.9.9 (Claude Code)"\n' > "${WORK}/src/package/claude"
  tar -czf "${WORK}/claude.tgz" -C "${WORK}/src" package

  cat > "${STUB_BIN}/curl" <<'SH'
#!/usr/bin/env bash
calls=0
[[ -f "$CURL_CALLS" ]] && calls="$(cat "$CURL_CALLS")"
echo "$((calls + 1))" > "$CURL_CALLS"
printf '%s\n' "${@: -1}" >> "$CURL_URLS"
if (( calls < ${CURL_FAIL_FIRST:-0} )); then
  exit 22
fi
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then
    cp "$CURL_TARBALL" "$2"
  fi
  shift
done
SH
  cat > "${STUB_BIN}/sha256sum" <<'SH'
#!/usr/bin/env bash
echo "${STUB_SHA}  $1"
SH
  chmod +x "${STUB_BIN}/curl" "${STUB_BIN}/sha256sum"

  export PATH="${STUB_BIN}:$PATH"
  export CURL_CALLS="${WORK}/curl.calls" CURL_URLS="${WORK}/curl.urls" CURL_TARBALL="${WORK}/claude.tgz"
  export CLAUDE_CODE_INSTALL_DIR="${WORK}/install"
  export CLAUDE_CODE_MACHINE="Linux-x86_64"
  export CLAUDE_CODE_RETRY_DELAY_SECONDS=0
  export GITHUB_PATH="${WORK}/github_path"
  export STUB_SHA="$X64_SHA"
}

teardown() {
  rm -rf "$WORK"
}

@test "installs the pinned linux-x64 package and adds it to GITHUB_PATH" {
  run bash "$SCRIPT_ABS"

  [ "$status" -eq 0 ]
  [[ "$output" == *"installed 9.9.9 (Claude Code)"* ]]
  [ -x "${CLAUDE_CODE_INSTALL_DIR}/claude" ]
  grep -Fqx "$CLAUDE_CODE_INSTALL_DIR" "$GITHUB_PATH"
  grep -Fqx "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.318.tgz" "$CURL_URLS"
  [ -z "$(find "$CLAUDE_CODE_INSTALL_DIR" -name '*.tgz')" ]
}

@test "a checksum mismatch fails before installing" {
  export STUB_SHA="0000"

  run bash "$SCRIPT_ABS"

  [ "$status" -eq 1 ]
  [[ "$output" == *"checksum mismatch"* ]]
  [ ! -e "${CLAUDE_CODE_INSTALL_DIR}/claude" ]
  [ ! -f "$GITHUB_PATH" ]
}

@test "retries a failed download, then gives up after the attempt budget" {
  export CURL_FAIL_FIRST=1
  run bash "$SCRIPT_ABS"
  [ "$status" -eq 0 ]
  [ "$(cat "$CURL_CALLS")" -eq 2 ]

  rm -rf "$CURL_CALLS" "$CLAUDE_CODE_INSTALL_DIR"
  export CURL_FAIL_FIRST=9
  run bash "$SCRIPT_ABS"
  [ "$status" -eq 1 ]
  [[ "$output" == *"failed after 3 attempts"* ]]
}

@test "an unpinned runner platform fails" {
  export CLAUDE_CODE_MACHINE="Darwin-arm64"

  run bash "$SCRIPT_ABS"

  [ "$status" -eq 1 ]
  [[ "$output" == *"unsupported runner 'Darwin-arm64'"* ]]
  [ ! -f "$CURL_CALLS" ]
}

@test "--cache-key names the platform, pinned version and checksum without downloading" {
  run bash "$SCRIPT_ABS" --cache-key
  [ "$status" -eq 0 ]
  [ "$output" = "claude-code-linux-x64-2.1.318-${X64_SHA}" ]

  export CLAUDE_CODE_MACHINE="Linux-aarch64"
  run bash "$SCRIPT_ABS" --cache-key
  [ "$status" -eq 0 ]
  [[ "$output" == "claude-code-linux-arm64-2.1.318-"* ]]
  [[ "$output" != *"$X64_SHA" ]]
  [ ! -f "$CURL_CALLS" ]
}

@test "a cache key that drifts from the pinned version or checksum differs" {
  local pinned edited
  pinned="$(bash "$SCRIPT_ABS" --cache-key)"
  edited="${WORK}/install-claude-code.sh"

  sed 's/^CLAUDE_CODE_VERSION=.*/CLAUDE_CODE_VERSION="2.1.319"/' "$SCRIPT_ABS" > "$edited"
  [ "$(bash "$edited" --cache-key)" != "$pinned" ]

  sed "s/^SHA256_LINUX_X64=.*/SHA256_LINUX_X64=\"${X64_SHA//2/3}\"/" "$SCRIPT_ABS" > "$edited"
  [ "$(bash "$edited" --cache-key)" != "$pinned" ]
}

@test "an unknown argument fails" {
  run bash "$SCRIPT_ABS" --bogus
  [ "$status" -eq 1 ]
  [[ "$output" == *"unknown argument '--bogus'"* ]]
}

@test "a restored install with a matching stamp skips the download but still runs --version" {
  run bash "$SCRIPT_ABS"
  [ "$status" -eq 0 ]
  [ "$(cat "$CURL_CALLS")" -eq 1 ]
  rm -f "$GITHUB_PATH"

  run bash "$SCRIPT_ABS"

  [ "$status" -eq 0 ]
  [[ "$output" == *"using cached 9.9.9 (Claude Code)"* ]]
  [ "$(cat "$CURL_CALLS")" -eq 1 ]
  grep -Fqx "$CLAUDE_CODE_INSTALL_DIR" "$GITHUB_PATH"
}

@test "a stamp from another pin reinstalls" {
  run bash "$SCRIPT_ABS"
  [ "$status" -eq 0 ]
  echo "2.1.0 deadbeef" > "${CLAUDE_CODE_INSTALL_DIR}/.claude-code-pin"

  run bash "$SCRIPT_ABS"

  [ "$status" -eq 0 ]
  [[ "$output" == *"installed 9.9.9 (Claude Code)"* ]]
  [ "$(cat "$CURL_CALLS")" -eq 2 ]
  grep -Fqx "2.1.318 ${X64_SHA}" "${CLAUDE_CODE_INSTALL_DIR}/.claude-code-pin"
}

@test "a cached binary that does not run is reinstalled" {
  run bash "$SCRIPT_ABS"
  [ "$status" -eq 0 ]
  printf '#!/usr/bin/env bash\nexit 1\n' > "${CLAUDE_CODE_INSTALL_DIR}/claude"

  run bash "$SCRIPT_ABS"

  [ "$status" -eq 0 ]
  [[ "$output" == *"did not run; reinstalling"* ]]
  [[ "$output" == *"installed 9.9.9 (Claude Code)"* ]]
  [ "$(cat "$CURL_CALLS")" -eq 2 ]
}

@test "a failed checksum leaves no stamp behind" {
  export STUB_SHA="0000"
  run bash "$SCRIPT_ABS"
  [ "$status" -eq 1 ]
  [ ! -e "${CLAUDE_CODE_INSTALL_DIR}/.claude-code-pin" ]
}

# The wiring assertions read the workflows and the action structurally with
# mikefarah yq v4 (require_mikefarah_yq from yq-helpers.bash), so a
# commented-out or misplaced step does not count.
@test "the PR and merge jobs that validate the plugin install through the cached action" {
  require_mikefarah_yq
  local repo pr merge
  repo="$(pwd)"
  pr="${repo}/.github/workflows/pull_request.yml"
  merge="${repo}/.github/workflows/merge.yml"
  local select='.jobs | to_entries[] | select(.value.steps[]? | .uses == "./.github/actions/install-claude-code") | .key'

  [ "$(yq -r "$select" "$pr" | sort | tr '\n' ' ')" = "fast-validation shell-changed-gate " ]
  [ "$(yq -r "$select" "$merge")" = "validate-claude-plugin" ]
  # No job runs the installer outside the action, where it would skip the cache.
  [ -z "$(yq -r '.jobs[].steps[]? | select(.run // "" | test("install-claude-code\\.sh")) | .name' "$pr" "$merge")" ]
}

@test "the action restores and saves one path under the installer's cache key" {
  require_mikefarah_yq
  local action
  action="$(pwd)/.github/actions/install-claude-code/action.yml"

  [ "$(yq -r '.runs.steps[] | select(.id == "key") | .run' "$action")" = \
    'echo "key=$(scripts/ci/install-claude-code.sh --cache-key)" >> "$GITHUB_OUTPUT"' ]
  # restore → install → save, in that order.
  [ "$(yq -r '.runs.steps[] | .uses // .run' "$action" | sed 's/@.*//' | tr '\n' '|')" = \
    'echo "key=$(scripts/ci/install-claude-code.sh --cache-key)" >> "$GITHUB_OUTPUT"|actions/cache/restore|scripts/ci/install-claude-code.sh|actions/cache/save|' ]
  [ "$(yq -r '.runs.steps[] | select(.uses == "actions/cache/*") | .with.key' "$action" | sort -u)" = \
    '${{ steps.key.outputs.key }}' ]
  [ "$(yq -r '.runs.steps[] | select(.uses == "actions/cache/*") | .with.path' "$action" | sort -u)" = \
    '${{ runner.temp }}/claude-code' ]
  [ "$(yq -r '.runs.steps[] | select(.run == "scripts/ci/install-claude-code.sh") | .env.CLAUDE_CODE_INSTALL_DIR' "$action")" = \
    '${{ runner.temp }}/claude-code' ]
  [ "$(yq -r '.runs.steps[] | select(.uses == "actions/cache/save*") | .if' "$action")" = \
    "steps.restore.outputs.cache-hit != 'true'" ]
}
