#!/usr/bin/env bats
#
# scripts/android/prototype-preview.sh with Gradle stubbed out: the test proves the
# argument mapping to the -Dprototype.preview.* switches and the output listing,
# not the renderer (PrototypePreviewRenderTest covers that on the JVM).

setup() {
  bats_require_minimum_version 1.5.0
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  SCRIPT="${REPO_ROOT}/scripts/android/prototype-preview.sh"
  CALLS="${BATS_TEST_TMPDIR}/calls.log"
  OUT="${BATS_TEST_TMPDIR}/out"
  SPECS="${BATS_TEST_TMPDIR}/specs"
  mkdir -p "${SPECS}"
  printf '{}\n' > "${SPECS}/one.json"
  printf '{}\n' > "${SPECS}/two.json"

  # Stub Gradle: record each argument on its own line, then write the PNGs the
  # renderer would, named after each spec in -Dprototype.preview.spec.
  STUB="${BATS_TEST_TMPDIR}/gradlew"
  cat > "${STUB}" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "$@" > "${CALLS}"
[[ -n "${STUB_WRITE_NOTHING:-}" ]] && exit 0
out="" specs=""
for arg in "$@"; do
  case "${arg}" in
    -Dprototype.preview.out=*) out="${arg#*=}" ;;
    -Dprototype.preview.spec=*) specs="${arg#*=}" ;;
  esac
done
IFS=: read -r -a list <<< "${specs}"
for spec in "${list[@]}"; do
  : > "${out}/$(basename "${spec}" .json).png"
done
[[ ${#list[@]} -gt 1 ]] && : > "${out}/contact-sheet.png"
exit 0
SCRIPT
  chmod +x "${STUB}"
  export CALLS
  export PROTOTYPE_PREVIEW_GRADLEW="${STUB}"
}

@test "maps options to preview switches and prints the PNG" {
  run bash "${SCRIPT}" --out "${OUT}" --width 411 --height 891 --density 420 --theme dark \
    "${SPECS}/one.json"
  [ "$status" -eq 0 ]
  [ "$output" = "${OUT}/one.png" ]
  grep -qxF ':control-proxy:testDebugUnitTest' "${CALLS}"
  grep -qxF '*PrototypePreviewRenderTest' "${CALLS}"
  grep -qxF -- '--rerun' "${CALLS}"
  grep -qxF -- "-Dprototype.preview.spec=${SPECS}/one.json" "${CALLS}"
  grep -qxF -- "-Dprototype.preview.out=${OUT}" "${CALLS}"
  grep -qxF -- '-Dprototype.preview.width=411' "${CALLS}"
  grep -qxF -- '-Dprototype.preview.height=891' "${CALLS}"
  grep -qxF -- '-Dprototype.preview.density=420' "${CALLS}"
  grep -qxF -- '-Dprototype.preview.theme=dark' "${CALLS}"
}

@test "omits unset switches so the renderer defaults apply" {
  run bash "${SCRIPT}" --out "${OUT}" "${SPECS}/one.json"
  [ "$status" -eq 0 ]
  run ! grep -q -- '-Dprototype.preview.width' "${CALLS}"
  run ! grep -q -- '-Dprototype.preview.theme' "${CALLS}"
}

@test "relative spec paths are made absolute and several specs list a contact sheet" {
  cd "${SPECS}"
  run bash "${SCRIPT}" --out "${OUT}" one.json two.json
  [ "$status" -eq 0 ]
  grep -qxF -- "-Dprototype.preview.spec=${SPECS}/one.json:${SPECS}/two.json" "${CALLS}"
  [ "${lines[0]}" = "${OUT}/one.png" ]
  [ "${lines[1]}" = "${OUT}/two.png" ]
  [ "${lines[2]}" = "${OUT}/contact-sheet.png" ]
}

@test "fails without specs, with a missing spec, or with an unknown option" {
  run bash "${SCRIPT}" --out "${OUT}"
  [ "$status" -eq 2 ]
  [[ "$output" == *"no spec files"* ]]
  run bash "${SCRIPT}" --out "${OUT}" "${SPECS}/missing.json"
  [ "$status" -eq 2 ]
  [[ "$output" == *"spec not found"* ]]
  run bash "${SCRIPT}" --bogus "${SPECS}/one.json"
  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown option"* ]]
  [ ! -s "${CALLS}" ]
}

@test "fails when the renderer writes no PNG" {
  STUB_WRITE_NOTHING=1 run bash "${SCRIPT}" --out "${OUT}" "${SPECS}/one.json"
  [ "$status" -eq 2 ]
  [[ "$output" == *"did not write"* ]]
}

@test "--theme both renders light and dark and names the PNGs by theme" {
  run bash "${SCRIPT}" --out "${OUT}" --theme both "${SPECS}/one.json"
  [ "$status" -eq 0 ]
  [ "${lines[0]}" = "${OUT}/one-light.png" ]
  [ "${lines[1]}" = "${OUT}/one-dark.png" ]
  [ -f "${OUT}/one-light.png" ]
  [ -f "${OUT}/one-dark.png" ]
  [ ! -e "${OUT}/one.png" ]
  [ -z "$(find "${OUT}" -maxdepth 1 -name '.stage-*')" ]
}

@test "--theme both names each theme's contact sheet" {
  run bash "${SCRIPT}" --out "${OUT}" --theme both "${SPECS}/one.json" "${SPECS}/two.json"
  [ "$status" -eq 0 ]
  [ -f "${OUT}/contact-sheet-light.png" ]
  [ -f "${OUT}/contact-sheet-dark.png" ]
}

@test "rejects an unknown --theme" {
  run bash "${SCRIPT}" --out "${OUT}" --theme sepia "${SPECS}/one.json"
  [ "$status" -eq 2 ]
  [[ "$output" == *"--theme must be"* ]]
}
