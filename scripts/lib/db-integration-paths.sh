#!/usr/bin/env bash
# Print yes when a newline-delimited changed-file list touches the DB
# integration boundary, otherwise print no. Paths are relative to the repository root.

db_integration_paths_changed() {
  local path
  while IFS= read -r path; do
    case "$path" in
      src/daemon/* | src/db/* | src/server/* | test/db/*)
        printf 'yes\n'
        return 0
        ;;
    esac
  done
  printf 'no\n'
}
