#!/usr/bin/env bats
#
# Tests for scripts/github/auto_mobile_docs/github_alerts.py (MkDocs hook that
# renders GitHub `> [!NOTE]` alerts as Material admonitions).

convert() {
  PYTHONDONTWRITEBYTECODE=1 python3 -c '
import sys
sys.path.insert(0, "scripts/github")
from auto_mobile_docs.github_alerts import convert
sys.stdout.write(convert(sys.stdin.read()))
'
}

@test "converts a GitHub alert into an admonition" {
  run convert <<<$'> [!WARNING]\n> Body line.'
  [ "$status" -eq 0 ]
  [[ "$output" == *'!!! warning "Warning"'* ]]
  [[ "$output" == *"    Body line."* ]]
}

@test "leaves alerts inside fenced code untouched" {
  run convert <<<$'```md\n> [!NOTE]\n```'
  [ "$status" -eq 0 ]
  [[ "$output" != *"!!!"* ]]
}

@test "a shorter fence inside a longer fence does not close it" {
  run convert <<<$'````md\n```\n> [!NOTE]\n```\n````'
  [ "$status" -eq 0 ]
  [[ "$output" != *"!!!"* ]]
}

@test "a backtick opener with a backtick in its info string is not a fence" {
  run convert <<<$'```foo`bar\n> [!NOTE]\n> x'
  [ "$status" -eq 0 ]
  [[ "$output" == *'!!! note "Note"'* ]]
}

@test "preserves a fenced alert example inside a blockquote" {
  run convert <<<$'> ```markdown\n> [!NOTE]\n> ```\n\n> [!TIP]\n> real'
  [ "$status" -eq 0 ]
  [[ "$output" == *$'> ```markdown\n> [!NOTE]\n> ```'* ]]
  [[ "$output" == *'!!! tip "Tip"'* ]]
  [[ "$output" != *"!!! note"* ]]
}

@test "a quoted fence ends with its blockquote" {
  run convert <<<$'> ```\n> x\n\n> [!TIP]\n> y'
  [ "$status" -eq 0 ]
  [[ "$output" == *'!!! tip "Tip"'* ]]
}
