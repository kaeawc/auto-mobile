#!/usr/bin/env bash
# Record-and-block census; deliberately separate from the full unit runner.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_ROOT}"
# shellcheck source=scripts/ios/run_with_timeout.sh
# shellcheck disable=SC1091
source "${PROJECT_ROOT}/scripts/ios/run_with_timeout.sh"

usage() {
  cat <<'USAGE'
Usage: scripts/prune-unit-test-device-spawn-allowlist.sh [options]
  --update             Rewrite the allow-list (only shrink by default).
  --allow-grow         With --update, discover all unit files for initial census.
  --repeat N           Sequential passes, unioned; default 2.
  --batch-size N       Files per process, 1..20; default 20.
  --batch-log-dir DIR  Keep batch logs/status/counts here (a unique run subdir).
                       Env: AUTOMOBILE_SPAWN_GUARD_BATCH_LOG_DIR; default scratch/.
  --file-list FILE     Scan only these repo-relative unit paths; preserve unscanned entries.
  --dry-run            Print selection and settings without running tests or updating.
  --help               Show this help.
Default: check listed files, report shrinkable entries and exit 1 if any exist.
Each batch uses bun test --isolate --timeout 20000, bounded at 300 seconds.
Failed/timed-out batches are retried one file per process, never concurrently.
No test-ts.sh or preload-injecting environment variables are used.
USAGE
}

update=0
allow_grow=0
dry_run=0
repeat=2
batch_size=20
file_list=""
batch_log_dir="${AUTOMOBILE_SPAWN_GUARD_BATCH_LOG_DIR:-scratch/unit-test-device-spawn-census}"
allowlist="scripts/unit-test-device-spawn-allowlist.txt"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --update) update=1; shift ;;
    --allow-grow) allow_grow=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --repeat|--batch-size|--batch-log-dir|--file-list)
      option="$1"
      [[ $# -ge 2 && -n "$2" ]] || { echo "Missing value for ${option}" >&2; exit 2; }
      case "${option}" in
        --repeat) repeat="$2" ;;
        --batch-size) batch_size="$2" ;;
        --batch-log-dir) batch_log_dir="$2" ;;
        --file-list) file_list="$2" ;;
      esac
      shift 2
      ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ "${repeat}" =~ ^[1-9][0-9]*$ ]] || { echo "--repeat must be positive" >&2; exit 2; }
[[ "${batch_size}" =~ ^([1-9]|1[0-9]|20)$ ]] || { echo "--batch-size must be 1..20" >&2; exit 2; }
[[ "${allow_grow}" -eq 0 || "${update}" -eq 1 ]] || { echo "--allow-grow requires --update" >&2; exit 2; }
host_os="$(uname -s)"
if [[ "${host_os}" == *MINGW* || "${host_os}" == *MSYS* || "${host_os}" == *CYGWIN* ]]; then
  echo "Census unavailable on Windows: the guard cannot attribute non-isolated files." >&2
  exit 2
fi

files=()
if [[ -n "${file_list}" ]]; then
  [[ -f "${file_list}" ]] || { echo "File list not found: ${file_list}" >&2; exit 2; }
  selection="$(cat "${file_list}")"
elif [[ "${allow_grow}" -eq 1 ]]; then
  selection="$(find test -name '*.test.ts' ! -name '*.integration.test.ts' ! -path 'test/stress/*')"
else
  selection="$(sed '/^#/d' "${allowlist}")"
fi
while IFS= read -r file; do
  [[ -n "${file}" && "${file}" != \#* ]] || continue
  case "${file}" in
    test/stress/*|*.integration.test.ts|*\\*|*/../*|*/./*|*//*|*$'\t'*)
      echo "Not a repo-relative unit file: ${file}" >&2; exit 2 ;;
    test/*.test.ts) ;;
    *) echo "Not a repo-relative unit file: ${file}" >&2; exit 2 ;;
  esac
  [[ -f "${file}" ]] || { echo "Unit file not found: ${file}" >&2; exit 2; }
  files+=("${file}")
done < <(printf '%s\n' "${selection}" | LC_ALL=C sort -u)
printf 'Selected %s files; %s sequential passes; batch size %s; timeout 300s.\n' "${#files[@]}" "${repeat}" "${batch_size}"
if [[ "${dry_run}" -eq 1 ]]; then
  printf '%s\n' ${files[@]+"${files[@]}"}
  exit 0
fi

mkdir -p "${batch_log_dir}"
run_dir="$(mktemp -d "${batch_log_dir}/run.XXXXXX")"
run_dir="$(cd "${run_dir}" && pwd)"
census_file="${run_dir}/census.tsv"
records="${run_dir}/records.tsv"
: > "${records}"
trap 'rm -f "${census_file}"' EXIT
run_index=0
uncertain=()

run_batch() {
  local label="$1" batch_status=0
  shift
  run_index=$((run_index + 1))
  local prefix="${run_dir}/${run_index}-${label}"
  printf '%s\n' "$@" > "${prefix}.files"
  : > "${census_file}"
  set +e
  run_with_timeout 300 env AUTOMOBILE_SPAWN_GUARD_CENSUS_FILE="${census_file}" \
    bun test --isolate --timeout 20000 "$@" > "${prefix}.log" 2>&1
  batch_status=$?
  set -e
  cat "${census_file}" >> "${records}"
  printf '%s\n' "${batch_status}" > "${prefix}.status"
  printf '%s: %s files, exit %s\n' "${label}" "$#" "${batch_status}"
  return "${batch_status}"
}

for ((pass=1; pass<=repeat; pass++)); do
  for ((offset=0; offset<${#files[@]}; offset+=batch_size)); do
    batch=("${files[@]:offset:batch_size}")
    set +e
    run_batch "pass-${pass}-batch-${offset}" "${batch[@]}"
    batch_rc=$?
    set -e
    if [[ "${batch_rc}" -ne 0 ]]; then
      for file in "${batch[@]}"; do
        set +e
        run_batch "pass-${pass}-single" "${file}"
        single_rc=$?
        set -e
        if [[ "${single_rc}" -ne 0 ]]; then
          # A recorded blocked hit proves this file is an offender even if its
          # test expects a successful launch. Other failures cannot prove clean.
          if ! awk -F '\t' -v file="${file}" '$1 == file { found=1 } END { exit !found }' "${census_file}"; then
            uncertain+=("${file}")
          fi
        fi
      done
    fi
  done
done

LC_ALL=C sort -u < <(cut -f 1 "${records}") > "${run_dir}/spawners.txt"
printf '%s\n' ${files[@]+"${files[@]}"} | sed '/^$/d' | LC_ALL=C sort -u > "${run_dir}/selected.txt"
sed '/^#/d; /^$/d' "${allowlist}" | LC_ALL=C sort -u > "${run_dir}/previous.txt"
LC_ALL=C comm -12 "${run_dir}/previous.txt" "${run_dir}/selected.txt" > "${run_dir}/scanned-previous.txt"
LC_ALL=C comm -23 "${run_dir}/scanned-previous.txt" "${run_dir}/spawners.txt" > "${run_dir}/shrinkable.txt"
LC_ALL=C comm -23 "${run_dir}/previous.txt" "${run_dir}/selected.txt" > "${run_dir}/unscanned.txt"
awk -F '\t' '{ counts[$1 "\t" $2]++ } END { for (key in counts) print key "\t" counts[key] }' "${records}" \
  | LC_ALL=C sort > "${run_dir}/spawn-counts.tsv"
echo "Per-file/tool spawn counts (union membership; counts include passes and retries):"
cat "${run_dir}/spawn-counts.tsv"
echo "Shrinkable entries:"
cat "${run_dir}/shrinkable.txt"
echo "Batch logs and reports: ${run_dir}"
if [[ "${#uncertain[@]}" -gt 0 ]]; then
  printf '%s\n' "${uncertain[@]}" | LC_ALL=C sort -u > "${run_dir}/uncertain.txt"
  echo "Census incomplete: single-file failures without recorded hits; leaving allow-list unchanged:" >&2
  cat "${run_dir}/uncertain.txt" >&2
  exit 2
fi
if [[ "${update}" -eq 1 ]]; then
  if [[ "${allow_grow}" -eq 1 ]]; then
    cp "${run_dir}/spawners.txt" "${run_dir}/retained.txt"
  else
    LC_ALL=C comm -12 "${run_dir}/scanned-previous.txt" "${run_dir}/spawners.txt" > "${run_dir}/retained.txt"
  fi
  {
    head -n 1 "${allowlist}"
    cat "${run_dir}/unscanned.txt" "${run_dir}/retained.txt" | LC_ALL=C sort -u
  } > "${run_dir}/allowlist.txt"
  cp "${run_dir}/allowlist.txt" "${allowlist}"
  echo "Updated allow-list: $(sed '/^#/d; /^$/d' "${allowlist}" | wc -l | tr -d ' ') entries."
elif [[ -s "${run_dir}/shrinkable.txt" ]]; then
  echo "Run with --update to remove these entries." >&2
  exit 1
fi
