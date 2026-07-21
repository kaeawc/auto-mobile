#!/usr/bin/env bats
#
# Tests for scripts/validate_codex_skills.sh
#
# Focus: the `.agents/skills/<name>` Codex discovery wrapper duplicates the
# canonical `skills/<name>` description and agents/openai.yaml rather than
# pointing at them, so both drift silently — Codex surfaces the wrapper's copy
# while the canonical skill says something else. These tests pin the drift
# detection, including that a quoted and an unquoted description carrying the
# SAME value still compare equal (a description containing ': ' must be quoted,
# so representation legitimately differs between the two files).

SCRIPT="scripts/validate_codex_skills.sh"

setup() {
  PROJECT_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  WORK_DIR="$(mktemp -d)"

  mkdir -p "$WORK_DIR/scripts" "$WORK_DIR/skills" "$WORK_DIR/.agents/skills"
  cp "$PROJECT_ROOT/$SCRIPT" "$WORK_DIR/scripts/"

  # AGENTS.md must exist and list every skill the validator finds.
  # The inventory parser keys off a literal `## Skills` heading.
  cat > "$WORK_DIR/AGENTS.md" <<'EOF'
# Test

## Skills

- demo: Demo skill. Path: `skills/demo/SKILL.md`.
EOF
}

teardown() {
  rm -rf "$WORK_DIR"
}

# Write a canonical skill + its Codex wrapper.
# Args: <canonical description line> <wrapper description line>
make_skill_pair() {
  mkdir -p "$WORK_DIR/skills/demo/agents" "$WORK_DIR/.agents/skills/demo/agents"

  printf -- '---\nname: demo\ndescription: %s\n---\n\n# Demo\n' "$1" \
    > "$WORK_DIR/skills/demo/SKILL.md"

  printf -- '---\nname: demo\ndescription: %s\n---\n\n# Demo\n\nRead and follow the canonical skill at\n`../../../skills/demo/SKILL.md`.\n' "$2" \
    > "$WORK_DIR/.agents/skills/demo/SKILL.md"

  cat > "$WORK_DIR/skills/demo/agents/openai.yaml" <<'EOF'
interface:
  display_name: "Demo"
  short_description: "A demo skill"
  default_prompt: "Use $demo to do the thing."
EOF
  cp "$WORK_DIR/skills/demo/agents/openai.yaml" \
     "$WORK_DIR/.agents/skills/demo/agents/openai.yaml"
}

@test "passes when wrapper and canonical descriptions match" {
  make_skill_pair 'A demo skill.' 'A demo skill.'

  cd "$WORK_DIR"
  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
}

@test "fails when the wrapper description has drifted" {
  make_skill_pair 'A demo skill.' 'Something else entirely.'

  cd "$WORK_DIR"
  run bash "$SCRIPT"

  [ "$status" -ne 0 ]
  [[ "$output" == *"description differs from"* ]]
}

@test "a different spelling of the same value is still drift" {
  # The comparison is byte-identical, deliberately. Hand-decoding YAML scalars to
  # compare values produced three separate false-drift bugs (escaped quotes, bash
  # 3.2 replacement semantics, literal \n ordering), and the repo bans hand-rolled
  # parsing of structured formats. The wrapper is generated from the canonical, so
  # requiring the exact line is achievable — and stricter.
  make_skill_pair 'Demo does a thing.' '"Demo does a thing."'

  cd "$WORK_DIR"
  run bash "$SCRIPT"

  [ "$status" -ne 0 ]
  [[ "$output" == *"differs from"* ]]
  [[ "$output" == *"verbatim"* ]]
}

@test "an identical quoted line passes" {
  make_skill_pair '"Demo: does a thing."' '"Demo: does a thing."'

  cd "$WORK_DIR"
  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
}

@test "fails when wrapper openai.yaml differs from canonical" {
  make_skill_pair 'A demo skill.' 'A demo skill.'

  cat > "$WORK_DIR/.agents/skills/demo/agents/openai.yaml" <<'EOF'
interface:
  display_name: "Demo (stale copy)"
  short_description: "A demo skill"
  default_prompt: "Use $demo to do the thing."
EOF

  cd "$WORK_DIR"
  run bash "$SCRIPT"

  [ "$status" -ne 0 ]
  [[ "$output" == *"differs from"* ]]
}

@test "fails when a skill with openai metadata has no discovery wrapper" {
  make_skill_pair 'A demo skill.' 'A demo skill.'
  rm -rf "$WORK_DIR/.agents/skills/demo"

  cd "$WORK_DIR"
  run bash "$SCRIPT"

  [ "$status" -ne 0 ]
  [[ "$output" == *"missing Codex discovery wrapper"* ]]
}

@test "rejects a symlinked wrapper directory" {
  # The original #2886 implementation symlinked the wrapper; it was replaced
  # because Codex discovery cannot be relied on to follow symlinks.
  make_skill_pair 'A demo skill.' 'A demo skill.'
  rm -rf "$WORK_DIR/.agents/skills/demo"
  ln -s "$WORK_DIR/skills/demo" "$WORK_DIR/.agents/skills/demo"

  cd "$WORK_DIR"
  run bash "$SCRIPT"

  [ "$status" -ne 0 ]
  [[ "$output" == *"must not be symlinks"* ]]
}

@test "REGRESSION: runs under bash 3.2 when .agents/skills is empty" {
  # macOS ships bash 3.2 as /bin/bash, and CI's macos-latest leg runs the
  # validator with it. Under `set -u`, bash 3.2 treats "${arr[@]}" on an EMPTY
  # array as an unbound variable, so the script died with
  #   agents_skill_files[@]: unbound variable
  # before reaching any real check — surfacing as a wrong-message failure
  # rather than an obvious crash. Every possibly-empty array is now expanded
  # as ${arr[@]+"${arr[@]}"}.
  if [ ! -x /bin/bash ]; then
    skip "no /bin/bash on this host"
  fi

  make_skill_pair 'A demo skill.' 'A demo skill.'
  rm -rf "$WORK_DIR/.agents/skills/demo"

  cd "$WORK_DIR"
  run /bin/bash "$SCRIPT"

  [[ "$output" != *"unbound variable"* ]]
  [[ "$output" == *"missing Codex discovery wrapper"* ]]
}

@test "REGRESSION: bash 3.2 with no AGENTS.md skill entries does not crash" {
  # Exercises the agents_entries / skill_paths expansions on the same path.
  if [ ! -x /bin/bash ]; then
    skip "no /bin/bash on this host"
  fi

  make_skill_pair 'A demo skill.' 'A demo skill.'
  printf '# Test\n\n## Skills\n\n' > "$WORK_DIR/AGENTS.md"

  cd "$WORK_DIR"
  run /bin/bash "$SCRIPT"

  [[ "$output" != *"unbound variable"* ]]
  [ "$status" -ne 0 ]
}
