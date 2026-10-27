#!/usr/bin/env bats
# The Dockerfile distrusts the emSign roots Mozilla removed from NSS after the
# eMudhra key compromise (Oct 2026). These tests run the Dockerfile's own
# "emsign-distrust" RUN block against a stub keytool and fixture trust stores,
# so the commands that ship in the image are the commands under test.

DOCKERFILE="${BATS_TEST_DIRNAME}/../../Dockerfile"

setup() {
  STUB_BIN="${BATS_TEST_TMPDIR}/bin"
  STORE="${BATS_TEST_TMPDIR}/cacerts.txt"
  OS_BUNDLE="${BATS_TEST_TMPDIR}/ca-certificates.crt"
  mkdir -p "$STUB_BIN"

  # keytool stub: the "cacerts" store is a text file of `alias, date, type,` rows
  # (the real `keytool -list` row shape); -printcert prints OS_BUNDLE verbatim.
  cat > "${STUB_BIN}/keytool" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
mode="$1"
shift
case "$mode" in
  -list)
    printf 'Keystore type: PKCS12\n\n'
    cat "$STORE"
    ;;
  -delete)
    alias=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-alias" ]; then alias="$2"; shift; fi
      shift
    done
    if [ "${STUB_IGNORE_DELETE:-}" = "1" ]; then exit 0; fi
    grep -vF "${alias}, " "$STORE" > "${STORE}.next" || true
    mv "${STORE}.next" "$STORE"
    ;;
  -printcert)
    cat "$OS_BUNDLE"
    ;;
  *)
    echo "unexpected keytool mode: $mode" >&2
    exit 2
    ;;
esac
STUB
  chmod +x "${STUB_BIN}/keytool"

  printf '%s\n' \
    'digicertglobalrootg2 [jdk], Oct 22, 2026, trustedCertEntry, ' \
    'emsigneccrootcag3 [jdk], Oct 22, 2026, trustedCertEntry, ' \
    'emsignrootcag1 [jdk], Oct 22, 2026, trustedCertEntry, ' \
    'emsignrootcag2 [jdk], Oct 22, 2026, trustedCertEntry, ' \
    'isrgrootx1 [jdk], Oct 22, 2026, trustedCertEntry, ' > "$STORE"
  printf '%s\n' \
    'Owner: CN=ISRG Root X1, O=Internet Security Research Group, C=US' \
    'Owner: CN=emSign Root CA - G1, O=eMudhra Technologies Limited, OU=emSign PKI, C=IN' > "$OS_BUNDLE"
}

# Print the RUN block between the emsign-distrust markers with the leading RUN
# keyword removed; bash joins the backslash-continued lines itself.
distrust_block() {
  awk '
    /^# BEGIN emsign-distrust$/ { inside = 1; next }
    /^# END emsign-distrust$/ { inside = 0 }
    inside { print }
  ' "$DOCKERFILE" | sed '1s/^RUN //'
}

run_block() {
  local block
  block="$(distrust_block)"
  # Same shell flags as the Dockerfile's SHELL instruction (minus -x tracing).
  run env PATH="${STUB_BIN}:${PATH}" STORE="$STORE" OS_BUNDLE="$OS_BUNDLE" \
    TMPDIR="$BATS_TEST_TMPDIR" bash -eo pipefail -c "${block//\/tmp\//${BATS_TEST_TMPDIR}/}"
}

@test "Dockerfile has the emsign-distrust block in the base stage" {
  run distrust_block
  [ "$status" -eq 0 ]
  [[ "$output" == keytool\ -list\ -cacerts* ]]
  begin="$(grep -n '^# BEGIN emsign-distrust$' "$DOCKERFILE" | cut -d: -f1)"
  base="$(grep -n '^FROM .* AS base$' "$DOCKERFILE" | cut -d: -f1)"
  builder="$(grep -n '^FROM base AS builder$' "$DOCKERFILE" | cut -d: -f1)"
  [ "$base" -lt "$begin" ]
  [ "$begin" -lt "$builder" ]
}

@test "Dockerfile requires the ca-certificates release without the removed emSign roots" {
  grep -F "'ca-certificates>=20261020'" "$DOCKERFILE"
  grep -F "'ca-certificates-bundle>=20261020'" "$DOCKERFILE"
}

@test "deletes every emSign alias from the JDK cacerts and keeps the rest" {
  run_block
  [ "$status" -eq 0 ]
  run grep -i emsign "$STORE"
  [ "$status" -eq 1 ]
  grep -F 'digicertglobalrootg2 [jdk], ' "$STORE"
  grep -F 'isrgrootx1 [jdk], ' "$STORE"
}

@test "fails the build when an emSign alias survives deletion" {
  export STUB_IGNORE_DELETE=1
  run_block
  [ "$status" -ne 0 ]
  [[ "$output" == *"emSign roots are still present in the JDK cacerts"* ]]
}

@test "fails the build when the OS bundle still trusts emSign ECC Root CA - G3" {
  printf '%s\n' \
    'Owner: CN=emSign ECC Root CA - G3, O=eMudhra Technologies Limited, OU=emSign PKI, C=IN' \
    >> "$OS_BUNDLE"
  run_block
  [ "$status" -ne 0 ]
  [[ "$output" == *"still in the OS CA bundle"* ]]
}
