#!/usr/bin/env bash
# Best-effort Spotlight exclusions for generated output. Sourcing is inert.

spotlight_exclude_dir() {
  local dir
  if [[ "${AUTOMOBILE_SPOTLIGHT_EXCLUDE:-1}" == 0 ]]; then return 0; fi
  if [[ "${AUTOMOBILE_SPOTLIGHT_EXCLUDE_FORCE:-0}" != 1 ]] && [[ "$(uname -s 2> /dev/null || true)" != Darwin ]]; then
    return 0
  fi
  for dir in "$@"; do
    if [[ -d "$dir" && ! -e "$dir/.metadata_never_index" ]]; then
      touch "$dir/.metadata_never_index" > /dev/null 2>&1 || true
    fi
  done
  return 0
}

mkdir_spotlight_excluded() {
  mkdir -p "$@" || return $?
  spotlight_exclude_dir "$@"
}
