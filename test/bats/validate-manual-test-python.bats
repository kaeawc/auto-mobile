#!/usr/bin/env bats

setup() {
  bats_require_minimum_version 1.5.0
  MOCK_BIN="$BATS_TEST_TMPDIR/bin"
  BATCH="$BATS_TEST_TMPDIR/batch"
  SCRIPT="$BATS_TEST_DIRNAME/../../scripts/validate_manual_test_python.sh"
  export COMMAND_LOG="$BATS_TEST_TMPDIR/commands.log"
  export UV_LOG="$BATS_TEST_TMPDIR/uv.log"
  export MANUAL_TEST_PYTHON_BATCH_DIR="$BATCH"
  mkdir -p "$MOCK_BIN" "$BATCH"
  # Restrict PATH so the unavailable-uv case cannot find a host uv installation.
  for command in bash dirname mkdir realpath cp rm; do
    ln -s "$(command -v "$command")" "$MOCK_BIN/$command"
  done
  cat > "$MOCK_BIN/python3" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == -c ]]; then
  [[ "$0" == *managed-python || "$0" == */python ]] && exit 0
  exit "${MOCK_VERSION_EXIT:-0}"
fi
printf '%s\n' "$0 $*" >> "$COMMAND_LOG"
if [[ "$1" == -m && "$2" == venv ]]; then
  mkdir -p "$3/bin"
  cp "$0" "$3/bin/python"
fi
MOCK
  chmod +x "$MOCK_BIN/python3"
  cp "$MOCK_BIN/python3" "$MOCK_BIN/managed-python"
  export MOCK_MANAGED_PYTHON="$MOCK_BIN/managed-python"
  export PATH="$MOCK_BIN"
}

make_uv() {
  /bin/cat > "$MOCK_BIN/uv" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$UV_LOG"
case "$*" in
  'python find >=3.11')
    [[ "${MOCK_FIND_FAIL:-0}" == 0 ]] || exit 1
    printf '%s\n' "$MOCK_MANAGED_PYTHON"
    ;;
  'python install 3.11') exit "${MOCK_INSTALL_EXIT:-0}" ;;
  'python find 3.11') printf '%s\n' "$MOCK_MANAGED_PYTHON" ;;
  *) exit 1 ;;
esac
MOCK
  /bin/chmod +x "$MOCK_BIN/uv"
}

assert_interpreter() {
  [ "$status" -eq 0 ]
  [ "$(/usr/bin/head -n 1 "$COMMAND_LOG")" = "$1 -m venv $BATCH/python-venv" ]
  /usr/bin/grep -Fq -- '-m pip install --disable-pip-version-check --require-hashes' "$COMMAND_LOG"
  /usr/bin/grep -Fq -- '-m unittest discover' "$COMMAND_LOG"
}

@test "modern python3 is used without calling uv" {
  make_uv
  run bash "$SCRIPT"
  assert_interpreter "$MOCK_BIN/python3"
  [ ! -e "$UV_LOG" ]
}

@test "old python3 selects the interpreter found by uv" {
  export MOCK_VERSION_EXIT=1
  # The managed interpreter must pass setup-venv's own version check.
  make_uv
  run bash "$SCRIPT"
  assert_interpreter "$MOCK_MANAGED_PYTHON"
  [ "$(/bin/cat "$UV_LOG")" = 'python find >=3.11' ]
}

@test "failed find installs then finds uv-managed 3.11" {
  export MOCK_VERSION_EXIT=1 MOCK_FIND_FAIL=1
  make_uv
  run bash "$SCRIPT"
  assert_interpreter "$MOCK_MANAGED_PYTHON"
  [ "$(/bin/cat "$UV_LOG")" = "$(printf '%s\n' 'python find >=3.11' 'python install 3.11' 'python find 3.11')" ]
}

@test "old python3 without uv exits 2 before setup" {
  export MOCK_VERSION_EXIT=1
  run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  [[ "$output" == *python3* && "$output" == *uv* ]]
  [ ! -e "$COMMAND_LOG" ]
  [ ! -e "$BATCH/python-venv" ]
}

@test "batch override must be absolute and existing" {
  for path in relative "$BATS_TEST_TMPDIR/missing"; do
    export MANUAL_TEST_PYTHON_BATCH_DIR="$path"
    run bash "$SCRIPT"
    [ "$status" -eq 2 ]
    [[ "$output" == *'absolute existing directory'* ]]
    [ ! -e "$COMMAND_LOG" ]
  done
}
