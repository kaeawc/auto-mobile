#!/usr/bin/env bats
# bats file_tags=parallel-within-file
#
# Tests for scripts/ci/install-claude-code.sh (#16963).
#
# `curl` and `sha256sum` are stubbed on PATH: curl copies a local tarball that
# holds a fake `claude`, and sha256sum prints a chosen digest, so no case reaches
# the network or depends on the pinned release bytes.

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

  rm -f "$CURL_CALLS"
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
