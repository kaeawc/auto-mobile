#!/usr/bin/env bash
# Shared reader for "path | safe|unsafe | reason" tier lists.
integration_tier_paths() {
  local tier_file="$1" requested_tier="$2" line path rest tier
  while IFS= read -r line; do
    [[ -n "$line" && "$line" != \#* ]] || continue
    path="${line%% | *}"
    rest="${line#* | }"
    tier="${rest%% | *}"
    if [[ "$tier" == "$requested_tier" ]]; then
      printf '%s\n' "$path"
    fi
  done < "$tier_file"
}
