#!/usr/bin/env bats
# lipo is stubbed: the stub mirrors Xcode 27.1 beta, which accepts only one architecture per
# -verify_arch flag ("requires exactly one input file"), so the helper must split the check.
setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  MOCK_BIN="${BATS_TEST_TMPDIR}/bin"
  export LIPO_LOG="${BATS_TEST_TMPDIR}/lipo.log"
  mkdir -p "$MOCK_BIN"
  cat > "${MOCK_BIN}/lipo" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$LIPO_LOG"
[[ "$2" == -verify_arch && $# -eq 3 ]] || { echo 'lipo: -verify_arch requires exactly one input file' >&2; exit 1; }
[[ " ${LIPO_PRESENT_ARCHS:-arm64 x86_64} " == *" $3 "* ]] || { echo "missing $3 slice" >&2; exit 1; }
SCRIPT
  chmod +x "${MOCK_BIN}/lipo"
  export PATH="${MOCK_BIN}:${PATH}"
  LIB="${REPO_ROOT}/scripts/lib/lipo-verify-arch.sh"
}

@test "checks each architecture with its own lipo invocation" {
  run bash -c 'source "$1"; lipo_verify_archs /fake/ProtoViewer arm64 x86_64' _ "$LIB"
  [ "$status" -eq 0 ]
  run cat "$LIPO_LOG"
  [ "$output" = $'/fake/ProtoViewer -verify_arch arm64\n/fake/ProtoViewer -verify_arch x86_64' ]
}

@test "fails when any requested architecture slice is missing" {
  run env LIPO_PRESENT_ARCHS=arm64 bash -c 'source "$1"; lipo_verify_archs /fake/ProtoViewer arm64 x86_64' _ "$LIB"
  [ "$status" -ne 0 ]
  [[ "$output" == *'missing x86_64 slice'* ]]
}

@test "accepts a single architecture" {
  run bash -c 'source "$1"; lipo_verify_archs /fake/ProtoViewer arm64' _ "$LIB"
  [ "$status" -eq 0 ]
}

@test "rejects an empty architecture list before calling lipo" {
  run bash -c 'source "$1"; lipo_verify_archs /fake/ProtoViewer' _ "$LIB"
  [ "$status" -eq 2 ]
  [[ "$output" == *'at least one architecture'* ]]
  [ ! -e "$LIPO_LOG" ]
}

@test "sourcing the helper has no side effects" {
  run bash -c 'source "$1"' _ "$LIB"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ ! -e "$LIPO_LOG" ]
}

@test "build scripts and the release verifier use the per-architecture helper" {
  for script in scripts/ios/protoviewer-build.sh scripts/ios/prototype-viewer-build.sh scripts/ci/verify-prototype-viewer.sh; do
    run grep -c 'lipo_verify_archs' "${REPO_ROOT}/${script}"
    [ "$output" -ge 1 ]
    run grep -E -- '-verify_arch [^"]*arm64 x86_64|-verify_arch "\$\{archs' "${REPO_ROOT}/${script}"
    [ "$status" -ne 0 ]
  done
}
