#!/usr/bin/env bash
# Offline aggregation, including missing matrix artifacts; never depends on job success.
set -euo pipefail
root="${1:?artifact directory}"
mkdir -p "$root"
shopt -s nullglob
files=("$root"/*/result.json)
if ((${#files[@]})); then jq -s . "${files[@]}" > "$root/results.json"; else printf '[]\n' > "$root/results.json"; fi
jq '
  . as $results |
  ["swangle","swiftshader_indirect","host","angle_indirect"] as $gpus |
  ["automobile","raw-adb-control","heartbeat-only"] as $workloads |
  [$gpus[] as $g | $workloads[] as $w | "\($g)-\($w)" |
    select(. as $cell | $results | all(.cell != $cell)) |
    {cell:.,outcome:"no-result",reason:"cell killed or timed out"}] + $results |
  {passes:[.[]|select((.outcome=="survived" or .outcome=="shutdown") and
      .cycles_completed==.cycles_planned and (.heartbeat_failed // false | not))|.cell],
   failures:[.[]|select(.outcome!="unexercised" and .outcome!="no-result" and
      ((.outcome!="survived" and .outcome!="shutdown") or .cycles_completed!=.cycles_planned or .heartbeat_failed==true))|.cell],
   no_result:[.[]|select(.outcome=="no-result")|.cell],
   unexercised:[.[]|select(.outcome=="unexercised")|.cell],classified_exits:.}
' "$root/results.json" > "$root/summary.json"
{
  printf '# Linux emulator qualification\n\n'
  for list in passes failures unexercised no_result; do
    if [[ $list == no_result ]]; then printf '## NO RESULT (cell killed or timed out)\n\n'; else printf '## %s\n\n' "$list"; fi
    jq -r --arg list "$list" 'if (.[$list]|length)==0 then "- none" else .[$list][]|"- "+. end' "$root/summary.json"
    printf '\n'
  done
  printf '## Classified exits\n\n| Cell | Outcome | Completed/planned | Exit seconds | Op | Top frames |\n|---|---|---|---|---|---|\n'
  jq -r '.classified_exits[] | [.cell,.outcome,"\(.cycles_completed // 0)/\(.cycles_planned // 0)",(.time_to_exit_seconds // 0|tostring),(.op_in_flight // ""),((.top_frames // [])|join("; "))] | map(gsub("[|\n]";" ")) | "| "+join(" | ")+" |"' "$root/summary.json"
  cat <<'FOOTER'

A pass requires every planned cycle and every heartbeat on time. Even 10/10
crash-free cycles only bound the crash rate to about 26% at 95% confidence.
The default one cycle is exploratory evidence, not a stability certification.

| Observation | Decision |
|---|---|
| Only swangle fails | Hypothesis 1: document swiftshader_indirect as the supported Linux config; file upstream with the backtrace. |
| C also crashes under the same config | Emulator/renderer cause independent of AutoMobile. |
| W crashes but C and H do not | AutoMobile input/observe pattern implicated; bisect by operation kind. |
| H crashes | Emulator unstable at rest. |
| Everything passes | Not reproduced; list all UNEXERCISED and NO RESULT cells above. |

W = automobile, C = raw-adb-control, H = heartbeat-only. Unknown exits,
injected kills, incomplete cycles, and harness errors are failures of qualification;
only real crashes count toward crash incidence. UNEXERCISED and NO RESULT are
listed separately; neither supplies crash-free evidence.
FOOTER
} > "$root/summary.md"
