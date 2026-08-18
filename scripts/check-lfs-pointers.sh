#!/usr/bin/env bash
set -euo pipefail

# Fail when a tracked file that .gitattributes routes through Git LFS is
# committed as a full blob instead of an LFS pointer. This happens when a
# commit is created without the LFS clean filter — e.g. from a jj colocated
# checkout (jj bypasses git filters entirely, see jj-vcs/jj#80) or any clone
# with LFS uninstalled — and would permanently bloat history once merged.
#
# Uses Git plumbing in Git worktrees. Pure jj workspaces materialize the
# versioned `.gitattributes` files in a temporary Git repository for attribute
# resolution, then inspect file contents through `jj file show`; neither mode
# needs the git-lfs binary or downloaded LFS objects (CI checks out with
# lfs: false).
#
# Usage: check-lfs-pointers.sh [rev]   (defaults to HEAD)

rev="${1:-HEAD}"
pointer_prefix='version https://git-lfs.github.com/spec/v1'
violations=()

check_pointer() {
  local path="$1"
  local size="$2"
  local prefix_bytes="$3"
  # Only files whose resolved filter attribute is lfs; paths where a later
  # .gitattributes line unsets the filter (-filter) resolve to "unset".
  [[ "$size" =~ ^[0-9]+$ ]] || return
  # A canonical LFS pointer is a small text file; git-lfs itself only treats
  # blobs of at most 1024 bytes as pointer candidates.
  if (( size > 1024 )); then
    violations+=("$path (${size}-byte blob, expected an LFS pointer)")
    return
  fi
  if [[ "$prefix_bytes" != "$pointer_prefix" ]]; then
    violations+=("$path (small blob but not an LFS pointer)")
  fi
}

check_git_revision() {
  while IFS= read -r -d '' path && IFS= read -r -d '' _attr && IFS= read -r -d '' value; do
    [[ "$value" == "lfs" ]] || continue
    # Symlinks and gitlinks have no blob content to check.
    size="$(git cat-file -s "$rev:$path" 2>/dev/null)" || continue
    prefix_bytes="$(git cat-file blob "$rev:$path" | head -c "${#pointer_prefix}")"
    check_pointer "$path" "$size" "$prefix_bytes"
  done < <(git ls-tree -r -z --name-only "$rev" | git check-attr --stdin -z filter)
}

check_jj_revision() {
  local jj_rev="${1:-@}"
  local attrs_input attributes_output blob path _attr value size prefix_bytes
  temp_dir="$(mktemp -d)"
  attrs_input="$temp_dir/paths"
  attributes_output="$temp_dir/attributes"
  blob="$temp_dir/blob"
  trap 'rm -rf "$temp_dir"' EXIT

  git -C "$temp_dir" init -q
  while IFS= read -r path; do
    mkdir -p "$temp_dir/$(dirname "$path")"
    jj file show -r "$jj_rev" "$path" > "$temp_dir/$path"
  done < <(jj file list -r "$jj_rev" | rg '(^|/)\.gitattributes$')

  vcs_list_files "$jj_rev" > "$attrs_input"
  git -C "$temp_dir" check-attr --stdin -z filter < "$attrs_input" > "$attributes_output"
  while IFS= read -r -d '' path && IFS= read -r -d '' _attr && IFS= read -r -d '' value; do
    [[ "$value" == "lfs" ]] || continue
    jj file show -r "$jj_rev" "$path" > "$blob"
    size="$(wc -c < "$blob" | tr -d '[:space:]')"
    prefix_bytes="$(head -c "${#pointer_prefix}" "$blob")"
    check_pointer "$path" "$size" "$prefix_bytes"
  done < "$attributes_output"
}

# shellcheck disable=SC1091 # Resolved relative to this script's location.
source "$(dirname "${BASH_SOURCE[0]}")/lib/vcs-diff.sh"
if vcs_uses_jj; then
  rev="${1:-@}"
  check_jj_revision "$rev"
else
  check_git_revision
fi

if ((${#violations[@]})); then
  {
    printf '%s\n' "Files matched by an LFS pattern in .gitattributes are committed as full blobs:"
    printf '  %s\n' "${violations[@]}"
    printf '%s\n' ""
    printf '%s\n' "This usually means the commit was created without the LFS clean filter"
    printf '%s\n' "(jj colocated checkout, or a clone with LFS smudge disabled). Re-add the"
    printf '%s\n' "file from an LFS-enabled git clone, or exempt it in .gitattributes if it"
    printf '%s\n' "belongs in git directly."
  } >&2
  exit 1
fi

printf '%s\n' "All LFS-routed files at $rev are pointers."
