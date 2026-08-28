#!/usr/bin/env bats

setup() {
  export INSTALL_SH_SOURCE_ONLY=true
  # shellcheck source=/dev/null
  source scripts/install.sh

  log_info() { :; }
  log_error() { :; }
}

release_json='{
  "assets": [
    {"name":"AutoMobile-0.0.66-windows.msi","browser_download_url":"https://example.test/windows.msi"},
    {"name":"AutoMobile-0.0.66-linux.deb","browser_download_url":"https://example.test/linux.deb"},
    {"name":"AutoMobile-0.0.66-macos.dmg","browser_download_url":"https://example.test/macos.dmg"}
  ]
}'

@test "maps supported host OS and architecture pairs to their release asset suffix" {
  run desktop_app_asset_suffix macos arm64
  [ "$status" -eq 0 ]
  [ "$output" = "-macos.dmg" ]

  run desktop_app_asset_suffix linux x86_64
  [ "$status" -eq 0 ]
  [ "$output" = "-linux.deb" ]

  run desktop_app_asset_suffix linux riscv64
  [ "$status" -ne 0 ]
}

@test "does not mistake a Git Bash host for Linux" {
  uname() { printf 'MINGW64_NT-10.0\n'; }

  run detect_desktop_app_os

  [ "$status" -eq 0 ]
  [ "$output" = "windows" ]
}

@test "selects the exact platform installer from GitHub release metadata" {
  run resolve_desktop_app_release_asset "$release_json" "-linux.deb"

  [ "$status" -eq 0 ]
  [ "$output" = "https://example.test/linux.deb" ]
}

@test "rejects a deb whose package architecture differs from the host" {
  command_exists() { [[ "$1" == "dpkg-deb" ]]; }
  dpkg-deb() { printf 'amd64\n'; }

  run desktop_app_deb_architecture_matches_host /tmp/AutoMobile.deb arm64

  [ "$status" -ne 0 ]
}

@test "accepts a deb whose package architecture matches the host" {
  command_exists() { [[ "$1" == "dpkg-deb" ]]; }
  dpkg-deb() { printf 'arm64\n'; }

  run desktop_app_deb_architecture_matches_host /tmp/AutoMobile.deb arm64

  [ "$status" -eq 0 ]
}

@test "dry-run records a desktop installation without fetching a release" {
  DRY_RUN=true
  detect_desktop_app_os() { printf 'linux\n'; }
  detect_arch() { printf 'x86_64\n'; }
  fetch_latest_desktop_app_release() { return 1; }

  install_desktop_app

  [[ "${DRY_RUN_LOG[*]}" == *"linux/x86_64"* ]]
}

@test "--desktop-app enables the optional desktop installation" {
  parse_args --desktop-app

  [ "$INSTALL_DESKTOP_APP" = "true" ]
}
