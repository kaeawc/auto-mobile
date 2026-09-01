#!/usr/bin/env bats

workflow_files=(
  ".github/workflows/pull_request.yml"
  ".github/workflows/merge.yml"
)

@test "installer development jobs and their follow-up steps are removed" {
  for workflow_file in "${workflow_files[@]}"; do
    run awk '
      /installer-development|run-installer-development|Installer Development/ {
        found = 1
      }
      END {
        exit(found ? 0 : 1)
      }
    ' "${workflow_file}"
    [ "$status" -eq 1 ]
  done
}
