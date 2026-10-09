#!/usr/bin/env bats

WF=".github/workflows/pull_request.yml"

@test "npm size comment includes headroom warnings and largest files without changing pass status" {
  run yq -r '.jobs."node-checks".steps[] | select(.name == "Post Consolidated Comment") | .with.script' "$WF"
  [ "$status" -eq 0 ]
  for field in 'result.headroomBytes' 'result.headroomPercent' 'report.warnings' 'report.package.largestFiles' '⚠️ Size Warning'; do
    [[ "$output" == *"$field"* ]]
  done
  [[ "$output" == *"report.passed ? '✅ PASSED' : '❌ FAILED'"* ]]
}

@test "npm size check emits advisory annotation from JSON warnings in the passing branch" {
  run yq -r '.jobs."node-checks".steps[] | select(.name == "Check Benchmark Results") | .run' "$WF"
  [ "$status" -eq 0 ]
  [[ "$output" == *'jq -e '*'.warnings // []'* ]]
  [[ "$output" == *'::warning::NPM unpacked size headroom is low'* ]]
  [[ "$output" == *'else'*'::notice::NPM unpacked size benchmark passed'*'::warning::'* ]]
}
