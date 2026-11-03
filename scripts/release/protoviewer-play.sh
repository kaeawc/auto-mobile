#!/usr/bin/env bash
# Google Play publishing for ProtoViewer (#14147) through fastlane `supply`.
#
# Called by .github/workflows/publish-protoviewer-play.yml. Every Play operation goes through
# `operate`, so the workflow stays thin and the argument lists are tested in
# test/bats/protoviewer-play-publish.bats with a stub fastlane.
#
# Usage:
#   protoviewer-play.sh tag-version <protoviewer/MAJOR.MINOR.PATCH>
#   protoviewer-play.sh version-code <MAJOR.MINOR.PATCH>
#   protoviewer-play.sh check-changelog <versionCode>
#   protoviewer-play.sh upload-internal --aab <path> --version-code <n> [--release-status <s>]
#   protoviewer-play.sh operate <promote-closed|promote-production|rollout|halt> \
#       --version-code <n> [--fraction <0<f<=1>]
#
# Environment:
#   SUPPLY_JSON_KEY_DATA      Play service-account JSON (required by upload-internal and operate;
#                             read by fastlane itself, never printed or written to disk here)
#   PLAY_CLOSED_TRACK         closed-testing track name (default: alpha)
#   PROTOVIEWER_METADATA_DIR  fastlane Android metadata root (default: fastlane/metadata/android)
#   FASTLANE_BIN              fastlane executable (default: `bundle exec fastlane`)
#
# Exit codes: 0 success, 1 fastlane or check failure, 2 usage or input error.
set -euo pipefail

readonly PACKAGE_NAME="dev.jasonpearson.automobile.protoviewer"
readonly TAG_PREFIX="protoviewer/"
# Same bounds as ProtoViewerVersioning (android/build-logic): major <= 2099, minor/patch <= 999.
readonly VERSION_RE='^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$'
# Promotions and rollout changes never touch binaries or store-listing text.
readonly SKIP_ALL_UPLOADS=(
  --skip_upload_apk true
  --skip_upload_aab true
  --skip_upload_metadata true
  --skip_upload_changelogs true
  --skip_upload_images true
  --skip_upload_screenshots true
)

usage_error() {
  echo "protoviewer-play: $*" >&2
  exit 2
}

metadata_dir() {
  printf '%s\n' "${PROTOVIEWER_METADATA_DIR:-fastlane/metadata/android}"
}

version_code() {
  local version="$1"
  [[ "$version" =~ $VERSION_RE ]] \
    || usage_error "release version '$version' must be plain MAJOR.MINOR.PATCH"
  local major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}" patch="${BASH_REMATCH[3]}"
  ((major <= 2099)) || usage_error "release version '$version': major must be <= 2099"
  ((minor <= 999 && patch <= 999)) \
    || usage_error "release version '$version': minor and patch must be <= 999"
  printf '%s\n' "$((major * 1000000 + minor * 1000 + patch))"
}

tag_version() {
  local tag="$1"
  [[ "$tag" == "$TAG_PREFIX"* ]] || usage_error "tag '$tag' must start with $TAG_PREFIX"
  local version="${tag#"$TAG_PREFIX"}"
  version_code "$version" >/dev/null
  printf '%s\n' "$version"
}

require_version_code() {
  [[ "$1" =~ ^[1-9][0-9]{0,9}$ ]] || usage_error "version code '$1' must be a positive integer"
}

require_fraction() {
  local fraction="$1"
  if [[ ! "$fraction" =~ ^(0\.[0-9]+|1(\.0+)?)$ || "$fraction" =~ ^0\.0+$ ]]; then
    usage_error "fraction '$fraction' must be a decimal in (0, 1]"
  fi
}

# Fails closed when a locale has no release notes for this exact versionCode: the Play
# "What's new" text must be written per release, never the generic default.txt.
check_changelog() {
  local code="$1" dir locale_dir found=0 missing=()
  require_version_code "$code"
  dir="$(metadata_dir)"
  [[ -d "$dir" ]] || { echo "protoviewer-play: no metadata directory $dir" >&2; return 1; }
  for locale_dir in "$dir"/*/; do
    [[ -d "$locale_dir" ]] || continue
    found=1
    local file="${locale_dir}changelogs/${code}.txt"
    if [[ ! -s "$file" ]] || ! grep -q '[^[:space:]]' "$file"; then
      missing+=("$file")
    fi
  done
  ((found)) || { echo "protoviewer-play: no locales under $dir" >&2; return 1; }
  if ((${#missing[@]} > 0)); then
    printf 'protoviewer-play: missing or blank release notes: %s\n' "${missing[@]}" >&2
    return 1
  fi
}

run_supply() {
  [[ -n "${SUPPLY_JSON_KEY_DATA:-}" ]] \
    || usage_error "SUPPLY_JSON_KEY_DATA is not set (the Play service-account JSON)"
  local fastlane=()
  if [[ -n "${FASTLANE_BIN:-}" ]]; then
    fastlane=("$FASTLANE_BIN")
  else
    fastlane=(bundle exec fastlane)
  fi
  ${fastlane[@]+"${fastlane[@]}"} supply --package_name "$PACKAGE_NAME" "$@"
}

upload_internal() {
  local aab="" code="" status="completed"
  while (($# > 0)); do
    case "$1" in
      --aab) aab="${2:-}"; shift 2 ;;
      --version-code) code="${2:-}"; shift 2 ;;
      --release-status) status="${2:-}"; shift 2 ;;
      *) usage_error "upload-internal: unknown argument '$1'" ;;
    esac
  done
  [[ -f "$aab" ]] || usage_error "upload-internal: --aab '$aab' is not a file"
  [[ "$aab" == *.aab ]] || usage_error "upload-internal: --aab must be an .aab bundle"
  [[ "$status" == completed || "$status" == draft ]] \
    || usage_error "upload-internal: --release-status must be completed or draft"
  require_version_code "$code"
  check_changelog "$code"
  run_supply \
    --track internal \
    --aab "$aab" \
    --version_code "$code" \
    --release_status "$status" \
    --metadata_path "$(metadata_dir)" \
    --skip_upload_apk true \
    --skip_upload_metadata true \
    --skip_upload_images true \
    --skip_upload_screenshots true
}

# Moves an already uploaded versionCode from one track to another. No binary is sent, so
# what reaches closed testing and production is the exact bundle internal testers ran.
promote() {
  local from="$1" to="$2" code="$3" fraction="$4"
  local rollout=()
  if [[ -n "$fraction" ]]; then
    rollout=(--rollout "$fraction")
  fi
  run_supply \
    --track "$from" \
    --track_promote_to "$to" \
    --track_promote_release_status completed \
    --version_code "$code" \
    ${rollout[@]+"${rollout[@]}"} \
    "${SKIP_ALL_UPLOADS[@]}"
}

operate() {
  local op="${1:-}" code="" fraction=""
  shift || true
  while (($# > 0)); do
    case "$1" in
      --version-code) code="${2:-}"; shift 2 ;;
      --fraction) fraction="${2:-}"; shift 2 ;;
      *) usage_error "operate: unknown argument '$1'" ;;
    esac
  done
  require_version_code "$code"
  local closed="${PLAY_CLOSED_TRACK:-alpha}"
  [[ "$closed" =~ ^[a-z0-9][a-z0-9:_-]*$ && "$closed" != production && "$closed" != internal ]] \
    || usage_error "PLAY_CLOSED_TRACK '$closed' is not a closed-testing track name"
  case "$op" in
    promote-closed)
      [[ -z "$fraction" ]] || usage_error "promote-closed takes no --fraction"
      promote internal "$closed" "$code" ""
      ;;
    promote-production)
      require_fraction "$fraction"
      promote "$closed" production "$code" "$fraction"
      ;;
    rollout)
      require_fraction "$fraction"
      run_supply --track production --version_code "$code" --rollout "$fraction" \
        "${SKIP_ALL_UPLOADS[@]}"
      ;;
    halt)
      # supply only updates in-progress or draft releases, so it can halt a staged rollout but
      # cannot resume a halted one; resume is done in the Play Console (design doc 8.3).
      require_fraction "$fraction"
      run_supply --track production --version_code "$code" --rollout "$fraction" \
        --release_status halted "${SKIP_ALL_UPLOADS[@]}"
      ;;
    *) usage_error "operate: unknown operation '$op'" ;;
  esac
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    tag-version) tag_version "${1:-}" ;;
    version-code) version_code "${1:-}" ;;
    check-changelog) check_changelog "${1:-}" ;;
    upload-internal) upload_internal "$@" ;;
    operate) operate "$@" ;;
    *) usage_error "usage: protoviewer-play.sh <tag-version|version-code|check-changelog|upload-internal|operate> ..." ;;
  esac
}

main "$@"
