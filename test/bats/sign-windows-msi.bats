#!/usr/bin/env bats
#
# Unit tests for scripts/ci/sign-windows-msi.sh — Azure Trusted Signing of the
# Windows desktop MSI via jsign (#4725) — plus its wiring into
# build-desktop-app-installers.yml and prepare-release.yml. `curl`, `java` and
# the jsign jar are faked so no network or Azure credentials are needed.

SCRIPT="scripts/ci/sign-windows-msi.sh"
WORKFLOW=".github/workflows/build-desktop-app-installers.yml"

load yq-helpers

setup() {
  TEST_ROOT="$(mktemp -d)"
  MSI="${TEST_ROOT}/AutoMobile-1.0.0.msi"
  echo "msi bytes" >"${MSI}"
  CURL_LOG="${TEST_ROOT}/curl.log"
  JAVA_LOG="${TEST_ROOT}/java.log"
  JAVA_ENV_LOG="${TEST_ROOT}/java.env"
  export GITHUB_OUTPUT="${TEST_ROOT}/github-output"
  : >"${GITHUB_OUTPUT}"

  export JSIGN_JAR="${TEST_ROOT}/jsign.jar"
  echo "jar" >"${JSIGN_JAR}"

  cat >"${TEST_ROOT}/curl" <<FAKE
#!/usr/bin/env bash
echo "\$*" >> "${CURL_LOG}"
for arg in "\$@"; do
  case "\$arg" in
    client_secret@-) cat > "${TEST_ROOT}/posted-secret" ;;
    client_secret@*) echo "client_secret must be read from stdin, got \$arg" >&2; exit 9 ;;
  esac
done
if [ -n "\${FAKE_TOKEN_JSON:-}" ]; then printf '%s' "\${FAKE_TOKEN_JSON}"; else printf '%s' '{"access_token":"tok-abc"}'; fi
FAKE
  chmod +x "${TEST_ROOT}/curl"
  export CURL="${TEST_ROOT}/curl"

  cat >"${TEST_ROOT}/java" <<FAKE
#!/usr/bin/env bash
echo "\$*" >> "${JAVA_LOG}"
echo "\${TRUSTED_SIGNING_TOKEN:-}" > "${JAVA_ENV_LOG}"
exit \${FAKE_JAVA_RC:-0}
FAKE
  chmod +x "${TEST_ROOT}/java"
  export JAVA="${TEST_ROOT}/java"

  unset AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET \
    TRUSTED_SIGNING_ENDPOINT TRUSTED_SIGNING_ACCOUNT TRUSTED_SIGNING_PROFILE \
    FAKE_TOKEN_JSON FAKE_JAVA_RC
}

teardown() {
  rm -rf "${TEST_ROOT}"
}

export_all_creds() {
  export AZURE_TENANT_ID="tenant-1"
  export AZURE_CLIENT_ID="client-1"
  export AZURE_CLIENT_SECRET="s3cr3t value&="
  export TRUSTED_SIGNING_ENDPOINT="https://eus.codesigning.azure.net/"
  export TRUSTED_SIGNING_ACCOUNT="automobile"
  export TRUSTED_SIGNING_PROFILE="public-trust"
}

@test "no credentials: skips signing with a warning and signed=false" {
  run bash "$SCRIPT" "$MSI"
  [ "$status" -eq 0 ]
  [[ "$output" == *"::warning::"*"UNSIGNED"* ]]
  [ ! -e "$JAVA_LOG" ]
  [ ! -e "$CURL_LOG" ]
  grep -Fxq "signed=false" "$GITHUB_OUTPUT"
}

@test "partial credentials fail closed and name the missing secrets" {
  export AZURE_TENANT_ID="tenant-1"
  export TRUSTED_SIGNING_ACCOUNT="automobile"
  run bash "$SCRIPT" "$MSI"
  [ "$status" -eq 2 ]
  [[ "$output" == *"AZURE_CLIENT_SECRET"* ]]
  [[ "$output" == *"TRUSTED_SIGNING_PROFILE"* ]]
  [ ! -e "$JAVA_LOG" ]
  ! grep -Fq "signed=" "$GITHUB_OUTPUT"
}

@test "missing MSI path or file exits 2" {
  run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  run bash "$SCRIPT" "${TEST_ROOT}/nope.msi"
  [ "$status" -eq 2 ]
}

@test "an endpoint outside codesigning.azure.net is rejected" {
  export_all_creds
  export TRUSTED_SIGNING_ENDPOINT="https://evil.example.com"
  run bash "$SCRIPT" "$MSI"
  [ "$status" -eq 2 ]
  [[ "$output" == *"TRUSTED_SIGNING_ENDPOINT"* ]]
  [ ! -e "$CURL_LOG" ]
}

@test "full credentials: fetches a codesigning token and signs with jsign TRUSTEDSIGNING" {
  export_all_creds
  run bash "$SCRIPT" "$MSI"
  [ "$status" -eq 0 ]

  grep -Fq "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token" "$CURL_LOG"
  grep -Fq "scope=https://codesigning.azure.net/.default" "$CURL_LOG"
  grep -Fq "grant_type=client_credentials" "$CURL_LOG"
  # The client secret is piped on stdin, never on the command line or in a
  # file path that Windows-native curl would have to resolve.
  ! grep -Fq "s3cr3t" "$CURL_LOG"
  grep -Fq "client_secret@-" "$CURL_LOG"
  [ "$(cat "${TEST_ROOT}/posted-secret")" = "s3cr3t value&=" ]

  local args
  args="$(cat "$JAVA_LOG")"
  [[ "$args" == "-jar ${JSIGN_JAR} "* ]]
  [[ "$args" == *"--storetype TRUSTEDSIGNING"* ]]
  [[ "$args" == *"--keystore eus.codesigning.azure.net "* ]]
  [[ "$args" == *"--storepass env:TRUSTED_SIGNING_TOKEN"* ]]
  [[ "$args" == *"--alias automobile/public-trust"* ]]
  [[ "$args" == *"--tsaurl http://timestamp.acs.microsoft.com --tsmode RFC3161"* ]]
  [[ "$args" == *" ${MSI}" ]]
  # The token reaches jsign only through the environment.
  [[ "$args" != *"tok-abc"* ]]
  [ "$(cat "$JAVA_ENV_LOG")" = "tok-abc" ]
  [[ "$output" == *"::add-mask::tok-abc"* ]]

  grep -Fxq "signed=true" "$GITHUB_OUTPUT"
}

@test "a token response without access_token fails before jsign runs" {
  export_all_creds
  export FAKE_TOKEN_JSON='{"error":"invalid_client"}'
  run bash "$SCRIPT" "$MSI"
  [ "$status" -eq 1 ]
  [[ "$output" == *"no access_token"* ]]
  [ ! -e "$JAVA_LOG" ]
  ! grep -Fq "signed=true" "$GITHUB_OUTPUT"
}

@test "a jsign failure fails the script and does not report signed=true" {
  export_all_creds
  export FAKE_JAVA_RC=3
  run bash "$SCRIPT" "$MSI"
  [ "$status" -eq 3 ]
  ! grep -Fq "signed=true" "$GITHUB_OUTPUT"
}

@test "the pinned jsign download is checksum-verified" {
  grep -Eq '^JSIGN_SHA256="[0-9a-f]{64}"$' "$SCRIPT"
  grep -Fq 'sha256sum "${jar}"' "$SCRIPT"
}

@test "workflow signs only the Windows MSI, after packaging and before staging" {
  require_mikefarah_yq

  run yq -r '.jobs.build.steps[] | select(.name == "Sign Windows MSI") | .if' "$WORKFLOW"
  [ "$output" = "matrix.platform == 'windows'" ]
  run yq -r '.jobs.build.steps[] | select(.name == "Sign Windows MSI") | .run' "$WORKFLOW"
  [[ "$output" == *"scripts/ci/sign-windows-msi.sh"* ]]
  [[ "$output" == *"binaries/main/msi"* ]]

  local package_idx sign_idx verify_idx stage_idx
  package_idx="$(yq -r '.jobs.build.steps | to_entries[] | select(.value.name == "Package installer") | .key' "$WORKFLOW")"
  sign_idx="$(yq -r '.jobs.build.steps | to_entries[] | select(.value.name == "Sign Windows MSI") | .key' "$WORKFLOW")"
  verify_idx="$(yq -r '.jobs.build.steps | to_entries[] | select(.value.name == "Verify Windows MSI signature") | .key' "$WORKFLOW")"
  stage_idx="$(yq -r '.jobs.build.steps | to_entries[] | select(.value.name == "Stage installer") | .key' "$WORKFLOW")"
  [ "$package_idx" -lt "$sign_idx" ]
  [ "$sign_idx" -lt "$verify_idx" ]
  [ "$verify_idx" -lt "$stage_idx" ]

  run yq -r '.jobs.build.steps[] | select(.name == "Verify Windows MSI signature") | .if' "$WORKFLOW"
  [ "$output" = "matrix.platform == 'windows' && steps.sign-msi.outputs.signed == 'true'" ]
  run yq -r '.jobs.build.steps[] | select(.name == "Verify Windows MSI signature") | .run' "$WORKFLOW"
  [[ "$output" == *"Get-AuthenticodeSignature"* ]]
}

@test "Trusted Signing secrets are optional and forwarded by prepare-release" {
  require_mikefarah_yq
  local secret
  for secret in AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET \
    TRUSTED_SIGNING_ENDPOINT TRUSTED_SIGNING_ACCOUNT TRUSTED_SIGNING_PROFILE; do
    [ "$(yq -r ".on.workflow_call.secrets.${secret}.required" "$WORKFLOW")" = "false" ]
    [ "$(yq -r ".jobs.build.steps[] | select(.name == \"Sign Windows MSI\") | .env.${secret}" "$WORKFLOW")" = "\${{ secrets.${secret} }}" ]
    [ "$(yq -r ".jobs.\"build-candidate-desktop-app-installers\".secrets.${secret}" .github/workflows/prepare-release.yml)" = "\${{ secrets.${secret} }}" ]
  done
}

@test "Git Bash: the secret never depends on cygpath or an MSYS temp path" {
  export_all_creds
  # A cygpath that fails if called, and a curl that only accepts stdin, model
  # Git Bash with a Windows-native curl that cannot open /tmp/... paths.
  cat >"${TEST_ROOT}/cygpath" <<FAKE
#!/usr/bin/env bash
echo "cygpath \$*" >> "${TEST_ROOT}/cygpath.log"
exit 1
FAKE
  chmod +x "${TEST_ROOT}/cygpath"
  PATH="${TEST_ROOT}:${PATH}" TMPDIR="/tmp" run bash "$SCRIPT" "$MSI"
  [ "$status" -eq 0 ]
  [ ! -e "${TEST_ROOT}/cygpath.log" ]
  ! grep -Eq "client_secret@/" "$CURL_LOG"
  [ "$(cat "${TEST_ROOT}/posted-secret")" = "s3cr3t value&=" ]
  grep -Fxq "signed=true" "$GITHUB_OUTPUT"
}

@test "Git Bash: a native jq.exe that emits CRLF leaves no CR in the token" {
  export_all_creds
  # Windows-native jq.exe in text mode ends every line with CRLF.
  cat >"${TEST_ROOT}/jq" <<'FAKE'
#!/usr/bin/env bash
cat >/dev/null
printf 'tok-abc\r\n'
FAKE
  chmod +x "${TEST_ROOT}/jq"
  export JQ="${TEST_ROOT}/jq"
  run bash "$SCRIPT" "$MSI"
  [ "$status" -eq 0 ]
  # The fake java writes the token plus one LF; no CR may precede it.
  [ "$(od -An -c "$JAVA_ENV_LOG" | tr -d ' ')" = 'tok-abc\n' ]
  [[ "$output" == *"::add-mask::tok-abc"* ]]
  [[ "$output" != *$'\r'* ]]
  grep -Fxq "signed=true" "$GITHUB_OUTPUT"
}
