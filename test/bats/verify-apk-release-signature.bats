#!/usr/bin/env bats
# bats file_tags=parallel-within-file
#
# Tests for scripts/ci/verify-apk-release-signature.sh (#15301): a release APK
# must verify and must not chain to the Android debug certificate.

SCRIPT="${BATS_TEST_DIRNAME}/../../scripts/ci/verify-apk-release-signature.sh"
RELEASE_DIGEST="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

setup() {
  WORK="$(mktemp -d)"
  APK="${WORK}/protoviewer-release.apk"
  printf 'apk' > "$APK"
  mkdir -p "${WORK}/bin"
}

teardown() {
  rm -rf "$WORK"
}

# make_apksigner <exit-code> <certificate DN>
make_apksigner() {
  cat > "${WORK}/bin/apksigner" <<EOS
#!/usr/bin/env bash
if [ "$1" != "0" ]; then
  echo "DOES NOT VERIFY" >&2
  exit $1
fi
echo "Signer #1 certificate DN: $2"
echo "Signer #1 certificate SHA-256 digest: ${RELEASE_DIGEST}"
EOS
  chmod +x "${WORK}/bin/apksigner"
}

# make_apksigner_v37 <certificate DN>: the build-tools 37 --print-certs format.
make_apksigner_v37() {
  cat > "${WORK}/bin/apksigner" <<EOS
#!/usr/bin/env bash
echo "V2 Signer: certificate DN: $1"
echo "V2 Signer: certificate SHA-256 digest: ${RELEASE_DIGEST}"
echo "V2 Signer: certificate SHA-1 digest: cc30c3dbf2b0b644781a05acda37f19ac9159066"
EOS
  chmod +x "${WORK}/bin/apksigner"
}

run_script() {
  run env APKSIGNER_BIN="${WORK}/bin/apksigner" bash "$SCRIPT" "$@"
}

@test "accepts an APK signed with a non-debug certificate and prints its digest" {
  make_apksigner 0 "CN=AutoMobile Release, O=kaeawc"
  run_script "$APK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"certificate-sha256=${RELEASE_DIGEST}"* ]]
}

@test "rejects an APK signed with the Android debug certificate" {
  make_apksigner 0 "C=US, O=Android, CN=Android Debug"
  run_script "$APK"
  [ "$status" -ne 0 ]
  [[ "$output" == *"debug certificate"* ]]
}

@test "rejects an APK whose signature does not verify" {
  make_apksigner 1 "CN=AutoMobile Release"
  run_script "$APK"
  [ "$status" -ne 0 ]
  [[ "$output" == *"could not verify the signature"* ]]
}

@test "fails when the APK is missing" {
  make_apksigner 0 "CN=AutoMobile Release"
  run_script "${WORK}/missing.apk"
  [ "$status" -ne 0 ]
  [[ "$output" == *"APK not found"* ]]
}

@test "fails with usage when no argument is given" {
  run_script
  [ "$status" -eq 2 ]
}

@test "falls back to the newest build-tools apksigner under ANDROID_HOME" {
  make_apksigner 0 "CN=AutoMobile Release"
  mkdir -p "${WORK}/sdk/build-tools/34.0.0" "${WORK}/sdk/build-tools/36.0.0"
  cp "${WORK}/bin/apksigner" "${WORK}/sdk/build-tools/36.0.0/apksigner"
  run env -u APKSIGNER_BIN PATH="/usr/bin:/bin" ANDROID_HOME="${WORK}/sdk" bash "$SCRIPT" "$APK"
  [ "$status" -eq 0 ]
}

@test "accepts the build-tools 37 'V2 Signer:' format and prints its digest" {
  make_apksigner_v37 "CN=AutoMobile Release, O=kaeawc"
  run_script "$APK"
  [ "$status" -eq 0 ]
  [[ "$output" == *"certificate-sha256=${RELEASE_DIGEST}"* ]]
}

@test "rejects a debug-signed APK in the build-tools 37 format" {
  make_apksigner_v37 "C=US, O=Android, CN=Android Debug"
  run_script "$APK"
  [ "$status" -ne 0 ]
  [[ "$output" == *"debug certificate"* ]]
}
