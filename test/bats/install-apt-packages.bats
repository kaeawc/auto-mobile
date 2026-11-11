#!/usr/bin/env bats
#
# Tests for scripts/ci/install-apt-packages.sh. `sudo`, `apt-get`, `timeout`
# and `sleep` are PATH stubs, so no package is installed and no time passes.

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/../../scripts/ci/install-apt-packages.sh"
  MOCK_BIN="$(mktemp -d)"
  export CALLS="${MOCK_BIN}/calls"
  : > "$CALLS"
  # Like real sudo, drop the fallback overrides unless passed through `env`.
  cat > "${MOCK_BIN}/sudo" <<'STUB'
#!/usr/bin/env bash
exec env -u APT_INSTALL_FALLBACK_MIRROR -u APT_INSTALL_UBUNTU_CODENAME "$@"
STUB
  # MOCK_TIMEOUT_EXPIRE_FIRST=N reports exit 124 for the first N bounded calls.
  cat > "${MOCK_BIN}/timeout" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "-k" ]; then shift 2; fi
echo "timeout $1" >> "$CALLS"
shift
n="$(grep -c '^timeout ' "$CALLS")"
if [ "$n" -le "${MOCK_TIMEOUT_EXPIRE_FIRST:-0}" ]; then exit 124; fi
exec "$@"
STUB
  cat > "${MOCK_BIN}/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  # Records each call with any custom sources list's contents; fails while
  # APT_FAIL_DEFAULT=1 unless pointed at the fallback sources list.
  cat > "${MOCK_BIN}/apt-get" <<'STUB'
#!/usr/bin/env bash
echo "apt-get $*" >> "$CALLS"
for arg in "$@"; do
  case "$arg" in
    Dir::Etc::sourcelist=*) cat "${arg#Dir::Etc::sourcelist=}" >> "$CALLS"; exit 0 ;;
  esac
done
[ "${APT_FAIL_DEFAULT:-0}" = 1 ] && exit 100
exit 0
STUB
  chmod +x "${MOCK_BIN}"/*
  export PATH="${MOCK_BIN}:${PATH}"
  export APT_INSTALL_FALLBACK_MIRROR=http://fallback.example.test/ubuntu
  export APT_INSTALL_UBUNTU_CODENAME=noble
}

teardown() {
  rm -rf "$MOCK_BIN"
}

@test "installs from the default mirror under a bounded timeout" {
  run bash "$SCRIPT" ffmpeg
  [ "$status" -eq 0 ]
  [[ "$output" == *"Installed ffmpeg"* ]]
  grep -qx 'timeout 60' "$CALLS"
  grep -qx 'timeout 90' "$CALLS"
  grep -qx 'apt-get install -y --no-install-recommends ffmpeg' "$CALLS"
  ! grep -q fallback.example.test "$CALLS"
}

@test "a stalled update is retried on the default mirror and then succeeds" {
  MOCK_TIMEOUT_EXPIRE_FIRST=1 run bash "$SCRIPT" ffmpeg
  [ "$status" -eq 0 ]
  [[ "$output" == *"apt-get update timed out after 60s"* ]]
  [[ "$output" == *"apt-get update (attempt 2/2"* ]]
  [[ "$output" == *"Installed ffmpeg"* ]]
  ! grep -q fallback.example.test "$CALLS"
}

@test "a failing default mirror falls back to the alternate mirror's pockets" {
  APT_FAIL_DEFAULT=1 run bash "$SCRIPT" ffmpeg
  [ "$status" -eq 0 ]
  [[ "$output" == *"falling back to http://fallback.example.test/ubuntu"* ]]
  [[ "$output" == *"Installed ffmpeg from http://fallback.example.test/ubuntu"* ]]
  grep -qx 'timeout 120' "$CALLS"
  grep -qx 'deb http://fallback.example.test/ubuntu noble main universe' "$CALLS"
  grep -qx 'deb http://fallback.example.test/ubuntu noble-updates main universe' "$CALLS"
  grep -qx 'deb http://fallback.example.test/ubuntu noble-security main universe' "$CALLS"
}

@test "exhausting every mirror fails with an annotation naming the packages" {
  MOCK_TIMEOUT_EXPIRE_FIRST=99 run bash "$SCRIPT" ffmpeg libx264-164
  [ "$status" -eq 1 ]
  [[ "$output" == *"::error title=apt install failed::could not install ffmpeg libx264-164"* ]]
  [ "$(grep -c '^timeout ' "$CALLS")" -eq 4 ]
}

@test "rejects no packages and a non-integer timeout" {
  run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  APT_INSTALL_TIMEOUT_SECONDS=abc run bash "$SCRIPT" ffmpeg
  [ "$status" -eq 2 ]
  [[ "$output" == *"INSTALL_TIMEOUT_SECONDS must be a positive integer"* ]]
}

@test "required CI paths install apt packages only through this helper (#17930)" {
  local repo_root="$BATS_TEST_DIRNAME/../.."
  local file
  for file in .github/workflows/pull_request.yml .github/workflows/merge.yml \
    .github/actions/ci-android-device-whep/action.yml \
    .github/actions/ci-webrtc-publisher-integration/action.yml \
    scripts/ci/install-fast-validation-deps.sh scripts/ci/run-bats.sh; do
    run grep -nE '^[^#]*(sudo apt-get|apt-get (update|install))' "$repo_root/$file"
    [ "$status" -eq 1 ] || { echo "$file: $output"; false; }
  done
  grep -Fq 'scripts/ci/install-apt-packages.sh xmlstarlet' "$repo_root/.github/workflows/merge.yml"
  grep -Fq 'install-apt-packages.sh' "$repo_root/scripts/ci/install-fast-validation-deps.sh"
}
