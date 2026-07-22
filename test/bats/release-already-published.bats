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

# Both stubs append their argv to a log. Asserting on that log is the only thing
# standing between this suite and a guard that queries the wrong thing: a stub
# that ignores its arguments answers identically whether the script asks for the
# right version or no version at all, so dropping "@$version" from the npm spec
# would make the guard report "published" for every release, skip npm publish
# forever, and keep every test green.

# Writes a `curl` stub. $1 is the status returned for Maven POM requests; any
# MCP registry request gets $2 as its response body.
stub_curl() {
  local maven_status="${1:-404}" mcp_body="${2:-\{\"servers\":[]\}}"
  cat > "$STUB_DIR/curl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${BATS_TEST_TMPDIR}/curl.args"
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
printf '%s\n' "\$*" >> "${BATS_TEST_TMPDIR}/npm.args"
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
  # Pin the query, not just the answer. Without @0.0.45 in the spec `npm view`
  # resolves the package itself and every version reports published.
  grep -Fq 'view @kaeawc/auto-mobile@0.0.45 version' "$BATS_TEST_TMPDIR/npm.args"
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
  # The group path, artifact id and version must all reach the URL; a typo in
  # any of them makes the guard answer "missing" forever.
  grep -Fq 'http://maven-stub/dev/jasonpearson/auto-mobile/auto-mobile-sdk/0.0.44/auto-mobile-sdk-0.0.44.pom' \
    "$BATS_TEST_TMPDIR/curl.args"
}

# A wrong artifact list silently narrows what "published" means. Pin it to the
# POM_ARTIFACT_ID values the Gradle publish actually uses.
@test "maven: the probed artifacts match the modules release.yml publishes" {
  local repo_root="$BATS_TEST_DIRNAME/../.."
  local module
  for module in protocol test-plan-validation junit-runner auto-mobile-sdk; do
    local artifact
    artifact="$(sed -n 's/^POM_ARTIFACT_ID=//p' "$repo_root/android/$module/gradle.properties")"
    [ -n "$artifact" ]
    grep -Fq "  $artifact" "$repo_root/scripts/release/already-published.sh"
  done
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
  # The slash in the server name must be percent-encoded; unencoded, the
  # registry returns an endpoint-not-found envelope that parses to zero versions.
  # Pin the API version too — a silent endpoint move is the same class of bug.
  grep -Fq '/v0.1/servers/dev.jasonpearson%2Fauto-mobile/versions' "$BATS_TEST_TMPDIR/curl.args"
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

# curl without -f exits 0 on an HTTP error, so the "could not reach" branches
# only fire on a genuine transport failure (exit 6, status 000). Neither stub
# above ever exits non-zero, so these branches were previously uncovered.
@test "maven: an unreachable registry fails closed" {
  printf '#!/usr/bin/env bash\nprintf %%s 000\nexit 6\n' > "$STUB_DIR/curl"
  chmod +x "$STUB_DIR/curl"
  MAVEN_BASE_URL="http://maven-stub" run "$SCRIPT" maven 0.0.45
  [ "$status" -ne 0 ]
  [[ "$output" == *"could not reach Maven Central"* ]]
  [[ "$output" != *missing* ]]
}

@test "mcp: an unreachable registry fails closed" {
  printf '#!/usr/bin/env bash\nexit 6\n' > "$STUB_DIR/curl"
  chmod +x "$STUB_DIR/curl"
  MCP_REGISTRY_URL="http://mcp-stub" run "$SCRIPT" mcp 0.0.45
  [ "$status" -ne 0 ]
  [[ "$output" != *missing* ]]
}

# The registry answers a missing or renamed server with HTTP 404 and a
# well-formed JSON error object. curl has no -f, so `.servers[]?` swallows it as
# zero versions and the guard would report "missing" for a server that may well
# be published under a name the script no longer knows.
@test "mcp: a 404 error envelope fails closed rather than reading as missing" {
  stub_curl 404 '{"title":"Not Found","status":404,"detail":"Server not found"}'
  MCP_REGISTRY_URL="http://mcp-stub" run "$SCRIPT" mcp 0.0.45
  [ "$status" -ne 0 ]
  [[ "$output" != *missing* ]]
  [[ "$output" == *"did not return a server list"* ]]
}

@test "a whitespace-only version is rejected" {
  run "$SCRIPT" maven "   "
  [ "$status" -ne 0 ]
  [[ "$output" != *missing* ]]
}
