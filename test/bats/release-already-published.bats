#!/usr/bin/env bats
#
# Guards scripts/release/already-published.sh, the idempotency check that makes a
# failed release rerunnable. The cases that matter most are the failure ones: a
# guard that answers "published" when it cannot reach a registry would silently
# skip a real publish, which is the fail-green shape release.yml is being fixed
# to remove.

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/../../scripts/release/already-published.sh"
  STUB_DIR="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB_DIR"
  PATH="$STUB_DIR:$PATH"
  export PATH
}

# Writes a `curl` stub. $1 is the status returned for Maven POM requests; any
# MCP registry request gets $2 as its response body.
stub_curl() {
  local maven_status="${1:-404}" mcp_body="${2:-\{\"servers\":[]\}}"
  cat > "$STUB_DIR/curl" <<EOF
#!/usr/bin/env bash
url="\${*: -1}"
if [[ "\$url" == *registry.modelcontextprotocol.io* || "\$url" == *mcp-stub* ]]; then
  printf '%s' '${mcp_body}'
  exit 0
fi
printf '%s' '${maven_status}'
EOF
  chmod +x "$STUB_DIR/curl"
}

stub_npm() {
  local exit_code="$1" output="$2"
  cat > "$STUB_DIR/npm" <<EOF
#!/usr/bin/env bash
printf '%s\n' '${output}'
exit ${exit_code}
EOF
  chmod +x "$STUB_DIR/npm"
}

@test "npm: a resolvable version reports published" {
  stub_npm 0 "0.0.45"
  run "$SCRIPT" npm 0.0.45
  [ "$status" -eq 0 ]
  [ "$output" = "published" ]
}

@test "npm: a 404 reports missing" {
  stub_npm 1 "npm error code E404 - Not found"
  run "$SCRIPT" npm 99.99.99
  [ "$status" -eq 0 ]
  [ "$output" = "missing" ]
}

@test "npm: a non-404 failure fails closed rather than guessing" {
  stub_npm 1 "npm error code EAI_AGAIN request to registry failed"
  run "$SCRIPT" npm 0.0.45
  [ "$status" -ne 0 ]
  [[ "$output" != *published* ]]
  [[ "$output" != *missing* ]]
}

@test "maven: all four artifacts present reports published" {
  stub_curl 200
  MAVEN_BASE_URL="http://maven-stub" run "$SCRIPT" maven 0.0.44
  [ "$status" -eq 0 ]
  [ "$output" = "published" ]
}

@test "maven: no artifacts present reports missing" {
  stub_curl 404
  MAVEN_BASE_URL="http://maven-stub" run "$SCRIPT" maven 0.0.45
  [ "$status" -eq 0 ]
  [ "$output" = "missing" ]
}

@test "maven: a partial publish fails closed instead of picking a side" {
  # 200 for the first artifact, 404 for the rest — the shape left behind when the
  # publish step dies midway through its four modules.
  cat > "$STUB_DIR/curl" <<'EOF'
#!/usr/bin/env bash
url="${*: -1}"
case "$url" in
  *auto-mobile-protocol*) printf '200' ;;
  *) printf '404' ;;
esac
EOF
  chmod +x "$STUB_DIR/curl"
  MAVEN_BASE_URL="http://maven-stub" run "$SCRIPT" maven 0.0.45
  [ "$status" -ne 0 ]
  [[ "$output" == *"1 of 4"* ]]
  [[ "$output" == *"manual repair"* ]]
}

@test "maven: an unexpected status fails closed" {
  stub_curl 503
  MAVEN_BASE_URL="http://maven-stub" run "$SCRIPT" maven 0.0.45
  [ "$status" -ne 0 ]
  [[ "$output" == *503* ]]
}

@test "mcp: a matching version reports published" {
  stub_curl 404 '{"servers":[{"server":{"version":"0.0.13"}},{"server":{"version":"0.0.45"}}]}'
  MCP_REGISTRY_URL="http://mcp-stub" run "$SCRIPT" mcp 0.0.45
  [ "$status" -eq 0 ]
  [ "$output" = "published" ]
}

@test "mcp: a registry holding only older versions reports missing" {
  # The live registry is stuck on 0.0.13 while npm is at 0.0.44, so this is the
  # real-world case, not a hypothetical.
  stub_curl 404 '{"servers":[{"server":{"version":"0.0.13"}}]}'
  MCP_REGISTRY_URL="http://mcp-stub" run "$SCRIPT" mcp 0.0.45
  [ "$status" -eq 0 ]
  [ "$output" = "missing" ]
}

@test "mcp: an unparseable response fails closed" {
  stub_curl 404 'not json at all'
  MCP_REGISTRY_URL="http://mcp-stub" run "$SCRIPT" mcp 0.0.45
  [ "$status" -ne 0 ]
  [[ "$output" != *published* ]]
}

@test "an unknown target is rejected" {
  run "$SCRIPT" docker 0.0.45
  [ "$status" -ne 0 ]
  [[ "$output" == *"unknown target"* ]]
}

@test "a missing version argument is rejected" {
  run "$SCRIPT" npm
  [ "$status" -ne 0 ]
}
