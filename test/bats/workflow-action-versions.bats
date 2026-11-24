#!/usr/bin/env bats
#
# Guards #11872: copies of a workflow step drift apart (actions/cache@v4 beside fifteen @v5). An
# action used at more than one major version across .github/ fails here unless it is listed with a
# reason. Remote actions are pinned to commit SHAs with the tag as a trailing `# <tag>` comment, so
# the major comes from that comment (kaeawc/waaagh#359).

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  cd "$REPO_ROOT"
}

# action|majors|reason: exactly these majors may coexist; any other major still fails.
ALLOWED_SPLITS=()

# Prints "action major" for every remote `uses:` under .github/, reading the major from the
# `# <tag>` comment of a SHA pin, or from the ref itself when it is a tag.
tag_pins() {
  grep -rhoE 'uses: [A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[A-Za-z0-9_.-]+( # [A-Za-z0-9_.-]+)?' .github \
    | sed -E 's/^uses: //; s/ # / /' \
    | awk '
        {
          split($1, ref, "@")
          tag = ref[2]
          if (length(tag) == 40 && tag ~ /^[0-9a-f]+$/) {
            if ($2 == "") next
            tag = $2
          }
          split(ref[1], parts, "/")
          action = parts[1] "/" parts[2]
          major = tag
          sub(/^v/, "", major)
          sub(/\..*/, "", major)
          print action, major
        }' \
    | sort -u
}

# Prints every remote `uses:` line under .github/ that is not pinned to a full commit SHA with a
# `# <tag>` comment. The repository requires SHA-pinned actions; the comment keeps the version
# readable and lets Dependabot bump the pin.
unpinned_uses() {
  grep -rnE '^[[:space:]]*(-[[:space:]]*)?uses:[[:space:]]' .github \
    | grep -vE 'uses:[[:space:]]*["'"'"']?(\./|docker://)' \
    | grep -vE 'uses:[[:space:]]*["'"'"']?[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}["'"'"']?[[:space:]]+#[[:space:]]*[A-Za-z0-9_.-]+' \
    || true
}

@test "every remote action is pinned to a commit SHA with its tag as a comment" {
  local unpinned
  unpinned="$(unpinned_uses)"
  if [[ -n "$unpinned" ]]; then
    echo "pin these to a full commit SHA with a trailing '# <tag>' comment:" >&2
    printf '%s\n' "$unpinned" >&2
  fi
  [ -z "$unpinned" ]
}

@test "every action is used at one major version, except the listed splits" {
  local drift unexpected="" line action majors row allowed
  drift="$(tag_pins | awk '{ majors[$1] = majors[$1] " " $2; count[$1]++ }
    END { for (a in count) if (count[a] > 1) print a ":" majors[a] }' | sort)"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    action="${line%%:*}"
    majors="$(tr ' ' '\n' <<<"${line#*:}" | sed '/^$/d' | sort -n | tr '\n' ' ' | sed 's/ $//')"
    allowed=""
    for row in "${ALLOWED_SPLITS[@]}"; do
      if [[ "${row%%|*}" == "$action" ]]; then
        allowed="$(cut -d'|' -f2 <<<"$row")"
      fi
    done
    if [[ "$majors" != "$allowed" ]]; then
      unexpected+="$action: $majors"$'\n'
    fi
  done <<<"$drift"
  if [[ -n "$unexpected" ]]; then
    echo "actions used at more than one major version:" >&2
    printf '%s' "$unexpected" >&2
  fi
  [ -z "$unexpected" ]
}

@test "a listed split still exists" {
  local row action
  for row in "${ALLOWED_SPLITS[@]}"; do
    action="${row%%|*}"
    [ "$(tag_pins | awk -v a="$action" '$1 == a' | wc -l | tr -d ' ')" -gt 1 ]
  done
}
