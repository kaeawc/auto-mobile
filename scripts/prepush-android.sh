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

# shellcheck source=scripts/lib/vcs-diff.sh disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib/vcs-diff.sh"

repo_root="$(vcs_root)"
if [[ "$(pwd -P)" != "${repo_root}" ]]; then
  echo "error: run scripts/prepush-android.sh from the repository root" >&2
  exit 2
fi

if [[ -z "${base_ref}" ]]; then
  # shellcheck disable=SC2310 # A false result selects the Git default below.
  if vcs_uses_jj; then
    base_ref="origin/main"
  else
    base_ref="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || printf '%s' origin/main)"
  fi
fi
base_ref="$(vcs_base_ref "${base_ref}")"
# shellcheck disable=SC2310 # A false result is reported as an invalid base.
if ! vcs_base_exists "${base_ref}"; then
  echo "error: base ref does not exist: ${base_ref}" >&2
  exit 2
fi

set +e
android_changes_output="$(vcs_changed_files_since_merge_base "${base_ref}" \
  'android/**' \
  'scripts/android/**' \
  '.github/actions/android-emulator/**' \
  '.github/actions/gradle-task-run/**' \
  'scripts/local-dev/hot-reload.sh' \
  '.github/workflows/android*.yml' \
  '.github/workflows/pull_request.yml')"
android_changes_status=$?
set -e
if [[ "${android_changes_status}" -ne 0 ]]; then
  echo "error: failed to list Android changes since ${base_ref}" >&2
  exit 2
fi

android_changes=()
while IFS= read -r changed_file; do
  [[ -n "${changed_file}" ]] && android_changes+=("${changed_file}")
done <<< "${android_changes_output}"

if [[ "${#android_changes[@]}" -eq 0 ]]; then
  echo "No Android-relevant changes since ${base_ref}; nothing to check."
  exit 0
fi

root_gradle_changed=false
detekt_config_changed=false
for changed_file in "${android_changes[@]}"; do
  case "${changed_file}" in
    android/config/detekt/*)
      detekt_config_changed=true
      ;;
    android/build.gradle.kts|android/settings.gradle.kts|android/gradle.properties|android/gradle/*)
      root_gradle_changed=true
      ;;
    android/**/build.gradle.kts)
      if [[ ! -f "${changed_file}" ]]; then
        root_gradle_changed=true
        echo "Module build script removed: ${changed_file}; running configuration validation."
      fi
      ;;
  esac
done

validate_root_gradle_configuration() {
  echo "==> configuration validation (root Gradle files changed)"
  (cd android && ./gradlew help)
}

run_full_scope_detekt() {
  echo "==> full-scope Detekt (Detekt config changed)"
  (cd android && ./gradlew detektMain detektTest)
}

kotlin_changes=()
while IFS= read -r changed_file; do
  [[ -n "${changed_file}" ]] && kotlin_changes+=("${changed_file}")
done < <(printf '%s\n' "${android_changes[@]+"${android_changes[@]}"}" | grep -E '^android/.*\.(kt|kts)$' || true)
if [[ "${#kotlin_changes[@]}" -eq 0 ]]; then
  if [[ "${detekt_config_changed}" == "true" ]]; then
    run_full_scope_detekt
    if [[ "${root_gradle_changed}" == "true" ]]; then
      validate_root_gradle_configuration
    fi
    echo "No changed Kotlin files; full-scope Detekt ran; ktfmt, compile, and tests are no-ops."
    exit 0
  fi
  if [[ "${root_gradle_changed}" == "true" ]]; then
    validate_root_gradle_configuration
    exit 0
  fi
  echo "No changed Kotlin files; ktfmt, scoped Detekt, compile, and tests are no-ops."
  exit 0
fi

echo "Android pre-push smoke check against ${base_ref}."
echo "Scoped Detekt is a smoke check, not a substitute for the full-tree CI Detekt job."

echo "==> ktfmt"
ONLY_CHANGED_SINCE_SHA="${base_ref}" bash scripts/ktfmt/validate_ktfmt.sh

declare -a modules=()
for changed_file in "${kotlin_changes[@]+"${kotlin_changes[@]}"}"; do
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
  if [[ "${detekt_config_changed}" == "true" ]]; then
    run_full_scope_detekt
    if [[ "${root_gradle_changed}" == "true" ]]; then
      validate_root_gradle_configuration
    fi
    echo "No changed Kotlin modules; full-scope Detekt ran; compile and tests are no-ops."
    exit 0
  fi
  if [[ "${root_gradle_changed}" == "true" ]]; then
    validate_root_gradle_configuration
    exit 0
  fi
  echo "No changed Kotlin modules; scoped Detekt, compile, and tests are no-ops."
  exit 0
fi

if [[ "${root_gradle_changed}" == "true" ]]; then
  validate_root_gradle_configuration
fi

detekt_tasks=()
compile_tasks=()
test_tasks=()
if [[ "${detekt_config_changed}" == "true" ]]; then
  detekt_tasks+=(detektMain detektTest)
fi
for module_path in "${modules[@]+"${modules[@]}"}"; do
  module_dir="android/${module_path#:}"
  module_dir="${module_dir//:/\/}"
  if [[ "${module_path}" == ":build-logic" ]]; then
    # build-logic is a kotlin-dsl-only build with no detekt plugin applied.
    compile_tasks+=("${module_path}:compileKotlin")
  else
    if [[ "${detekt_config_changed}" == "false" ]]; then
      detekt_tasks+=("${module_path}:detekt")
    fi
    if grep -Eq 'alias\(libs\.plugins\.android\.(application|library)\)' "${module_dir}/build.gradle.kts"; then
      compile_tasks+=("${module_path}:compileDebugKotlin")
    else
      compile_tasks+=("${module_path}:compileKotlin")
    fi
  fi
  if [[ -d "${module_dir}/src/test" ]]; then
    test_tasks+=("${module_path}:test")
  fi
done

if [[ "${detekt_config_changed}" == "true" ]]; then
  echo "==> full-scope Detekt (Detekt config changed)"
else
  echo "==> scoped Detekt (${modules[*]})"
fi
(cd android && ./gradlew "${detekt_tasks[@]+"${detekt_tasks[@]}"}")

echo "==> compile (${modules[*]})"
(cd android && ./gradlew "${compile_tasks[@]+"${compile_tasks[@]}"}")

if [[ "${#test_tasks[@]}" -eq 0 ]]; then
  echo "No changed modules have unit-test sources; tests are a no-op."
  exit 0
fi

echo "==> unit tests (${test_tasks[*]})"
(cd android && ./gradlew "${test_tasks[@]}")
