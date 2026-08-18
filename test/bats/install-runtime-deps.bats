#!/usr/bin/env bats

# Regression coverage for #4636: a required runtime dependency must not let
# the installer report success when its package installation fails.

setup() {
  export INSTALL_SH_SOURCE_ONLY=true
  # shellcheck source=/dev/null
  source scripts/install.sh

  log_info() { :; }
  log_warn() { :; }
}

@test "fails when the required ffmpeg installation fails" {
  command_exists() {
    [[ "$1" != "ffmpeg" ]]
  }
  _install_system_package() {
    [[ "$1" == "ffmpeg" ]]
    return 1
  }

  run install_runtime_deps

  [ "$status" -eq 1 ]
}

@test "skips ffmpeg install and succeeds when AUTOMOBILE_INSTALL_SKIP_FFMPEG=true" {
  command_exists() {
    [[ "$1" != "ffmpeg" ]]
  }
  _install_system_package() {
    # Must never be called when the skip flag is set.
    return 1
  }
  export AUTOMOBILE_INSTALL_SKIP_FFMPEG=true

  run install_runtime_deps

  [ "$status" -eq 0 ]
}

@test "succeeds when ffmpeg is already installed" {
  command_exists() {
    [[ "$1" == "ffmpeg" ]]
  }
  _install_system_package() {
    return 1
  }

  run install_runtime_deps

  [ "$status" -eq 0 ]
}

@test "allows an interactive user to decline ffmpeg installation" {
  detect_os() {
    printf 'linux\n'
  }
  command_exists() {
    [[ "$1" == "apt-get" ]]
  }
  gum() {
    [[ "$1" == "confirm" ]]
    return 1
  }
  NON_INTERACTIVE=false

  run install_runtime_deps

  [ "$status" -eq 0 ]
}
