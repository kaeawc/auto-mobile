#!/usr/bin/env bash
set -euo pipefail

# Fail when a tracked file that .gitattributes routes through Git LFS is
# committed as a full blob instead of an LFS pointer. This happens when a
# commit is created without the LFS clean filter — e.g. from a jj colocated
# checkout (jj bypasses git filters entirely, see jj-vcs/jj#80) or any clone
# with LFS uninstalled — and would permanently bloat history once merged.
#
# Uses git plumbing only: attribute resolution comes from git check-attr and
# blob inspection from git cat-file, so the check needs neither the git-lfs
# binary nor downloaded LFS objects (CI checks out with lfs: false).
#
# Usage: check-lfs-pointers.sh [rev]   (defaults to HEAD)

rev="${1:-HEAD}"
pointer_prefix='version https://git-lfs.github.com/spec/v1'
violations=()

while IFS= read -r -d '' path && IFS= read -r -d '' _attr && IFS= read -r -d '' value; do
  # Only files whose resolved filter attribute is lfs; paths where a later
  # .gitattributes line unsets the filter (-filter) resolve to "unset".
  [[ "$value" == "lfs" ]] || continue

  # Symlinks and gitlinks have no blob content to check.
  size="$(git cat-file -s "$rev:$path" 2>/dev/null)" || continue

  # A canonical LFS pointer is a small text file; git-lfs itself only treats
  # blobs of at most 1024 bytes as pointer candidates.
  if (( size > 1024 )); then
    violations+=("$path (${size}-byte blob, expected an LFS pointer)")
    continue
  fi
  prefix_bytes="$(git cat-file blob "$rev:$path" | head -c "${#pointer_prefix}")"
  if [[ "$prefix_bytes" != "$pointer_prefix" ]]; then
    violations+=("$path (small blob but not an LFS pointer)")
  fi
done < <(git ls-tree -r -z --name-only "$rev" | git check-attr --stdin -z filter)

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
