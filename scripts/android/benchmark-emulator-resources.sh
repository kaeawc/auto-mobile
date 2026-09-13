#!/usr/bin/env bash
# Read-only samples for an explicitly selected emulator and host process.
# RSS includes shared pages; ps CPU percentage semantics depend on the host OS.
set -euo pipefail
if [[ $# -lt 3 || $# -gt 5 ]]; then
  echo "Usage: $0 SERIAL EMULATOR_PID OUTPUT_DIR [SAMPLES=60] [INTERVAL_SECONDS=5]" >&2
  exit 2
fi
serial=$1
emulator_pid=$2
output_dir=$3
samples=${4:-60}
interval=${5:-5}
[[ $serial =~ ^emulator-[0-9]+$ && $emulator_pid =~ ^[0-9]+$ && $samples =~ ^[1-9][0-9]*$ && $interval =~ ^[1-9][0-9]*$ ]] || exit 2
adb_bin=${ADB:-adb}
command_line=$(ps -p "$emulator_pid" -o command=)
[[ $command_line == *qemu-system* ]] || { echo "PID is not an emulator process" >&2; exit 2; }
[[ $command_line == *"-port ${serial#emulator-}"* ]] || { echo "PID/serial port mismatch" >&2; exit 2; }
mkdir -p "$output_dir"
printf '%s\n' "$command_line" > "$output_dir/host-command.txt"
"$adb_bin" -s "$serial" shell getprop > "$output_dir/guest-properties.txt"
"$adb_bin" -s "$serial" shell dumpsys meminfo > "$output_dir/guest-memory-before.txt"
"$adb_bin" -s "$serial" shell dumpsys battery > "$output_dir/guest-battery.txt"
printf 'epoch_seconds,pid,ps_cpu_percent,rss_kib,cpu_time\n' > "$output_dir/host-samples.csv"
for ((sample=0; sample<samples; sample++)); do
  metrics=$(ps -p "$emulator_pid" -o pid=,pcpu=,rss=,time=)
  [[ -n $metrics ]] || { echo "Emulator process exited" >&2; exit 1; }
  printf '%s,%s\n' "$(date +%s)" "$(awk '{printf "%s,%s,%s,%s", $1,$2,$3,$4}' <<< "$metrics")" >> "$output_dir/host-samples.csv"
  if ((sample + 1 < samples)); then sleep "$interval"; fi
done
"$adb_bin" -s "$serial" shell dumpsys meminfo > "$output_dir/guest-memory-after.txt"
"$adb_bin" -s "$serial" shell dumpsys cpuinfo > "$output_dir/guest-cpu-after.txt"
"$adb_bin" -s "$serial" shell dumpsys activity processes > "$output_dir/guest-processes-after.txt"
