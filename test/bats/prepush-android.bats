#!/usr/bin/env bats

SCRIPT="scripts/prepush-android.sh"

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
}

copy_prepush_fixture() {
  mkdir -p "${fixture_repo}/scripts/lib" "${fixture_repo}/scripts/ktfmt"
  cp "${REPO_ROOT}/${SCRIPT}" "${fixture_repo}/${SCRIPT}"
  cp "${REPO_ROOT}/scripts/lib/vcs-diff.sh" "${fixture_repo}/scripts/lib/vcs-diff.sh"
}

teardown() {
  cd "${REPO_ROOT}"
  rm -rf "${fixture_repo:-}"
  rm -f "${invocations_file:-}"
}

@test "prints usage for --help" {
  cd "$REPO_ROOT"
  run bash "$SCRIPT" --help

  [ "$status" -eq 0 ]
  [[ "$output" == *"Usage: scripts/prepush-android.sh"* ]]
}

@test "rejects an unknown argument" {
  cd "$REPO_ROOT"
  run bash "$SCRIPT" --unknown

  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown argument: --unknown"* ]]
}

@test "is a successful no-op when there are no Android changes" {
  cd "$REPO_ROOT"
  run env ANDROID_PREPUSH_BASE_REF=HEAD bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"No Android-relevant changes"* ]]
  [[ "$output" == *"nothing to check"* ]]
}

@test "uses jj-aware root, base, and changed-file discovery" {
  fixture_repo="$(cd "$(mktemp -d)" && pwd -P)"
  mkdir -p "${fixture_repo}/.jj" "${fixture_repo}/fake-bin"
  copy_prepush_fixture
  cat > "${fixture_repo}/fake-bin/jj" <<'SCRIPT'
#!/usr/bin/env bash
case "$1 $2" in
  "workspace root") printf '%s\n' "${JJ_FIXTURE_ROOT}" ;;
  "log -r") exit 0 ;;
  "diff --from") printf '%s\n' 'scripts/android/boot-emulator.sh' ;;
  *) exit 1 ;;
esac
SCRIPT
  chmod +x "${fixture_repo}/fake-bin/jj"

  cd "${fixture_repo}"
  run env PATH="${fixture_repo}/fake-bin:${PATH}" JJ_FIXTURE_ROOT="${fixture_repo}" bash "${fixture_repo}/${SCRIPT}"

  [ "$status" -eq 0 ]
  [[ "$output" == *"No changed Kotlin files"* ]]
}

@test "is shellcheck clean" {
  cd "$REPO_ROOT"
  run shellcheck "$SCRIPT"

  [ "$status" -eq 0 ]
}

@test "runs Gradle configuration validation for a root build script-only change" {
  fixture_repo="$(cd "$(mktemp -d)" && pwd -P)"
  invocations_file="$(mktemp)"
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_SYSTEM=/dev/null

  mkdir -p "${fixture_repo}/android"
  copy_prepush_fixture
  cat > "${fixture_repo}/scripts/ktfmt/validate_ktfmt.sh" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
  cat > "${fixture_repo}/android/gradlew" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "${GRADLEW_INVOCATIONS_FILE}"
SCRIPT
  chmod +x "${fixture_repo}/android/gradlew"
  printf '%s\n' 'plugins {}' > "${fixture_repo}/android/build.gradle.kts"

  cd "${fixture_repo}"
  git init -q
  git config user.email t@t.t
  git config user.name t
  git config commit.gpgsign false
  git add -A
  git commit -qm "initial Android build"
  base_sha="$(git rev-parse HEAD)"
  printf '%s\n' '// changed root configuration' >> android/build.gradle.kts
  git add android/build.gradle.kts
  git commit -qm "change root Gradle build"

  run env ANDROID_PREPUSH_BASE_REF="${base_sha}" \
    GRADLEW_INVOCATIONS_FILE="${invocations_file}" \
    bash "${fixture_repo}/${SCRIPT}"

  [ "$status" -eq 0 ]
  grep -qx 'help' "${invocations_file}"
}

@test "runs build-logic compile without queueing nonexistent Detekt" {
  fixture_repo="$(cd "$(mktemp -d)" && pwd -P)"
  invocations_file="$(mktemp)"
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_SYSTEM=/dev/null

  mkdir -p "${fixture_repo}/android/build-logic/src/main/kotlin"
  copy_prepush_fixture
  cat > "${fixture_repo}/scripts/ktfmt/validate_ktfmt.sh" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
  cat > "${fixture_repo}/android/gradlew" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "${GRADLEW_INVOCATIONS_FILE}"
SCRIPT
  chmod +x "${fixture_repo}/android/gradlew"
  printf '%s\n' 'plugins { `kotlin-dsl` }' > "${fixture_repo}/android/build-logic/build.gradle.kts"
  printf '%s\n' 'class Changed' > "${fixture_repo}/android/build-logic/src/main/kotlin/Changed.kt"

  cd "${fixture_repo}"
  git init -q
  git config user.email t@t.t
  git config user.name t
  git config commit.gpgsign false
  git add -A
  git commit -qm "initial Android build logic"
  base_sha="$(git rev-parse HEAD)"
  printf '%s\n' '// changed build logic' >> android/build-logic/src/main/kotlin/Changed.kt
  git add android/build-logic/src/main/kotlin/Changed.kt
  git commit -qm "change build logic"

  run env ANDROID_PREPUSH_BASE_REF="${base_sha}" \
    GRADLEW_INVOCATIONS_FILE="${invocations_file}" \
    bash "${fixture_repo}/${SCRIPT}"

  [ "$status" -eq 0 ]
  if grep -qx ':build-logic:detekt' "${invocations_file}"; then
    false
  fi
  grep -qx ':build-logic:compileKotlin' "${invocations_file}"
}

@test "validates both modules for a cross-module Kotlin rename" {
  fixture_repo="$(cd "$(mktemp -d)" && pwd -P)"
  invocations_file="$(mktemp)"
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_SYSTEM=/dev/null

  mkdir -p "${fixture_repo}/android/source/src/main/kotlin" "${fixture_repo}/android/destination/src/main/kotlin"
  copy_prepush_fixture
  cat > "${fixture_repo}/scripts/ktfmt/validate_ktfmt.sh" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
  cat > "${fixture_repo}/android/gradlew" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "${GRADLEW_INVOCATIONS_FILE}"
SCRIPT
  chmod +x "${fixture_repo}/android/gradlew"
  printf '%s\n' 'plugins {}' > "${fixture_repo}/android/source/build.gradle.kts"
  printf '%s\n' 'plugins {}' > "${fixture_repo}/android/destination/build.gradle.kts"
  printf '%s\n' 'class Moved' > "${fixture_repo}/android/source/src/main/kotlin/Moved.kt"

  cd "${fixture_repo}"
  git init -q
  git config user.email t@t.t
  git config user.name t
  git config commit.gpgsign false
  git add -A
  git commit -qm "initial modules"
  base_sha="$(git rev-parse HEAD)"
  git mv android/source/src/main/kotlin/Moved.kt android/destination/src/main/kotlin/Moved.kt
  git commit -qm "move Kotlin source"

  run env ANDROID_PREPUSH_BASE_REF="${base_sha}" GRADLEW_INVOCATIONS_FILE="${invocations_file}" bash "${fixture_repo}/${SCRIPT}"

  [ "$status" -eq 0 ]
  grep -qx ':source:compileKotlin' "${invocations_file}"
  grep -qx ':destination:compileKotlin' "${invocations_file}"
}

@test "validates both modules when ripgrep is unavailable for a cross-module Kotlin rename" {
  fixture_repo="$(cd "$(mktemp -d)" && pwd -P)"
  invocations_file="$(mktemp)"
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_SYSTEM=/dev/null

  mkdir -p "${fixture_repo}/android/source/src/main/kotlin" "${fixture_repo}/android/destination/src/main/kotlin" "${fixture_repo}/fake-bin"
  copy_prepush_fixture
  cat > "${fixture_repo}/scripts/ktfmt/validate_ktfmt.sh" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
  cat > "${fixture_repo}/android/gradlew" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "${GRADLEW_INVOCATIONS_FILE}"
SCRIPT
  cat > "${fixture_repo}/fake-bin/rg" <<'SCRIPT'
#!/usr/bin/env bash
echo "rg: command not found" >&2
exit 127
SCRIPT
  chmod +x "${fixture_repo}/android/gradlew" "${fixture_repo}/fake-bin/rg"
  printf '%s\n' 'plugins {}' > "${fixture_repo}/android/source/build.gradle.kts"
  printf '%s\n' 'plugins {}' > "${fixture_repo}/android/destination/build.gradle.kts"
  printf '%s\n' 'class Moved' > "${fixture_repo}/android/source/src/main/kotlin/Moved.kt"

  cd "${fixture_repo}"
  git init -q
  git config user.email t@t.t
  git config user.name t
  git config commit.gpgsign false
  git add -A
  git commit -qm "initial modules"
  base_sha="$(git rev-parse HEAD)"
  git mv android/source/src/main/kotlin/Moved.kt android/destination/src/main/kotlin/Moved.kt
  git commit -qm "move Kotlin source"

  run env PATH="${fixture_repo}/fake-bin:${PATH}" ANDROID_PREPUSH_BASE_REF="${base_sha}" \
    GRADLEW_INVOCATIONS_FILE="${invocations_file}" bash "${fixture_repo}/${SCRIPT}"

  [ "$status" -eq 0 ]
  grep -qx ':source:compileKotlin' "${invocations_file}"
  grep -qx ':destination:compileKotlin' "${invocations_file}"
}
