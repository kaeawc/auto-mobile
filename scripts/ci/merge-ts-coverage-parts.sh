#!/usr/bin/env bash
#
# Join the TypeScript coverage parts that On Merge runs as separate jobs
# (#16377) into the one coverage tree the badge and the 100ms timing gate read.
#
# Each part directory is one downloaded `ts-coverage-part-N` artifact:
#   <part>/lcov.info                  the part's merged LCOV
#   <part>/junit.xml                  the part's merged JUnit
#   <part>/shards/*.xml               the part's per-chunk JUnit reports
#   <part>/shards/calibration-*.tsv   the part's runner calibration probes
#
# Writes <coverage-dir>/lcov.info and <coverage-dir>/junit.xml, and copies the
# chunk reports and calibration probes flat into <coverage-dir>/shards, the
# directory the timing gate reads. scripts/test-ts.sh numbers each part's shards
# after the earlier parts', so the names never collide; a collision means the
# parts were not run as one split and fails the merge.
#
# Usage:
#   scripts/ci/merge-ts-coverage-parts.sh <expected-parts> <parts-dir> [coverage-dir]

set -euo pipefail

if [[ "$#" -lt 2 || "$#" -gt 3 ]]; then
  echo "Usage: $0 <expected-parts> <parts-dir> [coverage-dir]" >&2
  exit 2
fi

expected="$1"
parts_dir="$2"
coverage_dir="${3:-coverage}"

if ! [[ "$expected" =~ ^[1-9][0-9]*$ ]]; then
  echo "expected-parts must be a positive integer, got: ${expected}" >&2
  exit 2
fi

parts=()
for part in "$parts_dir"/*/; do
  [[ -d "$part" ]] || continue
  parts+=("${part%/}")
done

if [[ "${#parts[@]}" -ne "$expected" ]]; then
  echo "::error::Expected ${expected} coverage parts in ${parts_dir}, found ${#parts[@]}" >&2
  exit 1
fi

lcov_files=()
junit_files=()
mkdir -p "$coverage_dir/shards"
for part in ${parts[@]+"${parts[@]}"}; do
  name="${part##*/}"
  for required in lcov.info junit.xml; do
    if [[ ! -s "$part/$required" ]]; then
      echo "::error::Coverage part ${name} has no ${required}" >&2
      exit 1
    fi
  done
  lcov_files+=("$part/lcov.info")
  junit_files+=("$part/junit.xml")
  reports=0
  for report in "$part"/shards/*.xml "$part"/shards/calibration-*.tsv; do
    [[ -f "$report" ]] || continue
    target="$coverage_dir/shards/${report##*/}"
    if [[ -e "$target" ]]; then
      echo "::error::Coverage part ${name} repeats ${report##*/}; each part must number its shards after the earlier parts'" >&2
      exit 1
    fi
    cp "$report" "$target"
    if [[ "$report" == *.xml ]]; then
      reports=$((reports + 1))
    fi
  done
  if [[ "$reports" -eq 0 ]]; then
    echo "::error::Coverage part ${name} has no chunk JUnit reports under shards/" >&2
    exit 1
  fi
done

bun scripts/lib/merge-lcov.ts "$coverage_dir/lcov.info" ${lcov_files[@]+"${lcov_files[@]}"}
bun scripts/lib/merge-junit-reports.ts "$coverage_dir/junit.xml" ${junit_files[@]+"${junit_files[@]}"}
echo "Merged ${#parts[@]} coverage parts into ${coverage_dir}"
