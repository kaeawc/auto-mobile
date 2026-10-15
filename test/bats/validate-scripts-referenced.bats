#!/usr/bin/env bats

setup() {
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
  repo_dir="$(mktemp -d)"
  mkdir -p "$repo_dir/scripts/conventions"
  cp "$BATS_TEST_DIRNAME/../../scripts/conventions/validate-scripts-referenced.sh" "$repo_dir/scripts/conventions/"
  mkdir -p "$repo_dir/docs"
  printf 'scripts/conventions/validate-scripts-referenced.sh\n' > "$repo_dir/docs/runner.md"
  git -C "$repo_dir" init -q
  git -C "$repo_dir" config user.email test@example.com
  git -C "$repo_dir" config user.name test
  export SCRIPTS_REFERENCED_ROOT="$repo_dir"
}

teardown() { rm -rf "$repo_dir"; }

commit_all() { git -C "$repo_dir" add -A; git -C "$repo_dir" commit -qm fixture; }

@test "counts a workflow reference" {
  printf '#!/bin/bash\n' > "$repo_dir/scripts/a.sh"
  mkdir -p "$repo_dir/.github/workflows"
  printf 'run: scripts/a.sh\n' > "$repo_dir/.github/workflows/ci.yml"
  commit_all
  run "$repo_dir/scripts/conventions/validate-scripts-referenced.sh"
  [ "$status" -eq 0 ]
}

@test "fails and names an unreferenced script" {
  printf '#!/bin/bash\n' > "$repo_dir/scripts/orphan.sh"
  commit_all
  run "$repo_dir/scripts/conventions/validate-scripts-referenced.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"scripts/orphan.sh"* ]]
}

@test "self references and allow-list-only references do not count" {
  printf 'scripts/self.sh\n' > "$repo_dir/scripts/self.sh"
  printf 'scripts/allow-only.sh\n' > "$repo_dir/scripts/allow-only.sh"
  commit_all
  run "$repo_dir/scripts/conventions/validate-scripts-referenced.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"scripts/self.sh"* ]]
  [[ "$output" == *"scripts/allow-only.sh"* ]]
}

@test "allow-listed script with no real reference passes without counting allow-list as a referrer" {
  printf 'scripts/allow-only.sh\n' > "$repo_dir/scripts/allow-only.sh"
  printf 'scripts/allow-only.sh  # reason\n' > "$repo_dir/scripts/conventions/unreferenced-scripts-allowlist.txt"
  commit_all
  run "$repo_dir/scripts/conventions/validate-scripts-referenced.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"All 2 scripts are referenced."* ]]
}

@test "allows an unreferenced script with a reason" {
  printf '#!/bin/bash\n' > "$repo_dir/scripts/kept.sh"
  printf 'scripts/kept.sh  # retained for operators\n' > "$repo_dir/scripts/conventions/unreferenced-scripts-allowlist.txt"
  commit_all
  run "$repo_dir/scripts/conventions/validate-scripts-referenced.sh"
  [ "$status" -eq 0 ]
}

@test "rejects stale, referenced, and empty-reason allow-list entries" {
  printf '#!/bin/bash\n' > "$repo_dir/scripts/now-used.sh"
  printf 'run: scripts/now-used.sh\n' > "$repo_dir/workflow.yml"
  printf 'scripts/missing.sh  # gone\nscripts/now-used.sh  # no longer needed\nscripts/no-reason.sh\n' > "$repo_dir/scripts/conventions/unreferenced-scripts-allowlist.txt"
  commit_all
  run "$repo_dir/scripts/conventions/validate-scripts-referenced.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"STALE allow-list entry: scripts/missing.sh"* ]]
  [[ "$output" == *"STALE allow-list entry: scripts/now-used.sh"* ]]
  [[ "$output" == *"STALE allow-list entry: scripts/no-reason.sh"* ]]
}

@test "test-only scripts pass and report" {
  printf '#!/bin/bash\n' > "$repo_dir/scripts/fixture.sh"
  mkdir -p "$repo_dir/test"
  printf 'scripts/fixture.sh\n' > "$repo_dir/test/fixture.test.ts"
  commit_all
  run "$repo_dir/scripts/conventions/validate-scripts-referenced.sh"
  [ "$status" -eq 0 ]
  run "$repo_dir/scripts/conventions/validate-scripts-referenced.sh" --report
  [[ "$output" == *"TEST-ONLY scripts/fixture.sh"* ]]
}

@test "directory tokens satisfy only the matching same-named script" {
  mkdir -p "$repo_dir/scripts/one" "$repo_dir/scripts/two" "$repo_dir/docs"
  printf '#!/bin/bash\n' > "$repo_dir/scripts/one/common.sh"
  printf '#!/bin/bash\n' > "$repo_dir/scripts/two/common.sh"
  printf 'scripts/one/common.sh\n' > "$repo_dir/docs/use.md"
  commit_all
  run "$repo_dir/scripts/conventions/validate-scripts-referenced.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"scripts/two/common.sh"* ]]
}

@test "bare duplicate basenames satisfy both while qualified paths satisfy one" {
  mkdir -p "$repo_dir/scripts/one" "$repo_dir/scripts/two" "$repo_dir/docs"
  printf '#!/bin/bash\n' > "$repo_dir/scripts/one/common.sh"
  printf '#!/bin/bash\n' > "$repo_dir/scripts/two/common.sh"
  printf 'common.sh\n' > "$repo_dir/docs/bare.md"
  commit_all
  run "$repo_dir/scripts/conventions/validate-scripts-referenced.sh"
  [ "$status" -eq 0 ]
}

@test "python package files in configured project roots are discovery referenced" {
  mkdir -p "$repo_dir/scripts/github/pkg" "$repo_dir/scripts/manual-test/python/pkg"
  printf 'name="fixture"\n' > "$repo_dir/scripts/github/pyproject.toml"
  printf '# module\n' > "$repo_dir/scripts/github/pkg/__init__.py"
  printf '# module\n' > "$repo_dir/scripts/manual-test/python/pkg/__init__.py"
  printf 'name = "fixture"\n' > "$repo_dir/scripts/manual-test/python/requirements.txt"
  commit_all
  run "$repo_dir/scripts/conventions/validate-scripts-referenced.sh"
  [ "$status" -eq 0 ]
}

@test "non-Python file under a configured Python root is unreferenced" {
  mkdir -p "$repo_dir/scripts/github"
  printf 'name = "fixture"\n' > "$repo_dir/scripts/github/pyproject.toml"
  printf '#!/bin/bash\n' > "$repo_dir/scripts/github/orphan.sh"
  commit_all
  run "$repo_dir/scripts/conventions/validate-scripts-referenced.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"UNREFERENCED scripts/github/orphan.sh"* ]]
}

@test "counts extensionless imports and ignores scratch hits" {
  printf 'export const x = 1;\n' > "$repo_dir/scripts/module.ts"
  mkdir -p "$repo_dir/src" "$repo_dir/scratch"
  printf 'import { x } from "../scripts/module";\n' > "$repo_dir/src/use.ts"
  printf 'scripts/scratch-only.sh\n' > "$repo_dir/scratch/notes.txt"
  printf '#!/bin/bash\n' > "$repo_dir/scripts/scratch-only.sh"
  commit_all
  run "$repo_dir/scripts/conventions/validate-scripts-referenced.sh"
  [ "$status" -eq 1 ]
  [[ "$output" == *"scripts/scratch-only.sh"* ]]
  [[ "$output" != *"scripts/module.ts"* ]]
}
