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

  run desktop_app_asset_suffix macos x86_64
  [ "$status" -ne 0 ]

  run desktop_app_asset_suffix linux arm64
  [ "$status" -ne 0 ]
}

@test "does not mistake a Git Bash host for Linux" {
  uname() { printf 'MINGW64_NT-10.0\n'; }

  run detect_desktop_app_os

  [ "$status" -eq 0 ]
  [ "$output" = "windows" ]
}

@test "detects Apple Silicon hardware when the installer runs under Rosetta" {
  uname() { printf 'Darwin\n'; }
  sysctl() { printf '1\n'; }

  run detect_desktop_app_arch

  [ "$status" -eq 0 ]
  [ "$output" = "arm64" ]
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
  dpkg-deb() { printf 'amd64\n'; }

  run desktop_app_deb_architecture_matches_host /tmp/AutoMobile.deb x86_64

  [ "$status" -eq 0 ]
}

@test "does not offer a Linux desktop install without deb package tools" {
  detect_desktop_app_os() { printf 'linux\n'; }
  detect_arch() { printf 'x86_64\n'; }
  desktop_app_is_root() { return 0; }
  command_exists() { [[ "$1" == "dpkg-deb" ]]; }
  gum() { printf 'gum should not be called\n'; return 1; }

  run offer_desktop_app_install

  [ "$status" -eq 0 ]
  [[ "$output" != *"gum should not be called"* ]]
  [ "$INSTALL_DESKTOP_APP" = "false" ]
}

@test "runs privileged desktop commands directly when already root" {
  desktop_app_is_root() { return 0; }
  sudo() { printf 'sudo should not be called\n'; return 1; }
  root_command() { printf 'ran directly\n'; }

  run run_desktop_app_privileged root_command

  [ "$status" -eq 0 ]
  [ "$output" = "ran directly" ]
}

@test "replaces an existing macOS app bundle through a staged copy" {
  local root source_app target_app
  root=$(mktemp -d)
  source_app="${root}/source/AutoMobile.app"
  target_app="${root}/Applications/AutoMobile.app"
  mkdir -p "${source_app}" "${target_app}"
  printf 'new\n' > "${source_app}/new-marker"
  printf 'old\n' > "${target_app}/old-marker"
  run_desktop_app_privileged() { "$@"; }
  ditto() { cp -R "$1" "$2"; }

  install_macos_desktop_app_bundle "${source_app}" "${target_app}"

  [ -f "${target_app}/new-marker" ]
  [ ! -e "${target_app}/old-marker" ]
  rm -rf "${root}"
}

@test "rejects a concurrent macOS app replacement without touching the installed app" {
  local root source_app target_app lock_dir
  root=$(mktemp -d)
  source_app="${root}/source/AutoMobile.app"
  target_app="${root}/Applications/AutoMobile.app"
  lock_dir="${root}/Applications/.automobile-install.lock"
  mkdir -p "${source_app}" "${target_app}" "${lock_dir}"
  printf 'old\n' > "${target_app}/old-marker"
  run_desktop_app_privileged() { "$@"; }

  run install_macos_desktop_app_bundle "${source_app}" "${target_app}"

  [ "$status" -ne 0 ]
  [ -f "${target_app}/old-marker" ]
  rm -rf "${root}"
}

@test "preserves desktop installer temporary files while a disk image cannot detach" {
  local root
  root=$(mktemp -d)
  DESKTOP_APP_TEMP_DIR="${root}"
  DESKTOP_APP_MOUNT_DIR="${root}/mount"
  mkdir -p "${DESKTOP_APP_MOUNT_DIR}"
  hdiutil() { return 1; }

  cleanup_desktop_app_installer

  [ -d "${root}" ]
  [ "${DESKTOP_APP_MOUNT_DIR}" = "${root}/mount" ]
  DESKTOP_APP_MOUNT_DIR=""
  cleanup_desktop_app_installer
  [ ! -e "${root}" ]
}

@test "dry-run records a desktop installation without fetching a release" {
  DRY_RUN=true
  detect_desktop_app_os() { printf 'linux\n'; }
  detect_arch() { printf 'x86_64\n'; }
  desktop_app_prerequisites_available() { return 1; }
  fetch_latest_desktop_app_release() { return 1; }

  install_desktop_app

  [[ "${DRY_RUN_LOG[*]}" == *"linux/x86_64"* ]]
}

@test "--desktop-app enables the optional desktop installation" {
  parse_args --desktop-app

  [ "$INSTALL_DESKTOP_APP" = "true" ]
}
