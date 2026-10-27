#!/usr/bin/env bats
#
# Guards #11872: copies of a workflow step drift apart (actions/cache@v4 beside fifteen @v5). An
# action used at more than one major version across .github/ fails here unless it is listed with a
# reason. Commit-SHA pins are deliberate and skipped.

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  cd "$REPO_ROOT"
}

# action|majors|reason: exactly these majors may coexist; any other major still fails.
ALLOWED_SPLITS=(
  "actions/upload-artifact|4 6 7|build-desktop-conveyor.yml (desktop packaging) is still on v4; gradle-task-run pins v7.0.1 through Dependabot"
  "actions/setup-java|4 5|build-desktop-conveyor.yml (desktop packaging) is still on v4"
)

# Prints "action major" for every tag-pinned `uses:` under .github/.
tag_pins() {
  grep -rhoE 'uses: [A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[A-Za-z0-9_.-]+' .github \
    | sed 's/^uses: //' \
    | awk -F@ '
        length($2) == 40 && $2 ~ /^[0-9a-f]+$/ { next }
        {
          split($1, parts, "/")
          action = parts[1] "/" parts[2]
          major = $2
          sub(/^v/, "", major)
          sub(/\..*/, "", major)
          print action, major
        }' \
    | sort -u
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
