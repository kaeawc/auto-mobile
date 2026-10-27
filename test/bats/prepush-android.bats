#!/usr/bin/env bats

SCRIPT="scripts/prepush-android.sh"

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  export GIT_AUTHOR_NAME=test GIT_COMMITTER_NAME=test
  export GIT_AUTHOR_EMAIL=test@example.com GIT_COMMITTER_EMAIL=test@example.com
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false
}

copy_prepush_fixture() {
  mkdir -p "${fixture_repo}/scripts/lib" "${fixture_repo}/scripts/ktfmt" "${fixture_repo}/scripts/android"
  cp "${REPO_ROOT}/scripts/android/check-lint-baseline-shrink.sh" "${fixture_repo}/scripts/android/"
  cp "${REPO_ROOT}/scripts/android/select-lint-modules.sh" "${fixture_repo}/scripts/android/"
  cp "${REPO_ROOT}/${SCRIPT}" "${fixture_repo}/${SCRIPT}"
  cp "${REPO_ROOT}/scripts/lib/vcs-diff.sh" "${fixture_repo}/scripts/lib/vcs-diff.sh"
}

teardown() {
  cd "${REPO_ROOT}"
  rm -rf "${fixture_repo:-}"
  rm -rf "${symlink_parent:-}"
  rm -f "${invocations_file:-}"
  rm -f "${ktfmt_marker_file:-}"
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
  fixture_repo="$(cd "$(mktemp -d)" && pwd -P)"
  copy_prepush_fixture
  cd "$fixture_repo"
  git init -q
  git add .
  git commit -qm initial
  run env ANDROID_PREPUSH_BASE_REF=HEAD bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"No Android-relevant changes"* ]]
  [[ "$output" == *"nothing to check"* ]]
}

@test "runs full-scope Detekt for a Detekt config-only change" {
  fixture_repo="$(cd "$(mktemp -d)" && pwd -P)"
  invocations_file="$(mktemp)"
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_SYSTEM=/dev/null

  mkdir -p "${fixture_repo}/android/config/detekt"
  copy_prepush_fixture
  cat > "${fixture_repo}/android/gradlew" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "${GRADLEW_INVOCATIONS_FILE}"
SCRIPT
  chmod +x "${fixture_repo}/android/gradlew"
  printf '%s\n' 'config: initial' > "${fixture_repo}/android/config/detekt/detekt.yml"

  cd "${fixture_repo}"
  git init -q
  git add -A
  git commit -qm "initial Detekt config"
  base_sha="$(git rev-parse HEAD)"
  printf '%s\n' 'config: changed' > android/config/detekt/detekt.yml
  git add android/config/detekt/detekt.yml
  git commit -qm "change Detekt config"

  run env ANDROID_PREPUSH_BASE_REF="${base_sha}" \
    GRADLEW_INVOCATIONS_FILE="${invocations_file}" \
    bash "${fixture_repo}/${SCRIPT}"

  [ "$status" -eq 0 ]
  grep -qx 'detektMain' "${invocations_file}"
  grep -qx 'detektTest' "${invocations_file}"
}

@test "runs only apiCheck for an SDK API baseline-only change" {
  fixture_repo="$(cd "$(mktemp -d)" && pwd -P)"
  invocations_file="$(mktemp)"
  ktfmt_marker_file="$(mktemp)"
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_SYSTEM=/dev/null

  mkdir -p "${fixture_repo}/android/auto-mobile-sdk/api"
  copy_prepush_fixture
  cat > "${fixture_repo}/scripts/ktfmt/validate_ktfmt.sh" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' called >> "${KTFMT_MARKER_FILE}"
SCRIPT
  cat > "${fixture_repo}/android/gradlew" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "${GRADLEW_INVOCATIONS_FILE}"
SCRIPT
  chmod +x "${fixture_repo}/scripts/ktfmt/validate_ktfmt.sh" "${fixture_repo}/android/gradlew"
  printf '%s\n' 'initial API baseline' > "${fixture_repo}/android/auto-mobile-sdk/api/auto-mobile-sdk.api"

  cd "${fixture_repo}"
  git init -q
  git add -A
  git commit -qm "initial SDK API baseline"
  base_sha="$(git rev-parse HEAD)"
  printf '%s\n' 'changed API baseline' > android/auto-mobile-sdk/api/auto-mobile-sdk.api
  git add android/auto-mobile-sdk/api/auto-mobile-sdk.api
  git commit -qm "change SDK API baseline"

  run env ANDROID_PREPUSH_BASE_REF="${base_sha}" \
    GRADLEW_INVOCATIONS_FILE="${invocations_file}" \
    KTFMT_MARKER_FILE="${ktfmt_marker_file}" \
    bash "${fixture_repo}/${SCRIPT}"

  [ "$status" -eq 0 ]
  [ "$(cat "${invocations_file}")" = ':auto-mobile-sdk:apiCheck' ]
  [ ! -s "${ktfmt_marker_file}" ]
}

@test "runs apiCheck once when another Kotlin module and the SDK baseline change" {
  fixture_repo="$(cd "$(mktemp -d)" && pwd -P)"
  invocations_file="$(mktemp)"
  ktfmt_marker_file="$(mktemp)"
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_SYSTEM=/dev/null

  mkdir -p "${fixture_repo}/android/foo/src/main/kotlin" "${fixture_repo}/android/auto-mobile-sdk/api"
  copy_prepush_fixture
  cat > "${fixture_repo}/scripts/ktfmt/validate_ktfmt.sh" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' called >> "${KTFMT_MARKER_FILE}"
SCRIPT
  cat > "${fixture_repo}/android/gradlew" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "${GRADLEW_INVOCATIONS_FILE}"
SCRIPT
  chmod +x "${fixture_repo}/scripts/ktfmt/validate_ktfmt.sh" "${fixture_repo}/android/gradlew"
  printf '%s\n' 'plugins {}' > "${fixture_repo}/android/foo/build.gradle.kts"
  printf '%s\n' 'class X' > "${fixture_repo}/android/foo/src/main/kotlin/X.kt"
  printf '%s\n' 'initial API baseline' > "${fixture_repo}/android/auto-mobile-sdk/api/auto-mobile-sdk.api"

  cd "${fixture_repo}"
  git init -q
  git add -A
  git commit -qm "initial Android module and SDK API baseline"
  base_sha="$(git rev-parse HEAD)"
  printf '%s\n' '// changed Kotlin source' >> android/foo/src/main/kotlin/X.kt
  printf '%s\n' 'changed API baseline' > android/auto-mobile-sdk/api/auto-mobile-sdk.api
  git add android/foo/src/main/kotlin/X.kt android/auto-mobile-sdk/api/auto-mobile-sdk.api
  git commit -qm "change Kotlin source and SDK API baseline"

  run env ANDROID_PREPUSH_BASE_REF="${base_sha}" \
    GRADLEW_INVOCATIONS_FILE="${invocations_file}" \
    KTFMT_MARKER_FILE="${ktfmt_marker_file}" \
    bash "${fixture_repo}/${SCRIPT}"

  [ "$status" -eq 0 ]
  [ "$(grep -xc ':auto-mobile-sdk:apiCheck' "${invocations_file}")" -eq 1 ]
  [ -s "${ktfmt_marker_file}" ]
}

@test "runs full-scope Detekt and module compile when Kotlin and Detekt config change" {
  fixture_repo="$(cd "$(mktemp -d)" && pwd -P)"
  invocations_file="$(mktemp)"
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_SYSTEM=/dev/null

  mkdir -p "${fixture_repo}/android/config/detekt" "${fixture_repo}/android/auto-mobile-sdk/src/main/kotlin"
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
  printf '%s\n' 'config: initial' > "${fixture_repo}/android/config/detekt/detekt.yml"
  printf '%s\n' 'plugins { alias(libs.plugins.android.library) }' > "${fixture_repo}/android/auto-mobile-sdk/build.gradle.kts"
  printf '%s\n' 'class X' > "${fixture_repo}/android/auto-mobile-sdk/src/main/kotlin/X.kt"

  cd "${fixture_repo}"
  git init -q
  git add -A
  git commit -qm "initial Android module and Detekt config"
  base_sha="$(git rev-parse HEAD)"
  printf '%s\n' 'config: changed' > android/config/detekt/detekt.yml
  printf '%s\n' '// changed Kotlin source' >> android/auto-mobile-sdk/src/main/kotlin/X.kt
  git add android/config/detekt/detekt.yml android/auto-mobile-sdk/src/main/kotlin/X.kt
  git commit -qm "change Kotlin source and Detekt config"

  run env ANDROID_PREPUSH_BASE_REF="${base_sha}" \
    GRADLEW_INVOCATIONS_FILE="${invocations_file}" \
    bash "${fixture_repo}/${SCRIPT}"

  [ "$status" -eq 0 ]
  grep -qx 'detektMain' "${invocations_file}"
  grep -qx 'detektTest' "${invocations_file}"
  grep -qx ':auto-mobile-sdk:compileDebugKotlin' "${invocations_file}"
  grep -qx ':auto-mobile-sdk:apiCheck' "${invocations_file}"
  if grep -qx ':auto-mobile-sdk:detekt' "${invocations_file}"; then
    false
  fi
}

@test "uses Android debug compile task for convention Android library plugin" {
  fixture_repo="$(cd "$(mktemp -d)" && pwd -P)"
  invocations_file="$(mktemp)"
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_SYSTEM=/dev/null

  mkdir -p "${fixture_repo}/android/config/detekt" "${fixture_repo}/android/auto-mobile-sdk/src/main/kotlin"
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
  printf '%s\n' 'config: initial' > "${fixture_repo}/android/config/detekt/detekt.yml"
  printf '%s\n' 'plugins { id("automobile.android-library") }' > "${fixture_repo}/android/auto-mobile-sdk/build.gradle.kts"
  printf '%s\n' 'class X' > "${fixture_repo}/android/auto-mobile-sdk/src/main/kotlin/X.kt"

  cd "${fixture_repo}"
  git init -q
  git add -A
  git commit -qm "initial Android module and Detekt config"
  base_sha="$(git rev-parse HEAD)"
  printf '%s\n' 'config: changed' > android/config/detekt/detekt.yml
  printf '%s\n' '// changed Kotlin source' >> android/auto-mobile-sdk/src/main/kotlin/X.kt
  git add android/config/detekt/detekt.yml android/auto-mobile-sdk/src/main/kotlin/X.kt
  git commit -qm "change Kotlin source and Detekt config"

  run env ANDROID_PREPUSH_BASE_REF="${base_sha}" \
    GRADLEW_INVOCATIONS_FILE="${invocations_file}" \
    bash "${fixture_repo}/${SCRIPT}"

  [ "$status" -eq 0 ]
  grep -qx 'detektMain' "${invocations_file}"
  grep -qx 'detektTest' "${invocations_file}"
  grep -qx ':auto-mobile-sdk:compileDebugKotlin' "${invocations_file}"
  if grep -qx ':auto-mobile-sdk:compileKotlin' "${invocations_file}"; then
    false
  fi
  grep -qx ':auto-mobile-sdk:apiCheck' "${invocations_file}"
  if grep -qx ':auto-mobile-sdk:detekt' "${invocations_file}"; then
    false
  fi
}

@test "uses Android debug compile task for convention Android application plugin" {
  fixture_repo="$(cd "$(mktemp -d)" && pwd -P)"
  invocations_file="$(mktemp)"
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_SYSTEM=/dev/null

  mkdir -p "${fixture_repo}/android/config/detekt" "${fixture_repo}/android/control-proxy/src/main/kotlin"
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
  printf '%s\n' 'config: initial' > "${fixture_repo}/android/config/detekt/detekt.yml"
  printf '%s\n' 'plugins { id("automobile.android-application") }' > "${fixture_repo}/android/control-proxy/build.gradle.kts"
  printf '%s\n' 'class X' > "${fixture_repo}/android/control-proxy/src/main/kotlin/X.kt"

  cd "${fixture_repo}"
  git init -q
  git add -A
  git commit -qm "initial Android module and Detekt config"
  base_sha="$(git rev-parse HEAD)"
  printf '%s\n' 'config: changed' > android/config/detekt/detekt.yml
  printf '%s\n' '// changed Kotlin source' >> android/control-proxy/src/main/kotlin/X.kt
  git add android/config/detekt/detekt.yml android/control-proxy/src/main/kotlin/X.kt
  git commit -qm "change Kotlin source and Detekt config"

  run env ANDROID_PREPUSH_BASE_REF="${base_sha}" \
    GRADLEW_INVOCATIONS_FILE="${invocations_file}" \
    bash "${fixture_repo}/${SCRIPT}"

  [ "$status" -eq 0 ]
  grep -qx 'detektMain' "${invocations_file}"
  grep -qx 'detektTest' "${invocations_file}"
  grep -qx ':control-proxy:compileDebugKotlin' "${invocations_file}"
  if grep -qx ':control-proxy:compileKotlin' "${invocations_file}"; then
    false
  fi
  if grep -qx ':control-proxy:detekt' "${invocations_file}"; then
    false
  fi
}

@test "accepts a repository root reached through a symlink" {
  fixture_repo="$(cd "$(mktemp -d)" && pwd -P)"
  symlink_parent="$(cd "$(mktemp -d)" && pwd -P)"
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_SYSTEM=/dev/null

  mkdir -p "${fixture_repo}/android"
  copy_prepush_fixture
  ln -s "${fixture_repo}" "${symlink_parent}/checkout"

  cd "${fixture_repo}"
  git init -q
  git add -A
  git commit -qm "initial fixture"

  cd "${symlink_parent}/checkout"
  run env ANDROID_PREPUSH_BASE_REF=HEAD bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" != *"run scripts/prepush-android.sh from the repository root"* ]]
}

@test "fails when changed-file discovery has no merge base" {
  fixture_repo="$(cd "$(mktemp -d)" && pwd -P)"
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_SYSTEM=/dev/null

  mkdir -p "${fixture_repo}/android"
  copy_prepush_fixture
  printf '%s\n' 'plugins {}' > "${fixture_repo}/android/build.gradle.kts"

  cd "${fixture_repo}"
  git init -q
  git add -A
  git commit -qm "initial Android build"
  tree_sha="$(git write-tree)"
  orphan_sha="$(git commit-tree "${tree_sha}" -m "orphan root")"

  run env ANDROID_PREPUSH_BASE_REF="${orphan_sha}" bash "${fixture_repo}/${SCRIPT}"

  [ "$status" -eq 2 ]
  [[ "$output" == *"failed to list Android changes"* ]]
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

@test "runs Gradle configuration validation when a module build script is removed" {
  fixture_repo="$(cd "$(mktemp -d)" && pwd -P)"
  invocations_file="$(mktemp)"
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_SYSTEM=/dev/null

  mkdir -p "${fixture_repo}/android/foo/src/main/kotlin"
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
  printf '%s\n' 'plugins {}' > "${fixture_repo}/android/foo/build.gradle.kts"
  printf '%s\n' 'class X' > "${fixture_repo}/android/foo/src/main/kotlin/X.kt"

  cd "${fixture_repo}"
  git init -q
  git add -A
  git commit -qm "initial Android module"
  base_sha="$(git rev-parse HEAD)"
  git rm -q android/foo/build.gradle.kts
  git commit -qm "remove module build script"

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
  mkdir -p "${fixture_repo}/android/build-logic/src/test/kotlin"
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
  printf '%s\n' 'class ChangedTest' > "${fixture_repo}/android/build-logic/src/test/kotlin/ChangedTest.kt"

  cd "${fixture_repo}"
  git init -q
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
  grep -qx ':build-logic:test' "${invocations_file}"
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

@test "attests Android partial scope and records tests without sources as skipped" {
  fixture_repo="$(cd "$(mktemp -d)" && pwd -P)"
  invocations_file="$(mktemp)"
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_SYSTEM=/dev/null
  mkdir -p "${fixture_repo}/android/foo/src/main/kotlin" "${fixture_repo}/scripts/ci"
  copy_prepush_fixture
  printf '#!/bin/bash\nexit 0\n' > "${fixture_repo}/scripts/ktfmt/validate_ktfmt.sh"
  printf '#!/bin/bash\nexit 0\n' > "${fixture_repo}/android/gradlew"
  cat > "${fixture_repo}/scripts/ci/record-attestations.sh" <<'SCRIPT'
#!/bin/bash
printf '%s\n' "$@" > "$ATTESTATION_ARGS_FILE"
SCRIPT
  chmod +x "${fixture_repo}/scripts/ktfmt/validate_ktfmt.sh" "${fixture_repo}/android/gradlew" "${fixture_repo}/scripts/ci/record-attestations.sh"
  printf '%s\n' 'plugins {}' > "${fixture_repo}/android/foo/build.gradle.kts"
  printf '%s\n' 'class X' > "${fixture_repo}/android/foo/src/main/kotlin/X.kt"
  cd "${fixture_repo}"
  git init -q
  git add -A
  git commit -qm initial
  base_sha="$(git rev-parse HEAD)"
  printf '%s\n' '// changed' >> android/foo/src/main/kotlin/X.kt
  git add android/foo/src/main/kotlin/X.kt
  git commit -qm change
  run env ANDROID_PREPUSH_BASE_REF="${base_sha}" ATTESTATION_ARGS_FILE="${invocations_file}" \
    /bin/bash "${fixture_repo}/${SCRIPT}"
  [ "$status" -eq 0 ]
  grep -qx partial "${invocations_file}"
  grep -Fx 'scoped Detekt/compile/tests for changed modules only; not a substitute for the full-tree CI Detekt job' "${invocations_file}"
  grep -Fx 'Android unit tests=skip:0' "${invocations_file}"
}

lint_fixture() {
  fixture_repo="$(cd "$(mktemp -d)" && pwd -P)"
  invocations_file="$(mktemp)"
  copy_prepush_fixture
  mkdir -p "$fixture_repo/android/foo/src/main/res/values" "$fixture_repo/android/bar/src/main"
  printf 'plugins { id("automobile.android-library") }\n' > "$fixture_repo/android/foo/build.gradle.kts"
  printf 'plugins { id("automobile.android-application") }\n' > "$fixture_repo/android/bar/build.gradle.kts"
  printf '<resources/>\n' > "$fixture_repo/android/foo/src/main/res/values/strings.xml"
  printf '<manifest/>\n' > "$fixture_repo/android/bar/src/main/AndroidManifest.xml"
  cat > "$fixture_repo/android/gradlew" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GRADLEW_INVOCATIONS_FILE"
SCRIPT
  chmod +x "$fixture_repo/android/gradlew"
  cd "$fixture_repo"
  git init -q
  git add .
  git commit -qm initial
  base_sha="$(git rev-parse HEAD)"
}

@test "lint selects and deduplicates owners of unstaged resources and manifests" {
  lint_fixture
  printf '<resources><string name="x">x</string></resources>\n' > android/foo/src/main/res/values/strings.xml
  printf '<resources/>\n' > android/foo/src/main/res/values/new.xml
  printf '<manifest package="test"/>\n' > android/bar/src/main/AndroidManifest.xml
  run env ANDROID_PREPUSH_BASE_REF="$base_sha" GRADLEW_INVOCATIONS_FILE="$invocations_file" bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$invocations_file")" = ':bar:lintDebug :foo:lintDebug --continue' ]
  [[ "$output" == *'shrink-only'* ]]
}

@test "lint runs for deleted resources" {
  lint_fixture
  rm android/foo/src/main/res/values/strings.xml
  run env ANDROID_PREPUSH_BASE_REF="$base_sha" GRADLEW_INVOCATIONS_FILE="$invocations_file" bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$invocations_file")" = ':foo:lintDebug --continue' ]
}

@test "new local baseline cannot bypass the pre-push shrink guard" {
  lint_fixture
  printf '<issues><issue id="New"/></issues>\n' > android/foo/lint-baseline.xml
  run env ANDROID_PREPUSH_BASE_REF="$base_sha" GRADLEW_INVOCATIONS_FILE="$invocations_file" bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *'new baseline'* ]]
  [ "$(cat "$invocations_file")" = ':foo:lintDebug --continue' ]
}

@test "lint failure propagates from pre-push" {
  lint_fixture
  printf '<manifest package="test"/>\n' > android/bar/src/main/AndroidManifest.xml
  printf '#!/usr/bin/env bash\nexit 7\n' > android/gradlew
  run env ANDROID_PREPUSH_BASE_REF="$base_sha" bash "$SCRIPT"
  [ "$status" -eq 7 ]
}

@test "Gradle properties select lint for all modules" {
  lint_fixture
  printf 'android.useAndroidX=true\n' > android/gradle.properties
  run env ANDROID_PREPUSH_BASE_REF="$base_sha" GRADLEW_INVOCATIONS_FILE="$invocations_file" bash "$SCRIPT"
  [ "$status" -eq 0 ]
  grep -qx 'lintDebug --continue' "$invocations_file"
  grep -qx help "$invocations_file"
}

@test "the shrink guard rejects a baseline outside an Android plugin module" {
  lint_fixture
  mkdir -p android/config
  printf '<issues/>\n' > android/config/lint-baseline.xml
  run env ANDROID_PREPUSH_BASE_REF="$base_sha" GRADLEW_INVOCATIONS_FILE="$invocations_file" bash "$SCRIPT"
  [ "$status" -eq 1 ]
  [[ "$output" == *'new baseline'* ]]
}

@test "staged cross-module resource rename lints both modules" {
  lint_fixture
  mkdir -p android/bar/src/main/res/values
  git mv android/foo/src/main/res/values/strings.xml android/bar/src/main/res/values/strings.xml
  run env ANDROID_PREPUSH_BASE_REF="$base_sha" GRADLEW_INVOCATIONS_FILE="$invocations_file" bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$invocations_file")" = ':bar:lintDebug :foo:lintDebug --continue' ]
}

@test "ProtoViewer selection verifies dependencies and runs unit tests" {
  fixture_repo="$(cd "$(mktemp -d)" && pwd -P)"
  invocations_file="$(mktemp)"
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_SYSTEM=/dev/null

  mkdir -p "${fixture_repo}/android/config/detekt" "${fixture_repo}/android/protoviewer/src/main/kotlin"
  mkdir -p "${fixture_repo}/android/protoviewer/src/test"
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
  printf '%s\n' 'config: initial' > "${fixture_repo}/android/config/detekt/detekt.yml"
  printf '%s\n' 'plugins { id("automobile.android-application") }' > "${fixture_repo}/android/protoviewer/build.gradle.kts"
  printf '%s\n' 'class X' > "${fixture_repo}/android/protoviewer/src/main/kotlin/X.kt"

  cd "${fixture_repo}"
  git init -q
  git add -A
  git commit -qm "initial Android module and Detekt config"
  base_sha="$(git rev-parse HEAD)"
  printf '%s\n' 'config: changed' > android/config/detekt/detekt.yml
  printf '%s\n' '// changed Kotlin source' >> android/protoviewer/src/main/kotlin/X.kt
  git add android/config/detekt/detekt.yml android/protoviewer/src/main/kotlin/X.kt
  git commit -qm "change Kotlin source and Detekt config"

  run env ANDROID_PREPUSH_BASE_REF="${base_sha}" \
    GRADLEW_INVOCATIONS_FILE="${invocations_file}" \
    bash "${fixture_repo}/${SCRIPT}"

  [ "$status" -eq 0 ]
  grep -qx ':protoviewer:verifyProtoViewerDependencies' "${invocations_file}"
  grep -qx ':protoviewer:test' "${invocations_file}"
  grep -qx 'detektMain' "${invocations_file}"
  grep -qx 'detektTest' "${invocations_file}"
  grep -qx ':protoviewer:compileDebugKotlin' "${invocations_file}"
  if grep -qx ':protoviewer:compileKotlin' "${invocations_file}"; then
    false
  fi
  if grep -qx ':protoviewer:detekt' "${invocations_file}"; then
    false
  fi
}
