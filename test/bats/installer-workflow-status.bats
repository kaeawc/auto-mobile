#!/usr/bin/env bats

workflow_files=(
  ".github/workflows/pull_request.yml"
  ".github/workflows/merge.yml"
)

@test "installer development workflows gate follow-up steps on installer step output" {
  for workflow_file in "${workflow_files[@]}"; do
    run grep -q "id: run-installer-development" "${workflow_file}"
    [ "$status" -eq 0 ]

    run grep -q "steps.run-installer-development.outputs.install_exit_code == '0'" "${workflow_file}"
    [ "$status" -eq 0 ]

    run grep -q "env.INSTALL_EXIT_CODE == '0'" "${workflow_file}"
    [ "$status" -eq 1 ]
  done
}
