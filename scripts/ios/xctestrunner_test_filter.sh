#!/usr/bin/env bash
# Sourced simulator-free XCTestRunner discovery; no commands run on import.
# RemindersAddPlanTests extends RemindersIntegrationBase, which requires a
# booted Simulator and a live daemon, so it remains excluded from this run.
SIMULATOR_DEPENDENT_TEST_CLASSES=(
  RemindersAddPlanTests
)

# shellcheck disable=SC2034 # consumed by callers
XCTESTRUNNER_TEST_FILTER=""

xctestrunner_build_test_filter() {
  local list_output="$1" caller="${2:-prepush-ios.sh}"
  local test_class excluded_class included_class simulator_dependent already_included
  local -a test_classes=()
  XCTESTRUNNER_TEST_FILTER=""
  while IFS= read -r test_class; do
    [[ -z "${test_class}" ]] && continue
    simulator_dependent=false
    for excluded_class in "${SIMULATOR_DEPENDENT_TEST_CLASSES[@]}"; do
      if [[ "${test_class}" == "${excluded_class}" ]]; then
        simulator_dependent=true
        break
      fi
    done
    if [[ "${simulator_dependent}" == false ]]; then
      already_included=false
      for included_class in ${test_classes[@]+"${test_classes[@]}"}; do
        if [[ "${test_class}" == "${included_class}" ]]; then
          already_included=true
          break
        fi
      done
      if [[ "${already_included}" == false ]]; then
        test_classes+=("${test_class}")
      fi
    fi
  done < <(
    printf '%s\n' "${list_output}" | sed -n \
      -e 's/^XCTestRunnerTests\.\([^/]*\)\/.*/\1/p' \
      -e 's/^XCTestRunnerTests\.\([^/(]*\)(.*)$/\1/p'
  )

  if [[ ${#test_classes[@]} -eq 0 ]]; then
    echo "${caller}: swift test list produced no simulator-free XCTestRunnerTests classes after excluding the denylist; check swift test list output and SIMULATOR_DEPENDENT_TEST_CLASSES" >&2
    return 1
  fi

  # shellcheck disable=SC2034 # consumed by sourcing scripts
  XCTESTRUNNER_TEST_FILTER="XCTestRunnerTests\\.($(
    IFS='|'
    printf '%s' "${test_classes[*]}"
  ))"
}
