#!/usr/bin/env bash
# Real Linux procfs bytes only; no fixture synthesis and no privileged container.
set -euo pipefail
out="${1:?usage: capture-proc-fixtures.sh <outdir>}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
cat > "$out/capture.sh" <<'CONTAINER'
#!/bin/sh
set -eu
# PROC_ROOT and SLEEP_CMD allow byte-for-byte evidence tests without live processes.
proc_root=${PROC_ROOT:-/proc}
capture() {
  case_name=$1; pid=$2; expected=${3:-}; launched=${4:-false}
  reason='pid unavailable'
  ready=false
  if test "$launched" = true; then
    n=0
    reason='cmdline empty or still launcher shell after readiness bound'
    while test "$n" -lt 50; do
      # procfs reports size zero even when a read returns bytes.
      if cat "$proc_root/$pid/cmdline" > readiness-cmdline 2>/dev/null &&
        test -s readiness-cmdline && ! cmp -s readiness-cmdline launcher-cmdline; then
        actual=$(sed -n 's/^Name:[[:space:]]*//p' "$proc_root/$pid/status" 2>/dev/null || true)
        if test -z "$expected" || test "$actual" = "$expected"; then ready=true; break; fi
        reason="Name mismatch: expected $expected, got $actual"
      fi
      "${SLEEP_CMD:-sleep}" 0.1
      n=$((n+1))
    done
  else ready=true
  fi
  if test "$ready" = true && test -r "$proc_root/$pid/status" && test -r "$proc_root/$pid/cmdline"; then
    mkdir -p "$case_name"
    cat "$proc_root/$pid/status" > "$case_name/status"
    cat "$proc_root/$pid/cmdline" > "$case_name/cmdline"
    actual=$(sed -n 's/^Name:[[:space:]]*//p' "$case_name/status")
    if test -z "$expected" || test "$actual" = "$expected"; then
      printf '%s: captured (pid %s, Name: %s, cmdline %s bytes)\n' "$case_name" "$pid" "$actual" "$(wc -c < "$case_name/cmdline")" >> manifest.txt
      return
    fi
    reason="Name mismatch: expected $expected, got $actual"
    rm -rf "$case_name"
  fi
  printf '%s: not captured (%s; pid %s)\n' "$case_name" "$reason" "$pid" >> manifest.txt
}
# Offline seam: same capture/readiness code, with a hand-built PROC_ROOT.
if test "${1:-}" = --capture-case; then shift; capture "$@"; exit; fi
mkdir -p /capture
cd /capture
{ cat /etc/os-release; uname -srm; ps --version 2>&1 || busybox 2>&1 || true; } > environment.txt
cat "$proc_root/$$/cmdline" > launcher-cmdline
sleep 60 & normal=$!
capture normal "$normal" sleep true
# exec -a changes argv[0], NOT Linux comm. Some BusyBox versions reject it;
# record not captured rather than manufacture bytes or report the launcher shell.
if command -v bash >/dev/null 2>&1; then
  bash -c 'exec -a "my (proc) x" sleep 60' & unusual=$!
else
  sh -c 'exec -a "my (proc) x" sleep 60' & unusual=$!
fi
capture argv0-spoof "$unusual" sleep true
# Keep the script shell alive: exec sleep would reset comm to sleep.
cat > '/tmp/my (proc) x' <<'SCRIPT'
#!/bin/sh
sleep 60 &
wait "$!"
SCRIPT
chmod +x '/tmp/my (proc) x'
'/tmp/my (proc) x' & comm=$!
capture comm-name "$comm" 'my (proc) x' true
capture pid-1 1
# Some shells reap immediately; scan this parent's children for a real zombie.
sh -c 'sleep 0 & sleep 5' & parent=$!
"${SLEEP_CMD:-sleep}" 1
zombie=''
for status in /proc/[0-9]*/status; do
  if grep -q '^State:.*Z' "$status" && grep -q "^PPid:[[:space:]]*$parent$" "$status"; then
    zombie=${status#/proc/}; zombie=${zombie%/status}; break
  fi
done
if test -n "$zombie"; then capture empty-cmdline "$zombie"; else printf 'empty-cmdline: not captured (shell reaped child; no kernel threads in container)\n' >> manifest.txt; fi
tar -cf - environment.txt manifest.txt ./*/status ./*/cmdline
CONTAINER
{
  printf '# Real procfs capture\n\nDate: %s\n\nRunner kernel: %s\n\n' "$(date -u +%FT%TZ)" "$(uname -srm)"
  printf "When committing, pin attributes:\\n\`\`\`gitattributes\\n**/status text eol=lf\\n**/cmdline binary\\n\`\`\`\\n\\nIn-container commands (verbatim capture.sh):\\n\`\`\`sh\\n"
  cat "$out/capture.sh"
  printf '\n```\n'
  cat <<'CASES'

Cases (raw kernel bytes, not normalized):
- normal: sleep comm (`Name: sleep`) and ordinary sleep argv[0].
- comm-name: a script literally named `my (proc) x`; its shell waits for a
  child sleep so comm keeps spaces/parentheses. `exec sleep` would reset Name.
- argv0-spoof: `exec -a` changes argv[0] to `my (proc) x`; Name stays `sleep`.
  If the shell or BusyBox applet rejects spoofing, the manifest says not captured.
- pid-1: container init, with its actual comm and argv[0].
- empty-cmdline: a real zombie if observable, otherwise explicitly not captured.
CASES
} > "$out/README.md"
for image in alpine:3 debian:stable-slim; do
  slug=${image//[:\/]/-}
  mkdir -p "$out/$slug"
  docker pull "$image" > "$out/$slug/pull.log" 2>&1
  digest="$(docker image inspect --format '{{index .RepoDigests 0}}' "$image" || echo unknown)"
  command=(docker run --rm -i "$image" sh -s)
  {
    printf '\n## %s\nDigest: %s\n\nExact host commands (stdin is capture.sh):\n```bash\n' "$image" "$digest"
    printf 'docker pull %q\n' "$image"
    if [[ $digest == *@sha256:* ]]; then printf 'docker pull %q\n' "$digest"; fi
    printf "docker image inspect --format '{{index .RepoDigests 0}}' %q\n" "$image"
    printf '%q ' "${command[@]}"; printf '< %q > %q\n' "$out/capture.sh" "$out/$slug/capture.tar"
    printf 'tar -xf %q -C %q\n```\n' "$out/$slug/capture.tar" "$out/$slug"
  } >> "$out/README.md"
  "${command[@]}" < "$out/capture.sh" > "$out/$slug/capture.tar"
  tar -xf "$out/$slug/capture.tar" -C "$out/$slug"
  cat "$out/$slug/manifest.txt" >> "$out/README.md"
done
