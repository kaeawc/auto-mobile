#!/usr/bin/env bats
# The effects metallib step with Apple tools mocked: no Metal Toolchain is needed.
setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  SCRIPT="${REPO_ROOT}/scripts/ios/prototype-effects-metallib.sh"
  MOCK_BIN="${BATS_TEST_TMPDIR}/bin"
  OUT="${BATS_TEST_TMPDIR}/out"
  mkdir -p "${MOCK_BIN}"
  export XCRUN_LOG="${BATS_TEST_TMPDIR}/xcrun.log"
  cat > "${MOCK_BIN}/xcrun" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$XCRUN_LOG"
[[ "${MOCK_NO_METAL:-}" == 1 && "$*" == *"metal --version"* ]] && exit 1
if [[ "$*" == *" metallib "* ]]; then
  # xcrun --sdk iphonesimulator metallib <air> -o <out>
  printf 'METALLIB' > "${@: -1}"
elif [[ "$*" == *" metal -c "* ]]; then
  printf 'AIR' > "${@: -1}"
fi
exit 0
MOCK
  chmod +x "${MOCK_BIN}/xcrun"
  export PATH="${MOCK_BIN}:${PATH}"
}

@test "compiles the presets for the simulator and embeds the metallib as base64" {
  run bash "$SCRIPT" "$OUT"
  [ "$status" -eq 0 ]
  [ "$output" = "${OUT}/PrototypeEffectsMetallib.swift" ]
  grep -q 'enum PrototypeEffectsMetallib' "$output"
  grep -q "static let base64 = \"$(printf 'METALLIB' | base64)\"" "$output"
  grep -q -- '-mios-simulator-version-min=17.0' "$XCRUN_LOG"
}

@test "fails instead of downloading when the Metal Toolchain is missing and downloads are off" {
  MOCK_NO_METAL=1 PROTOTYPE_EFFECTS_NO_DOWNLOAD=1 run bash "$SCRIPT" "$OUT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Metal Toolchain is not installed"* ]]
}

@test "the shader source declares every function the renderer calls" {
  for name in pixelate chromaticAberration wave ripple noise gradientMesh; do
    grep -q "$name(" "${REPO_ROOT}/ios/prototype-agent/Shaders/PrototypeEffects.metal"
    grep -q "library\.$name(" "${REPO_ROOT}/ios/prototype-agent/Sources/AutoMobilePrototypeAgent/PrototypeEffectsView.swift"
  done
}
