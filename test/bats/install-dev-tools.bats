#!/usr/bin/env bats

# shellcheck disable=SC2329

setup() {
  TEST_DIR="$(mktemp -d)"
  STUB_BIN="${TEST_DIR}/bin"
  mkdir -p "${STUB_BIN}"

  ORIG_PATH="${PATH}"
  ORIG_TMPDIR="${TMPDIR-}"
  ORIG_TMPDIR_SET="${TMPDIR+x}"
  CHMOD="$(command -v chmod)"
  RM="$(command -v rm)"

  export PATH="${STUB_BIN}:/usr/bin:/bin"
  export TMPDIR="${TEST_DIR}"
  # Ubuntu has /usr/bin/timeout; macOS normally has no system timeout. Keep
  # every test on the same bounded-install path, independent of the host.
  cat > "${STUB_BIN}/timeout" <<'STUB'
#!/usr/bin/env bash
[[ "${1:-}" == "-k" && "$#" -ge 5 ]] || exit 125
shift 3 # -k GRACE SECONDS
exec "$@"
STUB
  "$CHMOD" +x "${STUB_BIN}/timeout"
  export INSTALL_SH_SOURCE_ONLY=true
  # shellcheck source=/dev/null
  source scripts/install.sh

  log_info() { printf '[INFO] %s\n' "$1"; }
  log_warn() { printf '[WARN] %s\n' "$1"; }
  run_spinner() {
    shift
    "$@"
  }
}

teardown() {
  export PATH="${ORIG_PATH}"
  if [[ -n "${ORIG_TMPDIR_SET}" ]]; then
    export TMPDIR="${ORIG_TMPDIR}"
  else
    unset TMPDIR
  fi
  "$RM" -rf "${TEST_DIR}"
}

@test "macOS development tool installer fails when any Homebrew package install fails" {
  cat > "${STUB_BIN}/brew" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "list" ]]; then
  exit 0
fi

if [[ "${1:-}" == "install" && "${2:-}" == "shellcheck" ]]; then
  exit 1
fi

exit 0
STUB
  "$CHMOD" +x "${STUB_BIN}/brew"

  run _install_dev_tools_brew
  echo "$output"

  [ "$status" -ne 0 ]
  [[ "$output" == *"dev tool(s) could not be installed"* ]]
}

@test "macOS development tools are installed in one Homebrew invocation" {
  local brew_args="${TEST_DIR}/brew-args"
  local brew_calls="${TEST_DIR}/brew-calls"
  local installed_formulae="${TEST_DIR}/installed-formulae"

  cat > "${STUB_BIN}/brew" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "list" ]]; then
  [[ -f "${INSTALLED_FORMULAE}" ]] && cat "${INSTALLED_FORMULAE}"
  exit 0
fi

if [[ "${1:-}" == "install" ]]; then
  shift
  printf 'install\n' >> "${BREW_CALLS}"
  printf '%s\n' "$@" > "${BREW_ARGS}"
  printf '%s\n' "$@" > "${INSTALLED_FORMULAE}"
  exit 0
fi

exit 1
STUB
  "$CHMOD" +x "${STUB_BIN}/brew"

  export BREW_ARGS="${brew_args}"
  export BREW_CALLS="${brew_calls}"
  export INSTALLED_FORMULAE="${installed_formulae}"
  run _install_dev_tools_brew
  echo "$output"

  [ "$status" -eq 0 ]
  [ "$(cat "${brew_calls}")" = "install" ]
  local expected_packages
  expected_packages="$(printf '%s\n' shellcheck jq ripgrep yq gum hadolint xmlstarlet swiftformat swiftlint xcodegen libusbmuxd ideviceinstaller)"
  [ "$(cat "${brew_args}")" = "${expected_packages}" ]
}

@test "macOS development tool installer fails when Homebrew fails after listing packages" {
  local install_attempted="${TEST_DIR}/install-attempted"

  cat > "${STUB_BIN}/brew" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "list" ]]; then
  if [[ -f "${INSTALL_ATTEMPTED}" ]]; then
    printf '%s\n' shellcheck jq ripgrep yq gum hadolint xmlstarlet swiftformat swiftlint xcodegen libusbmuxd ideviceinstaller
    # Exceed the pipe buffer with matches first to expose grep -q's SIGPIPE.
    seq -f 'filler-%g' 1 20000
  fi
  exit 0
fi

if [[ "${1:-}" == "install" ]]; then
  touch "${INSTALL_ATTEMPTED}"
  exit 42
fi

exit 1
STUB
  "$CHMOD" +x "${STUB_BIN}/brew"
  export INSTALL_ATTEMPTED="${install_attempted}"

  run _install_dev_tools_brew
  echo "$output"

  [ "$status" -eq 42 ]
  [[ "$output" == *"Homebrew reported an error"* ]]
}

@test "macOS development tools already listed in a large Homebrew inventory are not reinstalled" {
  local brew_calls="${TEST_DIR}/brew-calls"

  cat > "${STUB_BIN}/brew" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "list" ]]; then
  printf '%s\n' shellcheck jq ripgrep yq gum hadolint xmlstarlet swiftformat swiftlint xcodegen libusbmuxd ideviceinstaller
  # Keep the same large inventory as the post-install regression test.
  seq -f 'filler-%g' 1 20000
  exit 0
fi

if [[ "${1:-}" == "install" ]]; then
  printf 'install\n' >> "${BREW_REINSTALL_CALLS}"
  exit 0
fi

exit 1
STUB
  "$CHMOD" +x "${STUB_BIN}/brew"
  export BREW_REINSTALL_CALLS="${brew_calls}"

  run _install_dev_tools_brew
  echo "$output"

  [ "$status" -eq 0 ]
  [[ "$output" == *"Development tools ready."* ]]
  [ ! -e "${brew_calls}" ]
}

@test "Linux development tool installer fails when any apt package install fails" {
  cat > "${STUB_BIN}/apt-get" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  "$CHMOD" +x "${STUB_BIN}/apt-get"

  cat > "${STUB_BIN}/dpkg" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
  "$CHMOD" +x "${STUB_BIN}/dpkg"

  cat > "${STUB_BIN}/sudo" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "apt-get" && "${2:-}" == "install" && "${5:-}" == "shellcheck" ]]; then
  exit 1
fi

exit 0
STUB
  "$CHMOD" +x "${STUB_BIN}/sudo"

  run _install_dev_tools_apt
  echo "$output"

  [ "$status" -ne 0 ]
  [[ "$output" == *"dev tool(s) could not be installed"* ]]
}
