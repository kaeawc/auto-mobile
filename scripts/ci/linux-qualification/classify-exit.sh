#!/usr/bin/env bash
# Pure evidence classifier. Markers contain epoch seconds; kill-sent: "time signal".
set -euo pipefail
# shellcheck source=scripts/ci/linux-qualification/lib.sh disable=SC1091
source "$(dirname "$0")/lib.sh"
dir="${1:?evidence directory}"
outcome=unknown-exit
evidence=()
exit_time=$(cat "$dir/exit-time" 2>/dev/null || printf 0)
shutdown_time=$(cat "$dir/shutdown-intent" 2>/dev/null || printf 0)
kill_time=$(cut -d' ' -f1 "$dir/kill-sent" 2>/dev/null || printf 0)
while IFS= read -r tag; do evidence+=("$tag"); done < <(crash_evidence "$dir")
during_shutdown=false
if (( exit_time > 0 && shutdown_time > 0 && exit_time >= shutdown_time )) && { (( exit_time > shutdown_time )) || [[ "$dir/exit-time" -nt "$dir/shutdown-intent" ]]; }; then during_shutdown=true; fi
# Shutdown must preserve a real SEGV, even when cleanup sent a signal too.
if [[ "$during_shutdown" == true && ${#evidence[@]} -gt 0 ]]; then outcome=crash; evidence+=(during-shutdown)
elif (( exit_time > 0 && kill_time > 0 && exit_time >= kill_time )) && { (( exit_time > kill_time )) || [[ "$dir/exit-time" -nt "$dir/kill-sent" ]]; }; then outcome="kill"; evidence+=(kill-sent)
elif ((${#evidence[@]})); then outcome=crash
elif [[ -f "$dir/harness-error" ]]; then outcome=harness-error
elif [[ -f "$dir/host-unavailable" ]]; then outcome=unexercised
elif [[ "$during_shutdown" == true ]]; then outcome=shutdown; evidence+=(shutdown-intent)
elif (( exit_time > 0 )); then outcome=unknown-exit
elif [[ -f "$dir/load-survived" ]]; then outcome=survived
fi
if [[ -f "$dir/op-hang" ]]; then
  evidence+=(op-hang)
  if [[ "$outcome" == survived || "$outcome" == shutdown ]]; then outcome=op-hang; fi
fi
start=$(cat "$dir/start-time" 2>/dev/null || printf 0)
duration=0
if (( exit_time >= start && start > 0 )); then duration=$((exit_time-start)); fi
jq -n --slurpfile meta "$dir/environment.json" --arg outcome "$outcome" \
  --arg op "$(cat "$dir/op-in-flight" 2>/dev/null || true)" --argjson duration "$duration" \
  --arg frames "$(head -5 "$dir/top-frames.txt" 2>/dev/null || true)" \
  --args '$meta[0] + {outcome:$outcome,time_to_exit_seconds:$duration,op_in_flight:$op,
    evidence:$ARGS.positional,top_frames:($frames|split("\n")|map(select(length>0)))}' ${evidence[@]+"${evidence[@]}"} > "$dir/result.json"
printf '%s\n' "$outcome"
