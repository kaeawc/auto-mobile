#!/usr/bin/env bash
# Fast local Android smoke check. CI still owns the complete Detekt analysis.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/prepush-android.sh [--base-ref <ref>]

Runs fast formatting, scoped Detekt, compilation, and tests for Android Kotlin
modules changed since the merge-base with the default branch.
EOF
}

base_ref="${ANDROID_PREPUSH_BASE_REF:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-ref)
      [[ $# -ge 2 ]] || { echo "error: --base-ref requires a ref" >&2; exit 2; }
      base_ref="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

repo_root="$(git rev-parse --show-toplevel)"
if [[ "${PWD}" != "${repo_root}" ]]; then
  echo "error: run scripts/prepush-android.sh from the repository root" >&2
  exit 2
fi

if [[ -z "${base_ref}" ]]; then
  base_ref="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || printf '%s' origin/main)"
fi
merge_base="$(git merge-base "${base_ref}" HEAD)"

android_changes=()
while IFS= read -r changed_file; do
  [[ -n "${changed_file}" ]] && android_changes+=("${changed_file}")
done < <(
  git diff --name-only "${merge_base}" HEAD -- \
    'android/**' \
    'scripts/android/**' \
    '.github/actions/android-emulator/**' \
    '.github/actions/gradle-task-run/**' \
    'scripts/local-dev/hot-reload.sh' \
    '.github/workflows/android*.yml' \
    '.github/workflows/pull_request.yml'
)

if [[ "${#android_changes[@]}" -eq 0 ]]; then
  echo "No Android-relevant changes since ${merge_base}; nothing to check."
  exit 0
fi

kotlin_changes=()
while IFS= read -r changed_file; do
  [[ -n "${changed_file}" ]] && kotlin_changes+=("${changed_file}")
done < <(printf '%s\n' "${android_changes[@]}" | rg '^android/.*\.(kt|kts)$' || true)
if [[ "${#kotlin_changes[@]}" -eq 0 ]]; then
  echo "No changed Kotlin files; ktfmt, scoped Detekt, compile, and tests are no-ops."
  exit 0
fi

echo "Android pre-push smoke check against ${base_ref} (${merge_base})."
echo "Scoped Detekt is a smoke check, not a substitute for the full-tree CI Detekt job."

echo "==> ktfmt"
ONLY_CHANGED_SINCE_SHA="${merge_base}" bash scripts/ktfmt/validate_ktfmt.sh

declare -a modules=()
for changed_file in "${kotlin_changes[@]}"; do
  module_dir="$(dirname "${changed_file}")"
  while [[ "${module_dir}" != "android" && ! -f "${module_dir}/build.gradle.kts" ]]; do
    module_dir="$(dirname "${module_dir}")"
  done
  if [[ "${module_dir}" == "android" ]]; then
    echo "No Gradle module owns ${changed_file}; module-scoped Detekt, compile, and tests skip it."
    continue
  fi
  module_path=":${module_dir#android/}"
  module_path="${module_path//\//:}"
  modules+=("${module_path}")
done

unique_modules=()
while IFS= read -r module_path; do
  [[ -n "${module_path}" ]] && unique_modules+=("${module_path}")
done < <(printf '%s\n' "${modules[@]+"${modules[@]}"}" | sort -u)
modules=("${unique_modules[@]+"${unique_modules[@]}"}")

if [[ "${#modules[@]}" -eq 0 ]]; then
  echo "No changed Kotlin modules; scoped Detekt, compile, and tests are no-ops."
  exit 0
fi

detekt_tasks=()
compile_tasks=()
test_tasks=()
for module_path in "${modules[@]+"${modules[@]}"}"; do
  module_dir="android/${module_path#:}"
  module_dir="${module_dir//:/\/}"
  detekt_tasks+=("${module_path}:detekt")
  if rg -q 'alias\(libs\.plugins\.android\.(application|library)\)' "${module_dir}/build.gradle.kts"; then
    compile_tasks+=("${module_path}:compileDebugKotlin")
  else
    compile_tasks+=("${module_path}:compileKotlin")
  fi
  if [[ -d "${module_dir}/src/test" ]]; then
    test_tasks+=("${module_path}:test")
  fi
done

echo "==> scoped Detekt (${modules[*]})"
(cd android && ./gradlew "${detekt_tasks[@]+"${detekt_tasks[@]}"}")

echo "==> compile (${modules[*]})"
(cd android && ./gradlew "${compile_tasks[@]+"${compile_tasks[@]}"}")

if [[ "${#test_tasks[@]}" -eq 0 ]]; then
  echo "No changed modules have unit-test sources; tests are a no-op."
  exit 0
fi

echo "==> unit tests (${test_tasks[*]})"
(cd android && ./gradlew "${test_tasks[@]}")
