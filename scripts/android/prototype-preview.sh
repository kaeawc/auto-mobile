#!/usr/bin/env bash
#
# Render prototype specs to PNG on the host, with no device attached (issue #10445).
#
# Runs control-proxy's PrototypePreviewRenderTest, which draws each spec through the
# production Compose renderer (PrototypeSpecContent) under Robolectric's native
# graphics, and writes <spec-name>.png per spec plus contact-sheet.png when more
# than one spec is given.
#
# Usage:
#   scripts/android/prototype-preview.sh [--out DIR] [--width DP] [--height DP]
#     [--density DPI] [--theme light|dark|both] SPEC.json [SPEC.json ...]
#
# Defaults: --out scratch/prototype-preview, 360x640 dp, 160 dpi, light.
# --theme sets the device night mode; a spec whose theme mode is light or dark
# still decides for itself. --theme both renders twice and writes
# <name>-light.png and <name>-dark.png (plus contact-sheet-light/dark.png).
#
# PROTOTYPE_PREVIEW_GRADLEW overrides the Gradle wrapper (tests use a stub).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

usage() {
  sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
  echo "prototype-preview: $*" >&2
  exit 2
}

absolute_path() {
  local path="$1"
  if [[ "${path}" == /* ]]; then
    printf '%s\n' "${path}"
  else
    printf '%s/%s\n' "${PWD}" "${path}"
  fi
}

out_dir="${REPO_ROOT}/scratch/prototype-preview"
width=""
height=""
density=""
theme=""
specs=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --out | --width | --height | --density | --theme)
      [[ $# -ge 2 ]] || die "$1 needs a value"
      case "$1" in
        --out) out_dir="$(absolute_path "$2")" ;;
        --width) width="$2" ;;
        --height) height="$2" ;;
        --density) density="$2" ;;
        --theme) theme="$2" ;;
      esac
      shift 2
      ;;
    --)
      shift
      specs+=("$@")
      break
      ;;
    -*) die "unknown option $1 (see --help)" ;;
    *)
      specs+=("$1")
      shift
      ;;
  esac
done

[[ ${#specs[@]} -gt 0 ]] || die "no spec files given (see --help)"

spec_list=""
for spec in ${specs[@]+"${specs[@]}"}; do
  [[ -f "${spec}" ]] || die "spec not found: ${spec}"
  [[ "${spec}" != *:* ]] || die "spec paths must not contain ':': ${spec}"
  spec_list+="${spec_list:+:}$(absolute_path "${spec}")"
done

mkdir -p "${out_dir}"

case "${theme}" in
  "" | light | dark | both) ;;
  *) die "--theme must be light, dark or both, got '${theme}'" ;;
esac

# run_gradle THEME OUT_DIR renders every spec once at the given night mode.
run_gradle() {
  local run_theme="$1" run_out="$2"
  local gradle_args=(
    -p "${REPO_ROOT}/android"
    :control-proxy:testDebugUnitTest
    --tests '*PrototypePreviewRenderTest'
    --rerun
    "-Dprototype.preview.spec=${spec_list}"
    "-Dprototype.preview.out=${run_out}"
  )
  [[ -z "${width}" ]] || gradle_args+=("-Dprototype.preview.width=${width}")
  [[ -z "${height}" ]] || gradle_args+=("-Dprototype.preview.height=${height}")
  [[ -z "${density}" ]] || gradle_args+=("-Dprototype.preview.density=${density}")
  [[ -z "${run_theme}" ]] || gradle_args+=("-Dprototype.preview.theme=${run_theme}")
  "${PROTOTYPE_PREVIEW_GRADLEW:-${REPO_ROOT}/android/gradlew}" "${gradle_args[@]}"
}

if [[ "${theme}" == "both" ]]; then
  for variant in light dark; do
    stage="$(mktemp -d "${out_dir}/.stage-${variant}.XXXXXX")"
    run_gradle "${variant}" "${stage}"
    for spec in ${specs[@]+"${specs[@]}"}; do
      name="$(basename "${spec}" .json)"
      [[ -f "${stage}/${name}.png" ]] || die "renderer did not write ${stage}/${name}.png"
      mv "${stage}/${name}.png" "${out_dir}/${name}-${variant}.png"
      echo "${out_dir}/${name}-${variant}.png"
    done
    if [[ ${#specs[@]} -gt 1 ]]; then
      mv "${stage}/contact-sheet.png" "${out_dir}/contact-sheet-${variant}.png"
      echo "${out_dir}/contact-sheet-${variant}.png"
    fi
    rm -rf "${stage}"
  done
  exit 0
fi

run_gradle "${theme}" "${out_dir}"

for spec in ${specs[@]+"${specs[@]}"}; do
  name="$(basename "${spec}" .json)"
  png="${out_dir}/${name}.png"
  [[ -f "${png}" ]] || die "renderer did not write ${png}"
  echo "${png}"
done
if [[ ${#specs[@]} -gt 1 ]]; then
  echo "${out_dir}/contact-sheet.png"
fi
