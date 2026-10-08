#!/usr/bin/env bash
# Copy macOS crash reports for the iOS screen-capture helper into a CI artifact
# directory, so a helper that dies mid-stream (for example with SIGTRAP, #7604)
# leaves its faulting frame behind instead of only an exit signal in a log line.
#
# Usage: collect-helper-crash-reports.sh <destination-dir>
#
# AUTOMOBILE_CRASH_REPORT_DIRS overrides the colon-separated report directories
# (default: the user and system DiagnosticReports folders). Always exits 0: a
# missing report is the common case and must not fail the job's diagnostics.
set -uo pipefail

readonly process_name="screen-capture-helper"

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "usage: $0 <destination-dir>" >&2
  exit 2
fi
readonly destination="$1/crash-reports"

report_dirs="${AUTOMOBILE_CRASH_REPORT_DIRS:-${HOME}/Library/Logs/DiagnosticReports:/Library/Logs/DiagnosticReports}"
IFS=':' read -r -a search_dirs <<< "${report_dirs}"

copied=0
for dir in "${search_dirs[@]}"; do
  [[ -n "${dir}" && -d "${dir}" ]] || continue
  for report in "${dir}/${process_name}"*.ips "${dir}/${process_name}"*.crash; do
    [[ -f "${report}" ]] || continue
    if ! mkdir -p "${destination}" || ! cp "${report}" "${destination}/"; then
      echo "warn: could not copy ${report}" >&2
      continue
    fi
    copied=$((copied + 1))
    # The .ips body records e.g. {"type":"EXC_BREAKPOINT","signal":"SIGTRAP"}.
    exception="$(grep -o '"exception" : {[^}]*}' "${report}" | head -n 1 || true)"
    echo "${process_name} crash report: $(basename "${report}") ${exception}"
  done
done

if [[ "${copied}" -eq 0 ]]; then
  echo "No ${process_name} crash reports found."
else
  echo "Copied ${copied} ${process_name} crash report(s) to ${destination}."
fi
exit 0
