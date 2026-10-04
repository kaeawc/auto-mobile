#!/usr/bin/env bats
# bats file_tags=integration
# shellcheck disable=SC2016 # Fixture source must retain literal expansions.

setup() {
  ABS="$(pwd)/scripts/shellcheck/validate_shell_pipefail_grepq.sh"
  FIX="$(mktemp -d)"
  mkdir "$FIX/scripts"
  export SHELL_PIPEFAIL_GREPQ_ROOT="$FIX"
  export SHELL_PIPEFAIL_GREPQ_BASELINE="$FIX/baseline"
  : > "$FIX/baseline"
}
teardown() { rm -rf "$FIX"; }
write() { printf '#!/usr/bin/env bash\n%s\n' "$1" > "$FIX/scripts/example.sh"; }

@test "clean script passes; here-string and fully draining grep are safe" {
  write 'set -euo pipefail
v=$(producer)
grep -q needle <<< "$v"
producer | grep needle > /dev/null'
  run bash "$ABS"
  [ "$status" -eq 0 ]
}

@test "new violation fails naming file and line" {
  write 'set -o pipefail
if producer | grep -q needle; then :; fi'
  run bash "$ABS"
  [ "$status" -eq 1 ]
  [[ "$output" == *"scripts/example.sh:3: quiet grep pipeline under pipefail"* ]]
}

@test "all quiet flags, split pipelines, pipe-and-stderr and split set flags" {
  for flag in -q -qE -Eq -qi -qF -xq --quiet --silent; do
    write "set -E -e -u -o pipefail
producer |
  grep $flag needle
producer |& grep $flag needle"
    run bash "$ABS"
    [ "$status" -eq 1 ]
    [[ "$output" == *"example.sh:4:"* && "$output" == *"example.sh:5:"* ]]
  done
}

@test "literal patterns containing quiet option text are not flags" {
  write 'set -euo pipefail
producer | grep -- -q
producer | grep -e "-q"
producer | grep --regexp "--quiet"'
  run bash "$ABS"
  [ "$status" -eq 0 ]
}

@test "no pipefail and pipefail mentioned only in prose are ignored" {
  write 'set -eu
# set -o pipefail
echo "set -euo pipefail"
producer | grep -q needle'
  run bash "$ABS"
  [ "$status" -eq 0 ]
}

@test "comments, quoted prose and literal heredocs cannot create pipelines" {
  write 'set -Eeuo pipefail
# producer | grep -q needle
printf "%s" "producer | grep -q needle"
cat <<TEXT
producer | grep -q needle
TEXT'
  run bash "$ABS"
  [ "$status" -eq 0 ]
}

@test "command substitutions remain executable code" {
  write 'set -euo pipefail
v="$(producer | grep -q needle)"'
  run bash "$ABS"
  [ "$status" -eq 1 ]
}

@test "same-line and preceding-line allow markers require a reason" {
  write 'set -euo pipefail
producer | grep -q needle # pipefail-grep-q: allow tiny builtin output
# pipefail-grep-q: allow bounded numeric input
producer | grep -Eq needle'
  run bash "$ABS"
  [ "$status" -eq 0 ]
  write 'set -euo pipefail
producer | grep -q needle # pipefail-grep-q: allow   '
  run bash "$ABS"
  [ "$status" -eq 1 ]
  [[ "$output" == *"example.sh:3: allow marker requires a reason"* ]]
}

@test "baseline equality passes, growth and new files fail" {
  write 'set -euo pipefail
producer | grep -q needle'
  printf '1 scripts/example.sh\n' > "$FIX/baseline"
  run bash "$ABS"
  [ "$status" -eq 0 ]
  printf 'producer | grep -q another\n' >> "$FIX/scripts/example.sh"
  run bash "$ABS"
  [ "$status" -eq 1 ]
  [[ "$output" == *"refusing baseline growth"* ]]
  write 'set -euo pipefail
producer | grep -q needle'
  cp "$FIX/scripts/example.sh" "$FIX/scripts/new.sh"
  run bash "$ABS"
  [ "$status" -eq 1 ]
  [[ "$output" == *"scripts/new.sh:3:"* ]]
}

@test "shrink reports a note and update prunes; growth needs explicit allow-grow" {
  write 'set -euo pipefail
producer | grep -q needle'
  printf '2 scripts/example.sh\n' > "$FIX/baseline"
  run bash "$ABS"
  [ "$status" -eq 0 ]
  [[ "$output" == *"run --update to shrink"* ]]
  run bash "$ABS" --update
  [ "$status" -eq 0 ]
  [[ "$(cat "$FIX/baseline")" == *"1 scripts/example.sh"* ]]
  printf 'producer | grep -q another\n' >> "$FIX/scripts/example.sh"
  run bash "$ABS" --update
  [ "$status" -eq 1 ]
  run bash "$ABS" --update --allow-grow
  [ "$status" -eq 0 ]
  [[ "$(cat "$FIX/baseline")" == *"2 scripts/example.sh"* ]]
}

@test "update cannot move counts to a new file even when the total shrinks" {
  write 'set -euo pipefail
producer | grep -q needle'
  printf '5 scripts/old.sh\n' > "$FIX/baseline"
  run bash "$ABS" --update
  [ "$status" -eq 1 ]
}

@test "syntax errors fail closed" {
  write 'set -o pipefail
if'
  run bash "$ABS"
  [ "$status" -eq 2 ]
  [[ "$output" == *"Scanner failed"* ]]
}

@test "real scripts tree passes the committed baseline" {
  unset SHELL_PIPEFAIL_GREPQ_ROOT SHELL_PIPEFAIL_GREPQ_BASELINE
  run bash "$ABS"
  [ "$status" -eq 0 ]
}
