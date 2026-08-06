#!/usr/bin/env bash
#
# Guards the Kotlin-compile convention extraction (issue #5027).
#
# The Kotlin compiler options (language version, JVM target, the shared opt-in
# list) and the Java/Kotlin toolchain must live in ONE build-logic convention
# plugin, not be duplicated across module build files or reconstructed in the
# root `subprojects {}` block. This guard fails if that duplication returns.
set -euo pipefail

# Resolve repo root (this script lives in scripts/android/).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

CONVENTION="android/build-logic/src/main/kotlin/automobile.kotlin-common.gradle.kts"
SETTINGS="android/settings.gradle.kts"
OPTIN_MARKER="opt-in=androidx.compose.material3.ExperimentalMaterial3Api"
KOTLIN_COMPILE_BLOCK="tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# 1. build-logic is an included build and the convention plugin exists.
[ -f "android/build-logic/settings.gradle.kts" ] ||
  fail "android/build-logic is not an included build (missing settings.gradle.kts)"
[ -f "$CONVENTION" ] || fail "missing convention plugin: $CONVENTION"

# 2. The root settings wires the included build.
grep -q 'includeBuild("build-logic")' "$SETTINGS" ||
  fail "$SETTINGS does not includeBuild(\"build-logic\")"

# 3. The shared opt-in list lives in exactly one build file: the convention.
optin_files="$(grep -rl "$OPTIN_MARKER" android --include='*.gradle.kts' | sort || true)"
optin_count="$(printf '%s\n' "$optin_files" | grep -c . || true)"
if [ "$optin_count" -ne 1 ] || [ "$optin_files" != "$CONVENTION" ]; then
  fail "opt-in list must live only in $CONVENTION; found in: ${optin_files:-none}"
fi

# 4. No module build file re-declares a KotlinCompile compiler-options block.
#    The root build.gradle.kts is excluded: it retains an unrelated KotlinCompile
#    use (publication moduleName) that a later item removes.
module_dups="$(grep -rl "$KOTLIN_COMPILE_BLOCK" android --include=build.gradle.kts |
  grep -vE '^android/build\.gradle\.kts$' || true)"
if [ -n "$module_dups" ]; then
  fail "module build files still declare a KotlinCompile block:"$'\n'"$module_dups"
fi

echo "OK: Kotlin-compile convention is centralized in $CONVENTION"
