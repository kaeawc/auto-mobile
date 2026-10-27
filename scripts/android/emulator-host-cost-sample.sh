#!/usr/bin/env bash
# Host-side cost of one running Android emulator process (#15478, measurement plan in
# docs/design-docs/android-emulator-host-cost.md, section 6). Read-only: it never touches adb or
# the emulator, only `ps` and `footprint` (macOS) or /proc/PID/smaps_rollup (Linux).
#
# Unlike benchmark-emulator-resources.sh it records cumulative CPU time (not the decaying `ps`
# CPU percentage) and unique memory (not RSS, which counts shared pages).
#
# Usage: emulator-host-cost-sample.sh EMULATOR_PID OUTPUT_DIR [SAMPLES=60] [INTERVAL_SECONDS=5]
# Writes OUTPUT_DIR/cost-samples.csv and OUTPUT_DIR/cost-summary.txt.
# Env (tests): COST_UNAME overrides `uname -s`; COST_PROC_ROOT overrides /proc.
set -euo pipefail

# `ps` TIME is [[dd-]hh:]mm:ss[.cc]; print whole and fractional seconds.
cpu_seconds_from_ps_time() {
  awk -v value="$1" 'BEGIN {
    days = 0
    if (index(value, "-") > 0) { split(value, dayParts, "-"); days = dayParts[1]; value = dayParts[2] }
    count = split(value, parts, ":")
    seconds = 0
    for (i = 1; i <= count; i++) seconds = seconds * 60 + parts[i]
    printf "%.2f", days * 86400 + seconds
  }'
}

# `footprint -p PID` prints "Footprint: 1968 KB" (KB, MB or GB).
unique_kib_macos() {
  local line
  line=$(footprint -p "$1" 2>/dev/null | awk '/Footprint:/ {print $(NF-5), $(NF-4); exit}' || true)
  [[ -n $line ]] || return 1
  awk -v amount="${line% *}" -v unit="${line#* }" 'BEGIN {
    factor = (unit == "GB") ? 1048576 : (unit == "MB") ? 1024 : (unit == "KB") ? 1 : 0
    if (factor == 0) exit 1
    printf "%d", amount * factor
  }'
}

# Proportional set size: shared pages are split between their users.
unique_kib_linux() {
  local file="${COST_PROC_ROOT:-/proc}/$1/smaps_rollup"
  [[ -r $file ]] || return 1
  awk '/^Pss:/ {print $2; found = 1; exit} END {if (!found) exit 1}' "$file"
}

unique_kib() {
  case "${COST_UNAME:-$(uname -s)}" in
    Darwin) unique_kib_macos "$1" ;;
    Linux) unique_kib_linux "$1" ;;
    *) return 1 ;;
  esac
}

unique_method() {
  case "${COST_UNAME:-$(uname -s)}" in
    Darwin) echo "footprint (phys footprint)" ;;
    Linux) echo "smaps_rollup Pss" ;;
    *) echo "unsupported" ;;
  esac
}

main() {
  if [[ $# -lt 2 || $# -gt 4 ]]; then
    echo "Usage: $0 EMULATOR_PID OUTPUT_DIR [SAMPLES=60] [INTERVAL_SECONDS=5]" >&2
    return 2
  fi
  local emulator_pid=$1 output_dir=$2 samples=${3:-60} interval=${4:-5}
  [[ $emulator_pid =~ ^[0-9]+$ && $samples =~ ^[1-9][0-9]*$ && $interval =~ ^[1-9][0-9]*$ ]] || return 2
  local command_line
  command_line=$(ps -p "$emulator_pid" -o command= || true)
  [[ $command_line == *qemu-system* ]] || { echo "PID is not an emulator process" >&2; return 2; }
  [[ $(unique_method) != unsupported ]] || { echo "Unsupported host OS" >&2; return 2; }
  mkdir -p "$output_dir"
  printf '%s\n' "$command_line" > "$output_dir/host-command.txt"
  printf 'epoch_seconds,cpu_seconds,unique_kib\n' > "$output_dir/cost-samples.csv"
  local sample ps_time cpu unique status
  for ((sample = 0; sample < samples; sample++)); do
    ps_time=$(ps -p "$emulator_pid" -o time= | tr -d '[:space:]' || true)
    [[ -n $ps_time ]] || { echo "Emulator process exited" >&2; return 1; }
    cpu=$(cpu_seconds_from_ps_time "$ps_time")
    # Not `cmd || handler`: that would disable set -e inside the memory readers.
    set +e
    unique=$(unique_kib "$emulator_pid")
    status=$?
    set -e
    [[ $status -eq 0 ]] || { echo "Could not read unique memory" >&2; return 1; }
    printf '%s,%s,%s\n' "$(date +%s)" "$cpu" "$unique" >> "$output_dir/cost-samples.csv"
    if ((sample + 1 < samples)); then sleep "$interval"; fi
  done
  awk -F, -v method="$(unique_method)" 'NR > 1 {
    if (NR == 2) { firstTime = $1; firstCpu = $2; peak = $3 }
    lastTime = $1; lastCpu = $2; sum += $3; count++
    if ($3 > peak) peak = $3
  } END {
    window = lastTime - firstTime
    delta = lastCpu - firstCpu
    printf "samples=%d\nwindow_seconds=%d\ncpu_seconds_delta=%.2f\n", count, window, delta
    printf "cpu_percent_of_one_core=%.1f\n", (window > 0) ? 100 * delta / window : 0
    printf "unique_kib_avg=%d\nunique_kib_peak=%d\nunique_memory_method=%s\n", sum / count, peak, method
  }' "$output_dir/cost-samples.csv" > "$output_dir/cost-summary.txt"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
