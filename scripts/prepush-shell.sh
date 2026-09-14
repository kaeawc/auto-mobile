#!/usr/bin/env bash
# Run the fast shell- and BATS-relevant checks for changes about to be pushed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/lib/vcs-diff.sh
# shellcheck disable=SC1091 # Resolved relative to this script's location.
source "${SCRIPT_DIR}/lib/vcs-diff.sh"
DEFAULT_BASE="origin/main"
BASE="${DEFAULT_BASE}"
base_was_explicit=0

usage() {
  cat <<'EOF'
Usage: scripts/prepush-shell.sh [--base <ref>] [--help]

Runs the shell/BATS-relevant fast validation checks for files changed since the
merge-base with origin/main. If origin/main is unavailable, it falls back to
main. An explicitly supplied --base must resolve.
EOF
}

add_check() {
  local candidate="$1"
  local selected
  for selected in ${selected_checks[@]+"${selected_checks[@]}"}; do
    if [[ "${selected}" == "${candidate}" ]]; then
      return 0
    fi
  done
  selected_checks+=("${candidate}")
}

add_bats_file() {
  local candidate="$1"
  local selected
  if [[ ! -f "${candidate}" ]]; then
    return 0
  fi
  for selected in ${bats_files[@]+"${bats_files[@]}"}; do
    if [[ "${selected}" == "${candidate}" ]]; then
      return 0
    fi
  done
  bats_files+=("${candidate}")
}

lfs_filter_for_path() {
  local path="$1"
  local attributes
  attributes="$(git check-attr filter -- "${path}")"
  if [[ "${attributes}" == *": filter: lfs" ]]; then
    printf '%s\n' "true"
  else
    printf '%s\n' "false"
  fi
}

binary_diff_for_path() {
  local base_ref="$1"
  local path="$2"
  local numstat
  numstat="$(git diff --numstat "${base_ref}"...HEAD -- "${path}")"
  if [[ "${numstat}" == -*$'\t'-* ]]; then
    printf '%s\n' "true"
  else
    printf '%s\n' "false"
  fi
}

lexically_normalize_path() {
  local path="$1"
  local segment normalized_path=""
  local -a path_segments=()
  local -a normalized_segments=()
  local IFS='/'

  read -r -a path_segments <<< "${path}"
  for segment in ${path_segments[@]+"${path_segments[@]}"}; do
    case "${segment}" in
      ""|.)
        ;;
      ..)
        if [[ "${#normalized_segments[@]}" -gt 0 ]]; then
          normalized_segments=("${normalized_segments[@]:0:$((${#normalized_segments[@]} - 1))}")
        fi
        ;;
      *)
        normalized_segments+=("${segment}")
        ;;
    esac
  done

  for segment in ${normalized_segments[@]+"${normalized_segments[@]}"}; do
    normalized_path+="/${segment}"
  done
  printf '%s\n' "${normalized_path:-/}"
}

resolved_shellcheck_disable_source_path() {
  local check_script="$1"
  local line source_expr="" resolved_expr unresolved_expr resolved_path
  local check_script_dir check_script_dir_path
  local awaiting_source=0 disable_codes variable assignment_value assignment_inner
  local dots_suffix variable_value
  local bash_source_token="\${BASH_SOURCE[0]}"
  local bash_source_dir_expr="\$(dirname \"\${BASH_SOURCE[0]}\")"
  local project_root_braced="\${PROJECT_ROOT}"
  local project_root_token="\$PROJECT_ROOT"
  local assignment_prefix="\$(cd \"\$(dirname \"\${BASH_SOURCE[0]}\")"
  local assignment_suffix='" && pwd)'
  local -a previous_lines=()
  local -a resolved_variable_names=()
  local -a resolved_variable_values=()
  local idx

  # Bash 5.2+ expands '&' in // replacement operands; concatenation avoids that
  # unsafe behavior without managing patsub_replacement shell-option state.
  replace_literal_all() {
    local haystack="$1" needle="$2" replacement="$3"
    local result="" before remainder
    [[ -n "${needle}" ]] || {
      printf '%s\n' "${haystack}"
      return 0
    }
    while [[ "${haystack}" == *"${needle}"* ]]; do
      before="${haystack%%"${needle}"*}"
      remainder="${haystack#*"${needle}"}"
      result+="${before}${replacement}"
      haystack="${remainder}"
    done
    printf '%s%s\n' "${result}" "${haystack}"
  }

  while IFS= read -r line || [[ -n "${line}" ]]; do
    if [[ "${awaiting_source}" -eq 1 && ! "${line}" =~ ^[[:space:]]*$ ]]; then
      if [[ "${line}" =~ ^[[:space:]]*(source|\.)[[:space:]]+\" ]]; then
        source_expr="${line#*\"}"
        source_expr="${source_expr%\"*}"
        break
      fi
      awaiting_source=0
    fi

    if [[ "${line}" =~ ^[[:space:]]*#[[:space:]]*shellcheck[[:space:]]+disable=([^[:space:]#]+) ]]; then
      disable_codes=",${BASH_REMATCH[1]},"
      if [[ "${disable_codes}" == *",SC1091,"* ]]; then
        awaiting_source=1
      fi
    fi
    previous_lines+=("${line}")
  done < "${check_script}"

  [[ -n "${source_expr:-}" ]] || return 0

  check_script_dir="${check_script%/*}"
  [[ "${check_script_dir}" != "${check_script}" ]] || check_script_dir="."
  check_script_dir_path="$(lexically_normalize_path "${PROJECT_ROOT}/${check_script_dir}")"

  for line in ${previous_lines[@]+"${previous_lines[@]}"}; do
    if [[ "${line}" =~ ^[[:space:]]*([a-zA-Z_][a-zA-Z0-9_]*)=(.*)$ ]]; then
      variable="${BASH_REMATCH[1]}"
      assignment_value="${BASH_REMATCH[2]}"
      if [[ "${assignment_value}" != *"${bash_source_token}"* ]] || [[ "${source_expr}" != *"\$${variable}"* && "${source_expr}" != *"\${${variable}}"* ]]; then
        continue
      fi
      assignment_inner="${assignment_value#\"}"
      assignment_inner="${assignment_inner%\"}"
      if [[ "${assignment_inner}" != "${assignment_prefix}"*"${assignment_suffix}" ]]; then
        continue
      fi
      dots_suffix="${assignment_inner#"${assignment_prefix}"}"
      dots_suffix="${dots_suffix%"${assignment_suffix}"}"
      if [[ ! "${dots_suffix}" =~ ^(/\.\.)*$ ]]; then
        continue
      fi
      variable_value="$(lexically_normalize_path "${check_script_dir_path}${dots_suffix}")"
      resolved_variable_names+=("${variable}")
      resolved_variable_values+=("${variable_value}")
    fi
  done

  unresolved_expr="${source_expr//"${bash_source_dir_expr}"/}"
  unresolved_expr="${unresolved_expr//\$\{PROJECT_ROOT\}/}"
  unresolved_expr="${unresolved_expr//\$PROJECT_ROOT/}"
  resolved_expr="$(replace_literal_all "${source_expr}" "${bash_source_dir_expr}" "${check_script_dir_path}")"
  resolved_expr="$(replace_literal_all "${resolved_expr}" "${project_root_braced}" "${PROJECT_ROOT}")"
  resolved_expr="$(replace_literal_all "${resolved_expr}" "${project_root_token}" "${PROJECT_ROOT}")"
  for idx in "${!resolved_variable_names[@]}"; do
    variable="${resolved_variable_names[$idx]}"
    variable_value="${resolved_variable_values[$idx]}"
    unresolved_expr="${unresolved_expr//\$\{${variable}\}/}"
    unresolved_expr="${unresolved_expr//\$${variable}/}"
    resolved_expr="$(replace_literal_all "${resolved_expr}" "\${${variable}}" "${variable_value}")"
    resolved_expr="$(replace_literal_all "${resolved_expr}" "\$${variable}" "${variable_value}")"
  done
  if [[ "${unresolved_expr}" == *'$'* ]]; then
    printf 'Unable to resolve shellcheck source path in %s: %s\n' "${check_script}" "${source_expr}" >&2
    return 0
  fi

  if [[ "${resolved_expr}" == /* ]]; then
    resolved_path="$(lexically_normalize_path "${resolved_expr}")"
  else
    resolved_path="$(lexically_normalize_path "${PROJECT_ROOT}/${resolved_expr}")"
  fi
  [[ "${resolved_path}" == "${PROJECT_ROOT}/"* ]] || return 0
  printf '%s\n' "${resolved_path#"${PROJECT_ROOT}/"}"
}

load_fast_check_registry() {
  local registry_output registry_status check_name check_script
  set +e
  registry_output="$(./scripts/all_fast_validate_checks.sh --list-checks)"
  registry_status=$?
  set -e
  if [[ "${registry_status}" -ne 0 ]]; then
    echo "Failed to list registered fast validation checks." >&2
    exit "${registry_status}"
  fi

  while IFS=$'\t' read -r check_name check_script; do
    if [[ -n "${check_name}" && -n "${check_script}" ]]; then
      registered_check_names+=("${check_name}")
      registered_check_scripts+=("${check_script}")
    fi
  done <<< "${registry_output}"
}

add_registered_checks_for_script_path() {
  local path="$1"
  local idx check_name check_script directive helper_path
  for idx in "${!registered_check_names[@]}"; do
    check_name="${registered_check_names[$idx]}"
    check_script="${registered_check_scripts[$idx]}"
    if [[ "${path}" == "${check_script}" ]]; then
      add_check "${check_name}"
    fi
    if [[ "${check_script}" != *.sh || ! -f "${check_script}" ]]; then
      continue
    fi
    while IFS= read -r directive; do
      helper_path="${directive#*source=}"
      helper_path="${helper_path%%[[:space:]]*}"
      if [[ "${path}" == "${helper_path}" ]]; then
        add_check "${check_name}"
      fi
    done < <(grep -E '^[[:space:]]*#[[:space:]]*shellcheck[[:space:]]+source=[^[:space:]]+' "${check_script}" || true)
    helper_path="$(resolved_shellcheck_disable_source_path "${check_script}")"
    if [[ "${path}" == "${helper_path}" ]]; then
      add_check "${check_name}"
    fi
  done
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      shift
      if [[ $# -eq 0 ]]; then
        echo "Missing value for --base" >&2
        usage >&2
        exit 1
      fi
      BASE="$1"
      base_was_explicit=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

cd "${PROJECT_ROOT}"

set +e
vcs_base_exists "${BASE}"
base_exists_status=$?
set -e
if [[ "${base_exists_status}" -ne 0 && "${base_was_explicit}" -eq 0 ]]; then
  BASE="main"
  set +e
  vcs_base_exists "${BASE}"
  base_exists_status=$?
  set -e
fi

if [[ "${base_exists_status}" -ne 0 ]]; then
  echo "Base ref '${BASE}' does not resolve to a commit." >&2
  exit 1
fi

set +e
changed_files_output="$(vcs_changed_files_since_merge_base "${BASE}")"
changed_files_status=$?
set -e
if [[ "${changed_files_status}" -ne 0 ]]; then
  echo "Failed to list changed files since merge-base with '${BASE}'." >&2
  exit "${changed_files_status}"
fi

changed_files=()
while IFS= read -r path; do
  if [[ -n "${path}" ]]; then
    changed_files+=("${path}")
  fi
done <<< "${changed_files_output}"

if [[ "${#changed_files[@]}" -eq 0 ]]; then
  echo "No changed files since merge-base with ${BASE}; nothing to validate."
  exit 0
fi

selected_checks=()
bats_files=()
hook_files=()
registered_check_names=()
registered_check_scripts=()
set +e
vcs_uses_jj
is_jj_workspace_status=$?
set -e
has_changed_scripts=0
for path in "${changed_files[@]}"; do
  case "${path}" in
    scripts/*)
      has_changed_scripts=1
      break
      ;;
  esac
done

if [[ "${has_changed_scripts}" -eq 1 ]]; then
  load_fast_check_registry
fi

for path in "${changed_files[@]}"; do
  case "${path}" in
    scripts/*.sh|.githooks/*)
      add_check "shellcheck"
      add_check "shell-portability"
      add_check "shell-sete"
      ;;
  esac

  case "${path}" in
    *.sh)
      add_check "shellcheck"
      ;;
  esac

  case "${path}" in
    .githooks/*)
      if [[ -f "${path}" ]]; then
        hook_files+=("${path}")
      fi
      ;;
  esac

  case "${path}" in
    .claude/commands/*.md|skills/*.md)
      add_check "markdown-bash"
      ;;
  esac

  case "${path}" in
    skills/**|.agents/skills/**|AGENTS.md|.claude-plugin/**)
      add_check "codex-skills"
      add_check "claude-plugin"
      ;;
  esac

  case "${path}" in
    mkdocs.yml|docs/*)
      add_check "mkdocs-nav"
      ;;
  esac

  case "${path}" in
    package.json|bun.lock)
      add_check "runtime-pins"
      add_check "sharp-matrix"
      add_check "bun-version-coherence"
      add_check "dependency-decisions"
      ;;
  esac

  case "${path}" in
    scripts/release/runtime-graph.json)
      add_check "runtime-pins"
      ;;
  esac

  case "${path}" in
    package.json)
      add_check "claude-plugin"
      ;;
  esac

  case "${path}" in
    .github/actions/*.yml|.github/actions/*.yaml|.github/workflows/*.yml|.github/workflows/*.yaml|Dockerfile|scripts/local-dev/lib/deps.sh)
      add_check "bun-version-coherence"
      ;;
  esac

  case "${path}" in
    scripts/*)
      add_check "stdlib-first"
      add_registered_checks_for_script_path "${path}"
      ;;
  esac

  case "${path}" in
    scripts/shellcheck/sete-baseline.txt)
      add_check "shell-sete"
      ;;
    scripts/github/uv.lock|scripts/github/pyproject.toml)
      add_check "github-python-lock"
      ;;
  esac

  case "${path}" in
    *test-plans/*.yaml|*test-plans/*.yml)
      add_check "yaml"
      ;;
  esac

  case "${path}" in
    *.xml)
      add_check "xml"
      ;;
  esac

  case "${path}" in
    .gitattributes|*/.gitattributes)
      add_check "lfs-pointers"
      ;;
  esac

  case "${path}" in
    test/bats/*.bats)
      if [[ -f "${path}" ]]; then
        add_bats_file "${path}"
      fi
      ;;
  esac

  if [[ "${is_jj_workspace_status}" -ne 0 ]]; then
    lfs_filter="$(lfs_filter_for_path "${path}")"
    binary_diff="$(binary_diff_for_path "${BASE}" "${path}")"
    if [[ "${lfs_filter}" == "true" || "${binary_diff}" == "true" ]]; then
      add_check "lfs-pointers"
    fi
  elif [[ "${is_jj_workspace_status}" -eq 0 ]]; then
    add_check "lfs-pointers"
  fi
done

if [[ "${#selected_checks[@]}" -eq 0 && "${#bats_files[@]}" -eq 0 ]]; then
  echo "No shell/BATS-relevant fast validation checks match changed files; nothing to validate."
  exit 0
fi

if [[ "${#selected_checks[@]}" -gt 0 ]]; then
  checks_csv="$(IFS=,; echo "${selected_checks[*]}")"
  echo "Fast validation: ./scripts/all_fast_validate_checks.sh --only ${checks_csv}"
  set +e
  export STDLIB_FIRST_BASE_REF="${BASE}"
  ./scripts/all_fast_validate_checks.sh --only "${checks_csv}"
  fast_validation_status=$?
  set -e
  if [[ "${fast_validation_status}" -ne 0 ]]; then
    echo "Fast validation failed. Re-run: ./scripts/all_fast_validate_checks.sh --only ${checks_csv}" >&2
    exit "${fast_validation_status}"
  fi
fi

for hook_file in ${hook_files[@]+"${hook_files[@]}"}; do
  echo "ShellCheck: shellcheck ${hook_file}"
  set +e
  shellcheck "${hook_file}" >&2
  shellcheck_status=$?
  set -e
  if [[ "${shellcheck_status}" -ne 0 ]]; then
    echo "ShellCheck failed. Re-run: shellcheck ${hook_file}" >&2
    exit "${shellcheck_status}"
  fi
done

for path in "${changed_files[@]}"; do
  case "${path}" in
    scripts/*)
      basename="${path##*/}"
      stem="${basename%.*}"
      while IFS= read -r bats_file; do
        if [[ -n "${bats_file}" && -f "${bats_file}" ]]; then
          add_bats_file "${bats_file}"
        fi
      done < <(grep -l -- "${stem}" test/bats/*.bats || true)
      ;;
  esac
done

if [[ "${#bats_files[@]}" -eq 0 ]]; then
  echo "No targeted BATS files match changed scripts; skipping BATS."
  exit 0
fi

echo "BATS: bats ${bats_files[*]}"
set +e
bats "${bats_files[@]}"
bats_status=$?
set -e
if [[ "${bats_status}" -ne 0 ]]; then
  echo "BATS failed. Re-run: bats ${bats_files[*]}" >&2
  exit "${bats_status}"
fi
