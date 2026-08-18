#!/usr/bin/env bash
#
# Diff primitives for repository validation scripts. Colocated root checkouts
# retain Git behavior; sibling jj workspaces have `.jj` but no `.git`, so use
# jj's working-copy-aware diff there.

vcs_uses_jj() {
  [[ -d ".jj" && ! -e ".git" ]]
}

vcs_base_ref() {
  local requested_base_ref="$1"
  if vcs_uses_jj && [[ "$requested_base_ref" == "origin/main" ]]; then
    printf '%s\n' "main@origin"
    return
  fi
  if vcs_uses_jj && [[ "$requested_base_ref" == "HEAD" ]]; then
    printf '%s\n' "@-"
    return
  fi
  printf '%s\n' "$requested_base_ref"
}

vcs_base_exists() {
  local base_ref
  base_ref="$(vcs_base_ref "$1")"
  if vcs_uses_jj; then
    jj log -r "$base_ref" --no-graph -T '' >/dev/null 2>&1
    return
  fi
  git rev-parse --verify --quiet "${base_ref}^{commit}" >/dev/null
}

vcs_changed_files() {
  local base_ref
  base_ref="$(vcs_base_ref "$1")"
  shift
  if vcs_uses_jj; then
    jj diff --from "$base_ref" --to @ --name-only -- "$@"
    return
  fi
  git diff --name-only "$base_ref" -- "$@"
}

vcs_changed_files_since_merge_base() {
  local base_ref
  base_ref="$(vcs_base_ref "$1")"
  shift
  if vcs_uses_jj; then
    jj diff --from "fork_point(@ | ${base_ref})" --to @ --name-only -- "$@"
    return
  fi
  git diff --name-only "$base_ref"...HEAD -- "$@"
}

vcs_touched_files() {
  if vcs_uses_jj; then
    jj diff --from @- --to @ --name-only -- "$@"
    return
  fi
  {
    git diff --cached --name-only --diff-filter=ACMR
    git diff --name-only --diff-filter=ACMR
  } | sort | uniq
}

vcs_list_files() {
  local revision="${1:-@}"
  if vcs_uses_jj; then
    local files
    files="$(jj file list -r "$revision")" || return
    while IFS= read -r path; do
      [[ -n "$path" ]] && printf '%s\0' "$path"
    done <<< "$files"
    return
  fi
  git ls-files --cached --others --exclude-standard -z
}

vcs_diff() {
  local base_ref
  base_ref="$(vcs_base_ref "$1")"
  shift
  if vcs_uses_jj; then
    jj diff --from "$base_ref" --to @ --git -- "$@"
    return
  fi
  git diff "$base_ref" -- "$@"
}

vcs_diff_since_merge_base() {
  local base_ref
  base_ref="$(vcs_base_ref "$1")"
  shift
  if vcs_uses_jj; then
    jj diff --from "fork_point(@ | ${base_ref})" --to @ --git -- "$@"
    return
  fi
  git diff "$base_ref"...HEAD -- "$@"
}

vcs_file_at_merge_base() {
  local base_ref
  base_ref="$(vcs_base_ref "$1")"
  local file="$2"
  if vcs_uses_jj; then
    jj file show -r "fork_point(@ | ${base_ref})" "$file"
    return
  fi
  git show "$(git merge-base "$base_ref" HEAD):$file"
}
