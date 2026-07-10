#!/usr/bin/env bats

workflow_files=(
  ".github/workflows/pull_request.yml"
  ".github/workflows/merge.yml"
)

assert_step_if_equals() {
  local workflow_file="$1"
  local step_name="$2"
  local expected="$3"

  awk -v step_name="${step_name}" -v expected="${expected}" '
    index($0, "id: run-installer-development") {
      seen_development_installer = 1
    }
    seen_development_installer && index($0, "name: \"" step_name "\"") {
      in_step = 1
      next
    }
    in_step && /^      - name:/ {
      exit(found ? 0 : 1)
    }
    in_step && $0 ~ /^[[:space:]]*if:/ && index($0, expected) {
      found = 1
    }
    END {
      if (in_step && found) {
        exit 0
      }
      exit 1
    }
  ' "${workflow_file}"
}

assert_development_installer_writes_output() {
  local workflow_file="$1"

  awk '
    index($0, "id: run-installer-development") {
      in_step = 1
      next
    }
    in_step && /^      - name:/ {
      exit(found ? 0 : 1)
    }
    in_step && index($0, "echo \"install_exit_code=${install_status}\" >> \"$GITHUB_OUTPUT\"") {
      found = 1
    }
    END {
      if (in_step && found) {
        exit 0
      }
      exit 1
    }
  ' "${workflow_file}"
}

@test "installer development workflows gate follow-up steps on installer step output" {
  for workflow_file in "${workflow_files[@]}"; do
    run grep -q "id: run-installer-development" "${workflow_file}"
    [ "$status" -eq 0 ]

    assert_development_installer_writes_output "${workflow_file}"
    assert_step_if_equals "${workflow_file}" "Verify runtime dependencies" "steps.run-installer-development.outputs.install_exit_code == '0'"
    assert_step_if_equals "${workflow_file}" "Build from source" "steps.run-installer-development.outputs.install_exit_code == '0'"
    assert_step_if_equals "${workflow_file}" "Daemon lifecycle (start → health → doctor → stop)" "steps.run-installer-development.outputs.install_exit_code == '0'"
    assert_step_if_equals "${workflow_file}" "Upload Logs" "steps.run-installer-development.outputs.install_exit_code != '0'"
    assert_step_if_equals "${workflow_file}" "Fail on error" "steps.run-installer-development.outputs.install_exit_code != '0'"
  done
}
