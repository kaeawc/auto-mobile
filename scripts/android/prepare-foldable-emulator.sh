#!/usr/bin/env bash
# Prepare the exact profile required by the foldable integration test. Deliberately
# no pixel_10_pro_fold -> pixel_9_pro_fold -> pixel_fold fallback: the test requires
# pixel_10_pro_fold or resizable and asserts their specific panel sizes.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/android/prepare-foldable-emulator.sh <profile>
       scripts/android/prepare-foldable-emulator.sh --check-emulator-libs
       scripts/android/prepare-foldable-emulator.sh --help

Updates cmdline-tools, verifies the requested AVD profile, and installs windowed
runtime libraries for resizable. The library-check mode is diagnostic only.
Overrides: FOLDABLE_SDK_ROOT, FOLDABLE_SDKMANAGER, FOLDABLE_AVDMANAGER,
FOLDABLE_SUDO, FOLDABLE_APT_GET, FOLDABLE_LDD (executable paths).
FOLDABLE_MV overrides forward promotion moves only; rollback uses system mv.
Diagnostics: ${GITHUB_WORKSPACE:-$PWD}/scratch/foldable-lane/sdk-diagnostics.txt
USAGE
}

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 1
fi
case "$1" in
  --help|-h) usage; exit 0 ;;
  --check-emulator-libs) mode=libs ;;
  -*) usage >&2; exit 1 ;;
  *) mode=prepare; profile="$1" ;;
esac

summary="${GITHUB_WORKSPACE:-$PWD}/scratch/foldable-lane/sdk-diagnostics.txt"
sdk_root="${FOLDABLE_SDK_ROOT:-${ANDROID_HOME:-${ANDROID_SDK_ROOT:-${ANDROID_SDK_HOME:-}}}}"
if [[ -z "${sdk_root}" ]]; then
  for candidate in "/usr/local/lib/android/sdk" "${HOME:-}/Library/Android/sdk" "${HOME:-}/Android/Sdk"; do
    if [[ -d "${candidate}" ]]; then
      sdk_root="${candidate}"
      break
    fi
  done
fi

if [[ "${mode}" == libs ]]; then
  # Keep missing tools, absent binaries, and artifact I/O failures diagnostic only.
  mkdir -p "$(dirname "${summary}")" || true
  {
    echo "emulator_library_diagnostics:"
    if [[ -z "${sdk_root}" ]]; then
      echo "Android SDK root unavailable; cannot check emulator shared libraries."
    else
      for binary in "${sdk_root}/emulator/qemu/linux-x86_64/qemu-system-x86_64" \
        "${sdk_root}/emulator/lib64/qt/plugins/platforms/libqxcb.so"; do
        echo "Checking ${binary}"
        if [[ ! -f "${binary}" ]]; then
          echo "Not present; shared library check skipped."
          continue
        fi
        if lib_output="$("${FOLDABLE_LDD:-ldd}" "${binary}" 2>&1)"; then
          if ! printf '%s\n' "${lib_output}" | grep 'not found'; then
            echo "all shared libraries resolved"
          fi
        else
          printf 'ldd failed: %s\n' "${lib_output}"
        fi
      done
    fi
  } | tee -a "${summary}" || true
  exit 0
fi

mkdir -p "$(dirname "${summary}")"
printf 'requested_profile=%s\n' "${profile}" > "${summary}"
if [[ -z "${sdk_root}" ]]; then
  echo "profile_found=false" >> "${summary}"
  echo "error: could not resolve an Android SDK root." | tee -a "${summary}" >&2
  exit 1
fi
export ANDROID_HOME="${sdk_root}" ANDROID_SDK_ROOT="${sdk_root}"

resolve_tools() {
  sdkmanager="${FOLDABLE_SDKMANAGER:-${sdk_root}/cmdline-tools/latest/bin/sdkmanager}"
  avdmanager="${FOLDABLE_AVDMANAGER:-${sdk_root}/cmdline-tools/latest/bin/avdmanager}"
}

read_revision() {
  local properties="${1:-${sdk_root}/cmdline-tools/latest}/source.properties"
  if [[ -f "${properties}" ]]; then
    sed -n 's/^Pkg\.Revision[[:space:]]*=[[:space:]]*//p' "${properties}"
  else
    echo "unknown (source.properties missing)"
  fi
}

# Stable SDK revisions are numeric dotted versions. Compare components with
# portable awk rather than relying on GNU sort -V or Bash 4 features.
revision_newer() {
  if [[ ! "$1" =~ ^[0-9]+(\.[0-9]+)*$ || ! "$2" =~ ^[0-9]+(\.[0-9]+)*$ ]]; then
    echo false
    return 0
  fi
  awk -v candidate="$1" -v current="$2" 'BEGIN {
    n = split(candidate, a, "."); m = split(current, b, ".")
    for (i = 1; i <= n || i <= m; i++) {
      if (a[i] + 0 > b[i] + 0) { print "true"; exit }
      if (a[i] + 0 < b[i] + 0) { print "false"; exit }
    }
    print "false"
  }'
}

promote_side_install() {
  local candidate candidate_revision newest="" newest_revision current_revision is_newer
  local latest="${sdk_root}/cmdline-tools/latest" previous promoted=false found=false
  current_revision="$(read_revision)"
  newest_revision="${current_revision}"
  for candidate in "${sdk_root}/cmdline-tools/"latest-*; do
    [[ -d "${candidate}" && -f "${candidate}/bin/avdmanager" && -f "${candidate}/source.properties" ]] || continue
    candidate_revision="$(read_revision "${candidate}")"
    [[ "${candidate_revision}" =~ ^[0-9]+(\.[0-9]+)*$ ]] || continue
    found=true
    is_newer="$(revision_newer "${candidate_revision}" "${newest_revision}")"
    if [[ "${is_newer}" == true ]]; then
      newest="${candidate}"
      newest_revision="${candidate_revision}"
    fi
  done
  # Preserve all existing output when sdkmanager did not leave a side install.
  [[ "${found}" == true ]] || return 0
  if [[ -n "${newest}" ]]; then
    previous="${sdk_root}/.foldable-cmdline-tools-previous/latest-${current_revision}"
    if ! mkdir -p "$(dirname "${previous}")" || ! rm -rf "${previous}"; then
      echo "warning: could not prepare previous cmdline-tools directory; continuing to profile verification." >&2
    elif ! "${FOLDABLE_MV:-mv}" "${latest}" "${previous}"; then
      echo "warning: could not move previous cmdline-tools; continuing to profile verification." >&2
    elif "${FOLDABLE_MV:-mv}" "${newest}" "${latest}"; then
      promoted=true
      printf 'cmdline_tools_promoted_from=%s\n' "${newest##*/}" >> "${summary}"
    else
      echo "warning: could not promote cmdline-tools; continuing to profile verification." >&2
    fi
    if [[ "${promoted}" == false && ! -d "${latest}" && -d "${previous}" ]]; then
      # Recover after either forward move fails, including a command that moved
      # the old install before returning failure. Do not use the injected forward-move command for recovery. Copy is a
      # fallback if the system rename also fails, keeping latest available.
      if ! mv "${previous}" "${latest}"; then
        echo "warning: cmdline-tools rollback move failed; copying previous latest." >&2
        cp -R "${previous}" "${latest}"
      fi
    fi
  fi
  printf 'cmdline_tools_promoted=%s\n' "${promoted}" >> "${summary}"
}

print_tool_versions() {
  echo "cmdline-tools revision: ${revision}"
  if ! "${sdkmanager}" --version; then
    echo "warning: sdkmanager --version failed" >&2
  fi
}

resolve_tools
revision="$(read_revision)"
revision_before="${revision}"
echo "Before cmdline-tools update:"
print_tool_versions
emulator_version="not installed"
if [[ -x "${sdk_root}/emulator/emulator" ]]; then
  if emulator_version="$("${sdk_root}/emulator/emulator" -version 2>&1)"; then
    printf '%s\n' "${emulator_version}"
  else
    printf 'warning: emulator -version failed: %s\n' "${emulator_version}" >&2
  fi
else
  echo "emulator: ${emulator_version}"
fi
echo "avdmanager list device -c (before):"
if devices_before="$("${avdmanager}" list device -c)"; then
  printf '%s\n' "${devices_before}"
else
  devices_before="unavailable (avdmanager failed)"
  echo "warning: initial avdmanager list device -c failed" >&2
fi
{
  printf 'sdk_root=%s\ncmdline_tools_revision_before=%s\n' "${sdk_root}" "${revision_before}"
  printf 'emulator_version_begin\n%s\nemulator_version_end\n' "${emulator_version}"
  printf 'avdmanager_devices_before_begin\n%s\navdmanager_devices_before_end\n' "${devices_before}"
} >> "${summary}"

echo "Accepting SDK licenses before cmdline-tools update:"
# yes can exit with SIGPIPE after sdkmanager closes stdin; only sdkmanager's
# status determines whether license acceptance failed.
set +e
yes | "${sdkmanager}" --licenses
license_statuses=("${PIPESTATUS[@]}")
set -e
license_status="${license_statuses[1]}"
if [[ "${license_status}" -ne 0 ]]; then
  echo "warning: sdkmanager --licenses failed (exit ${license_status}); continuing to profile verification." >&2
fi
if "${sdkmanager}" --install 'cmdline-tools;latest'; then
  update_status=0
else
  update_status=$?
  echo "warning: cmdline-tools update failed (exit ${update_status}); continuing to profile verification." >&2
fi

promote_side_install

# Resolve again so a newly installed latest/bin/avdmanager is used.
resolve_tools
revision="$(read_revision)"
echo "After cmdline-tools update:"
print_tool_versions
echo "avdmanager list device -c (after):"
list_status=0
if devices_after="$("${avdmanager}" list device -c)"; then
  printf '%s\n' "${devices_after}"
else
  list_status=$?
  echo "warning: updated avdmanager list device -c failed (exit ${list_status})" >&2
fi
profile_found=false
if [[ "${list_status}" -eq 0 ]] && printf '%s\n' "${devices_after}" | grep -Fx -- "${profile}" >/dev/null; then
  profile_found=true
fi
{
  printf 'cmdline_tools_revision_after=%s\nlicenses_exit=%s\nupdate_exit=%s\n' "${revision}" "${license_status}" "${update_status}"
  printf 'profile_found=%s\navdmanager_list_exit=%s\n' "${profile_found}" "${list_status}"
  printf 'avdmanager_devices_after_begin\n%s\navdmanager_devices_after_end\n' "${devices_after}"
} >> "${summary}"
if [[ "${profile_found}" != true ]]; then
  echo "error: requested AVD profile '${profile}' is unavailable after cmdline-tools update; no fallback is permitted." >&2
  echo "Available fold-capable profiles (avdmanager list device -c):" >&2
  printf '%s\n' "${devices_after}" | grep -i fold >&2 || echo "(none available)" >&2
  exit 1
fi

if [[ "${profile}" == resizable ]]; then
  # Ubuntu 24.04 names, including the ALSA t64 rename. These cover windowed
  # qemu's audio/GL libraries and the bundled Qt xcb plugin's X11 runtime.
  packages=(libpulse0 libasound2t64 libgl1 libnss3 libxkbfile1 libx11-xcb1
    libxcb-cursor0 libxcb-xinerama0 libxcb-icccm4 libxcb-image0
    libxcb-keysyms1 libxcb-render-util0 libxkbcommon-x11-0)
  "${FOLDABLE_SUDO:-sudo}" "${FOLDABLE_APT_GET:-apt-get}" update
  "${FOLDABLE_SUDO:-sudo}" "${FOLDABLE_APT_GET:-apt-get}" install -y --no-install-recommends "${packages[@]}"
  printf 'Installed windowed emulator packages: %s\n' "${packages[*]}" | tee -a "${summary}"
fi
