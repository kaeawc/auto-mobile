#!/usr/bin/env bats
setup() {
  mkdir -p "$BATS_TEST_TMPDIR/bin" "$BATS_TEST_TMPDIR/canned/normal"
  export CALLS="$BATS_TEST_TMPDIR/calls" CANNED="$BATS_TEST_TMPDIR/canned"
  export PATH="$BATS_TEST_TMPDIR/bin:$PATH"
  printf 'Name:\tsleep\n' > "$CANNED/normal/status"
  printf 'sleep\00060\000' > "$CANNED/normal/cmdline"
  printf 'stub environment\n' > "$CANNED/environment.txt"
  printf 'normal: captured (pid 42)\nempty-cmdline: not captured (shell reaped child)\n' > "$CANNED/manifest.txt"
  cat > "$BATS_TEST_TMPDIR/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >> "$CALLS"; printf '\n' >> "$CALLS"
case "$1" in
  pull) exit 0;;
  image) printf '%s@sha256:abc123\n' "${@: -1}";;
  run) cat > "$CANNED/stdin.sh"; tar -cf - -C "$CANNED" normal environment.txt manifest.txt;;
  *) exit 1;;
esac
STUB
  chmod +x "$BATS_TEST_TMPDIR/bin/docker"
}
@test "capture preserves bytes and documents exact host/container commands and digests" {
  out="$BATS_TEST_TMPDIR/output"
  run bash "$BATS_TEST_DIRNAME/../../scripts/ci/linux-qualification/capture-proc-fixtures.sh" "$out"
  [ "$status" -eq 0 ]
  for image in alpine:3 debian:stable-slim; do
    grep -F "$image@sha256:abc123" "$out/README.md"
    grep -F "docker pull $image@sha256:abc123" "$out/README.md"
    grep -F "docker run --rm -i $image sh -s < $out/capture.sh" "$out/README.md"
    slug=${image//:/-}
    cmp "$CANNED/normal/cmdline" "$out/$slug/normal/cmdline"
    cmp "$CANNED/normal/status" "$out/$slug/normal/status"
  done
  grep -F "docker image inspect --format '{{index .RepoDigests 0}}'" "$out/README.md"
  grep -F 'empty-cmdline: not captured' "$out/README.md"
  grep -F '**/status text eol=lf' "$out/README.md"
  grep -F '**/cmdline binary' "$out/README.md"
  grep -F 'Runner kernel:' "$out/README.md"
  cmp "$CANNED/stdin.sh" "$out/capture.sh"
  grep -F 'cat "$proc_root/$pid/cmdline"' "$out/README.md"
  ! grep -q -- --privileged "$CALLS"
  [ ! -e "$out/alpine-3/empty-cmdline/cmdline" ]
}
prepare_capture_case() {
  out="$BATS_TEST_TMPDIR/output"
  bash "$BATS_TEST_DIRNAME/../../scripts/ci/linux-qualification/capture-proc-fixtures.sh" "$out"
  export PROC_ROOT="$BATS_TEST_TMPDIR/proc" SLEEP_CMD=true
  mkdir -p "$PROC_ROOT/42" "$BATS_TEST_TMPDIR/case"
  cd "$BATS_TEST_TMPDIR/case"
  printf 'launcher\000sh\000' > launcher-cmdline
}
@test "readiness rejects empty and inherited launcher cmdline without sleeping" {
  prepare_capture_case
  printf 'Name:\tsleep\n' > "$PROC_ROOT/42/status"
  for state in empty launcher; do
    if [[ $state == empty ]]; then : > "$PROC_ROOT/42/cmdline"; else cp launcher-cmdline "$PROC_ROOT/42/cmdline"; fi
    run bash "$out/capture.sh" --capture-case "$state" 42 sleep true
    [ "$status" -eq 0 ]; [ ! -d "$state" ]
    grep -F "$state: not captured (cmdline empty or still launcher shell after readiness bound" manifest.txt
  done
}
@test "normal comm-name and argv spoof preserve hand-built proc bytes and validate Name" {
  prepare_capture_case
  for case_name in normal comm-name argv0-spoof; do
    name=sleep
    if [[ $case_name == comm-name ]]; then name='my (proc) x'; fi
    printf 'Name:\t%s\nState:\tS (sleeping)\n' "$name" > "$PROC_ROOT/42/status"
    case "$case_name" in
      normal) printf 'sleep\00060\000' > "$PROC_ROOT/42/cmdline";;
      comm-name) printf '/bin/sh\000/tmp/my (proc) x\000' > "$PROC_ROOT/42/cmdline";;
      argv0-spoof) printf 'my (proc) x\00060\000' > "$PROC_ROOT/42/cmdline";;
    esac
    run bash "$out/capture.sh" --capture-case "$case_name" 42 "$name" true
    [ "$status" -eq 0 ]
    cmp "$PROC_ROOT/42/status" "$case_name/status"
    cmp "$PROC_ROOT/42/cmdline" "$case_name/cmdline"
    grep -F "$case_name: captured" manifest.txt
  done
  grep -F 'Name stays `sleep`' "$out/README.md"
  grep -F 'child sleep so comm keeps spaces/parentheses' "$out/README.md"
}
@test "wrong comm is not captured with an explicit mismatch reason" {
  prepare_capture_case
  echo 'Name: busybox' > "$PROC_ROOT/42/status"
  printf 'sleep\00060\000' > "$PROC_ROOT/42/cmdline"
  run bash "$out/capture.sh" --capture-case comm-name 42 'my (proc) x' true
  [ "$status" -eq 0 ]; [ ! -d comm-name ]
  grep -F 'Name mismatch: expected my (proc) x, got busybox' manifest.txt
}
@test "digest inspection failure still captures and records unknown" {
  # Keep the same fake Docker transport; only inspection is made to fail.
  mv "$BATS_TEST_TMPDIR/bin/docker" "$BATS_TEST_TMPDIR/bin/docker-original"
  cat > "$BATS_TEST_TMPDIR/bin/docker" <<'STUB'
#!/usr/bin/env bash
if [[ $1 == image ]]; then exit 1; fi
exec "${0%/*}/docker-original" "$@"
STUB
  chmod +x "$BATS_TEST_TMPDIR/bin/docker"
  out="$BATS_TEST_TMPDIR/output"
  run bash "$BATS_TEST_DIRNAME/../../scripts/ci/linux-qualification/capture-proc-fixtures.sh" "$out"
  [ "$status" -eq 0 ]
  grep -F 'Digest: unknown' "$out/README.md"
  ! grep -F 'docker pull unknown' "$out/README.md"
}
@test "launch readiness polls through inherited and empty bytes before the exec result" {
  prepare_capture_case
  printf 'Name:\tsleep\n' > "$PROC_ROOT/42/status"
  printf 'sleep\00060\000' > "$PROC_ROOT/42/cmdline"
  export READ_COUNT="$BATS_TEST_TMPDIR/reads" REAL_CAT
  REAL_CAT=$(command -v cat)
  echo 0 > "$READ_COUNT"
  cat > "$BATS_TEST_TMPDIR/bin/cat" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "$PROC_ROOT/42/cmdline" ]]; then
  n=$("$REAL_CAT" "$READ_COUNT"); echo "$((n+1))" > "$READ_COUNT"
  case "$n" in
    0) "$REAL_CAT" launcher-cmdline; exit;;
    1) exit;;
  esac
fi
exec "$REAL_CAT" "$@"
STUB
  chmod +x "$BATS_TEST_TMPDIR/bin/cat"
  run bash "$out/capture.sh" --capture-case normal 42 sleep true
  [ "$status" -eq 0 ]
  [ "$(cat "$READ_COUNT")" = 4 ]
  cmp "$PROC_ROOT/42/cmdline" normal/cmdline
  grep -F 'normal: captured' manifest.txt
}
