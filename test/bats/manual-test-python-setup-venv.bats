#!/usr/bin/env bats

setup() {
  bats_require_minimum_version 1.5.0
  MOCK_BIN="${BATS_TEST_TMPDIR}/bin"
  BATCH="${BATS_TEST_TMPDIR}/batch"
  COMMAND_LOG="${BATS_TEST_TMPDIR}/commands.log"
  SCRIPT="${BATS_TEST_DIRNAME}/../../scripts/manual-test/python/setup-venv.sh"
  mkdir -p "$MOCK_BIN" "$BATCH"
  export COMMAND_LOG
  export PATH="${MOCK_BIN}:${PATH}"
  cat > "$MOCK_BIN/python3" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == -c ]]; then
  exit "${MOCK_VERSION_EXIT:-0}"
fi
printf '%s\n' "$*" >> "$COMMAND_LOG"
printf '%s\n' "$0" >> "${COMMAND_LOG}.interpreters"
if [[ "$1" == -m && "$2" == venv ]]; then
  mkdir -p "$3/bin"
  cp "$0" "$3/bin/python"
fi
MOCK
  chmod +x "$MOCK_BIN/python3"
  cp "$MOCK_BIN/python3" "$MOCK_BIN/custom-python"
}

@test "all usage refusals produce no venv or install side effect" {
  touch "${BATS_TEST_TMPDIR}/file"
  ln -s / "${BATS_TEST_TMPDIR}/root-link"
  for scenario in missing missing-value flag-value python-value sdk-value python-flag-value sdk-flag-value unknown positional relative nonexistent file root root-link version; do
    case "$scenario" in
      missing) args=() ;;
      missing-value) args=(--batch-dir) ;;
      flag-value) args=(--batch-dir --python python3) ;;
      python-value) args=(--batch-dir "$BATCH" --python) ;;
      sdk-value) args=(--batch-dir "$BATCH" --mcp-version) ;;
      python-flag-value) args=(--batch-dir "$BATCH" --python --bad) ;;
      sdk-flag-value) args=(--batch-dir "$BATCH" --mcp-version --bad) ;;
      unknown) args=(--wat) ;;
      positional) args=("$BATCH") ;;
      relative) args=(--batch-dir relative) ;;
      nonexistent) args=(--batch-dir "${BATS_TEST_TMPDIR}/absent") ;;
      file) args=(--batch-dir "${BATS_TEST_TMPDIR}/file") ;;
      root) args=(--batch-dir /) ;;
      root-link) args=(--batch-dir "${BATS_TEST_TMPDIR}/root-link") ;;
      version) args=(--batch-dir "$BATCH" --mcp-version '1.30') ;;
    esac
    run bash "$SCRIPT" "${args[@]}"
    [ "$status" -eq 2 ]
    [[ "$output" == *'error: '* && "$output" == *Usage:* ]]
    [ ! -e "$BATCH/python-venv" ]
    [ ! -s "$COMMAND_LOG" ]
  done
}

@test "resident state directory and aliases are refused without interpreter invocation" {
  export HOME="${BATS_TEST_TMPDIR}/home"
  mkdir -p "$HOME/.auto-mobile/nested"
  ln -s "$HOME/.auto-mobile/nested" "${BATS_TEST_TMPDIR}/resident-link"
  for path in "$HOME/.auto-mobile" "$HOME/.auto-mobile/nested" "${BATS_TEST_TMPDIR}/resident-link"; do
    run bash "$SCRIPT" --batch-dir "$path"
    [ "$status" -eq 2 ]
    [ ! -s "$COMMAND_LOG" ]
    [ ! -e "$path/python-venv" ]
  done
}

@test "old or missing interpreter refuses before creating venv" {
  export MOCK_VERSION_EXIT=1
  run bash "$SCRIPT" --batch-dir "$BATCH"
  [ "$status" -eq 2 ]
  [ ! -s "$COMMAND_LOG" ]
  [ ! -e "$BATCH/python-venv" ]
  run bash "$SCRIPT" --batch-dir "$BATCH" --python /nonexistent/python
  [ "$status" -eq 2 ]
  [ ! -s "$COMMAND_LOG" ]
}

@test "happy path installs hashes and prints only interpreter path, then reuses venv" {
  run bash "$SCRIPT" --batch-dir "$BATCH"
  [ "$status" -eq 0 ]
  [ "$output" = "$BATCH/python-venv/bin/python" ]
  expected="$(printf '%s\n' "-m venv $BATCH/python-venv" "-m pip install --disable-pip-version-check --require-hashes -r $(realpath "${SCRIPT%/*}")/requirements.txt")"
  [ "$(cat "$COMMAND_LOG")" = "$expected" ]
  run bash "$SCRIPT" --batch-dir "$BATCH"
  [ "$status" -eq 0 ]
  [ "$(grep -c -- '-m venv' "$COMMAND_LOG")" -eq 1 ]
}

@test "override installs unlocked SDK with stderr notice and selected interpreter" {
  run --separate-stderr bash "$SCRIPT" --batch-dir "$BATCH" --python custom-python --mcp-version 1.30.0
  [ "$status" -eq 0 ]
  [ "$output" = "$BATCH/python-venv/bin/python" ]
  [[ "$stderr" == *UNLOCKED* ]]
  [ "$(head -n 1 "${COMMAND_LOG}.interpreters")" = "$MOCK_BIN/custom-python" ]
  grep -Fqx -- '-m pip install --disable-pip-version-check mcp==1.30.0' "$COMMAND_LOG"
}

@test "symlinked pre-existing venv is refused without interpreter calls" {
  mkdir -p "$BATS_TEST_TMPDIR/elsewhere/bin"
  cp "$MOCK_BIN/python3" "$BATS_TEST_TMPDIR/elsewhere/bin/python"
  ln -s "$BATS_TEST_TMPDIR/elsewhere" "$BATCH/python-venv"
  run bash "$SCRIPT" --batch-dir "$BATCH"
  [ "$status" -eq 2 ]
  [ ! -s "$COMMAND_LOG" ]
}

@test "plain-file pre-existing venv is refused without interpreter calls" {
  touch "$BATCH/python-venv"
  run bash "$SCRIPT" --batch-dir "$BATCH"
  [ "$status" -eq 2 ]
  [ ! -s "$COMMAND_LOG" ]
}

@test "pre-existing venv without executable python is refused" {
  mkdir -p "$BATCH/python-venv/bin"
  touch "$BATCH/python-venv/bin/python"
  run bash "$SCRIPT" --batch-dir "$BATCH"
  [ "$status" -eq 2 ]
  [ ! -s "$COMMAND_LOG" ]
}
