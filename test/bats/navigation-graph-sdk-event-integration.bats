#!/usr/bin/env bats

SCRIPT="scripts/ios/navigation-graph-sdk-event-integration.sh"

setup() {
  MOCK_BIN="$(mktemp -d)"
  ORIG_PATH="$PATH"
  export GRAPH_ATTEMPTS_FILE="${MOCK_BIN}/graph-attempts"
}

teardown() {
  rm -rf "$MOCK_BIN"
  export PATH="$ORIG_PATH"
}

make_mock() {
  local name="$1"
  local body="$2"
  cat > "${MOCK_BIN}/${name}" <<SCRIPT
#!/usr/bin/env bash
${body}
SCRIPT
  chmod +x "${MOCK_BIN}/${name}"
}

@test "retries getNavigationGraph after an initial CLI failure" {
  make_mock xcrun 'exit 0'
  make_mock curl 'exit 0'
  make_mock base64 'cat'
  make_mock sleep 'exit 0'
  make_mock jq '
if [ "$1" = "-cn" ]; then
  printf "{}\\n"
  exit 0
fi
exit 0
'
  make_mock auto-mobile '
if [ "$1" = "--debug" ] && [ "$2" = "--cli" ] && [ "$3" = "getNavigationGraph" ]; then
  attempts=0
  [ -f "$GRAPH_ATTEMPTS_FILE" ] && attempts="$(cat "$GRAPH_ATTEMPTS_FILE")"
  attempts=$((attempts + 1))
  printf "%s\\n" "$attempts" > "$GRAPH_ATTEMPTS_FILE"
  if [ "$attempts" -eq 1 ]; then
    exit 1
  fi
  printf "{}\\n"
fi
'

  run env PATH="${MOCK_BIN}:${PATH}" bash "$SCRIPT" "simulator-udid"

  [ "$status" -eq 0 ]
  [ "$(cat "$GRAPH_ATTEMPTS_FILE")" = "2" ]
  [[ "$output" == *"getNavigationGraph attempt 1 failed"* ]]
}
