#!/usr/bin/env bats
# bats file_tags=integration

setup() {
  FIX="$(mktemp -d)"
  cat > "$FIX/writer.sh" << 'WRITER'
#!/usr/bin/env bash
# A builtin writer: >2 MiB, with no external producer to obscure PIPESTATUS.
trap 'printf "SIGPIPE\n" > "$PROOF"; exit 141' PIPE
printf '%s\n' "${FIRST:-needle}"
if [[ -n ${ACK:-} ]]; then read -r ack < "$ACK"; fi
printf -v bulk '%2048s' x
for ((i=0; i<1024; i++)); do
  printf '%s\n' "$bulk" || exit 141
done
exit "${WRITER_EXIT:-0}"
WRITER
  export PROOF="$FIX/proof"
}

teardown() { rm -rf "$FIX"; }

@test "quiet grep matches but pipefail fails deterministically after reader closes" {
  mkfifo "$FIX/ack"
  run bash -c '
    set -o pipefail
    ACK="$1/ack" bash "$1/writer.sh" | (
      grep -q needle
      matched=$?
      # Close the last reader before acknowledging: no bulk write can succeed.
      exec 0<&-
      printf "go\n" > "$1/ack"
      exit "$matched"
    )
    result=$? statuses=("${PIPESTATUS[@]}")
    printf "pipeline=%s writer=%s grep=%s\n" "$result" "${statuses[0]}" "${statuses[1]}"
    [[ $result == 141 && ${statuses[0]} == 141 && ${statuses[1]} == 0 ]]
  ' bash "$FIX"
  [ "$status" -eq 0 ]
  [[ "$output" == *"pipeline=141 writer=141 grep=0"* ]]
  [ "$(cat "$PROOF")" = SIGPIPE ]
}

@test "capture drains the same large writer and both match idioms always succeed" {
  run bash -c '
    set -euo pipefail
    for ((i=0; i<3; i++)); do
      value=$(bash "$1/writer.sh")
      [[ ${#value} -gt 1048576 && "$value" == *needle* ]]
      grep -q needle <<< "$value"
    done
  ' bash "$FIX"
  [ "$status" -eq 0 ]
  [ ! -e "$PROOF" ]
}

@test "capture correctly distinguishes successful no-match from writer failure" {
  run bash -c '
    set -euo pipefail
    value=$(FIRST=absent bash "$1/writer.sh")
    [[ "$value" != *needle* ]]
    if grep -q needle <<< "$value"; then exit 1; else [[ $? == 1 ]]; fi
    # Assignment status is the producer status, even when its output matches.
    if value=$(WRITER_EXIT=23 bash "$1/writer.sh"); then
      exit 1
    else
      producer_status=$?
    fi
    [[ $producer_status == 23 && "$value" == *needle* ]]
    printf "producer failure=%s (output still contains needle)\n" "$producer_status"
  ' bash "$FIX"
  [ "$status" -eq 0 ]
  [[ "$output" == *"producer failure=23"* ]]
  [ ! -e "$PROOF" ]
}
