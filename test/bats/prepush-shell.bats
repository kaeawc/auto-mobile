#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  TEST_ROOT="$(mktemp -d)"
  STUB_DIR="${TEST_ROOT}/bin"
  FAST_LOG="${TEST_ROOT}/fast.log"
  BATS_LOG="${TEST_ROOT}/bats.log"
  SHELLCHECK_LOG="${TEST_ROOT}/shellcheck.log"
  REAL_GIT="$(command -v git)"
  mkdir -p "${TEST_ROOT}/scripts/lib" "${TEST_ROOT}/test/bats" "${STUB_DIR}"

  cat > "${TEST_ROOT}/scripts/all_fast_validate_checks.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${PREPUSH_FAST_LOG}"
printf 'STDLIB_FIRST_BASE_REF=%s\n' "${STDLIB_FIRST_BASE_REF:-<unset>}" >> "${PREPUSH_FAST_LOG}"
EOF
  chmod +x "${TEST_ROOT}/scripts/all_fast_validate_checks.sh"

  cat > "${STUB_DIR}/bats" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${PREPUSH_BATS_LOG}"
for bats_file in "$@"; do
  if [[ ! -f "${bats_file}" ]]; then
    exit 2
  fi
done
EOF
  chmod +x "${STUB_DIR}/bats"

  cat > "${STUB_DIR}/shellcheck" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${PREPUSH_SHELLCHECK_LOG}"
if [[ -n "${PREPUSH_SHELLCHECK_ERROR:-}" ]]; then
  printf '%s\n' "${PREPUSH_SHELLCHECK_ERROR}" >&2
fi
exit "${PREPUSH_SHELLCHECK_STATUS:-0}"
EOF
  chmod +x "${STUB_DIR}/shellcheck"

  cat > "${STUB_DIR}/git" <<'EOF'
#!/usr/bin/env bash
if [[ "${PREPUSH_GIT_DIFF_FAIL:-}" == "1" && "$#" -ge 5 && "$1" == "diff" && "$2" == "--no-renames" && "$3" == "--name-only" && "${!#}" == "HEAD" ]]; then
  printf '%s\n' "simulated git diff failure" >&2
  exit 17
fi
exec "${PREPUSH_REAL_GIT}" "$@"
EOF
  chmod +x "${STUB_DIR}/git"

  cp "${REPO_ROOT}/scripts/prepush-shell.sh" "${TEST_ROOT}/scripts/prepush-shell.sh"
  cp "${REPO_ROOT}/scripts/lib/tsImportDeps.ts" "${TEST_ROOT}/scripts/lib/tsImportDeps.ts"
  ln -s "${REPO_ROOT}/node_modules" "${TEST_ROOT}/node_modules"
  chmod +x "${TEST_ROOT}/scripts/prepush-shell.sh"

  export PREPUSH_FAST_LOG="${FAST_LOG}"
  export PREPUSH_BATS_LOG="${BATS_LOG}"
  export PREPUSH_SHELLCHECK_LOG="${SHELLCHECK_LOG}"
  export PREPUSH_REAL_GIT="${REAL_GIT}"
  export PATH="${STUB_DIR}:${PATH}"
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_SYSTEM=/dev/null

  cd "${TEST_ROOT}"
  git init -q
  git config user.email test@example.com
  git config user.name test
  git config commit.gpgsign false
  printf '%s\n' "baseline" > README.md
  git add README.md
  git commit -qm "baseline"
  mkdir -p scripts test/bats
  printf '%s\n' "#!/usr/bin/env bash" > scripts/renamed-helper.sh
  printf '%s\n' "#!/usr/bin/env bash" > scripts/deleted-check.sh
  printf '%s\n' '# renamed-helper' > test/bats/renamed-helper.bats
  git add scripts/renamed-helper.sh scripts/deleted-check.sh test/bats/renamed-helper.bats
  git commit -qm "rename baseline"
  mkdir -p scripts/lib
  printf '%s\n' '# shellcheck source=scripts/lib/shared-helper.sh' > scripts/check-helper-consumer-one.sh
  printf '%s\n' '# shellcheck source=scripts/lib/shared-helper.sh' > scripts/check-helper-consumer-two.sh
  printf '%s\n' 'helper baseline' > scripts/lib/shared-helper.sh
  git add scripts/check-helper-consumer-one.sh scripts/check-helper-consumer-two.sh scripts/lib/shared-helper.sh
  git commit -qm "add helper consumers"
  git branch -M main
  git branch base
  git checkout -qb feature
}

@test "a changed TypeScript dependency selects its registered check" {
  install_registry_stub
  mkdir -p scripts/release/lib
  printf '%s\n' 'import "./lib/runtime-roots";' > scripts/release/pin-runtime-deps.ts
  printf '%s\n' 'export const runtimeRoots = [];' > scripts/release/lib/runtime-roots.ts
  git add scripts/release/pin-runtime-deps.ts scripts/release/lib/runtime-roots.ts
  git commit -qm "add runtime pins fixtures"
  git branch -f base HEAD
  commit_change "scripts/release/lib/runtime-roots.ts" "export const runtimeRoots = [\"changed\"];"

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  grep -Fqx -- '--only stdlib-first,runtime-pins' "${FAST_LOG}"
}

@test "an unrelated TypeScript script does not select a registered TypeScript check" {
  install_registry_stub
  mkdir -p scripts/release/lib
  printf '%s\n' 'import "./lib/runtime-roots";' > scripts/release/pin-runtime-deps.ts
  printf '%s\n' 'export const runtimeRoots = [];' > scripts/release/lib/runtime-roots.ts
  git add scripts/release/pin-runtime-deps.ts scripts/release/lib/runtime-roots.ts
  git commit -qm "add runtime pins fixtures"
  git branch -f base HEAD
  commit_change "scripts/unrelated.ts" "export const unrelated = true;"

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  grep -Fqx -- '--only stdlib-first' "${FAST_LOG}"
}

@test "a TypeScript dependency resolver failure stops prepush closed" {
  install_registry_stub
  mkdir -p scripts/release/lib
  printf '%s\n' 'import "./lib/runtime-roots";' > scripts/release/pin-runtime-deps.ts
  printf '%s\n' 'export const runtimeRoots = [];' > scripts/release/lib/runtime-roots.ts
  git add scripts/release/pin-runtime-deps.ts scripts/release/lib/runtime-roots.ts
  git commit -qm "add runtime pins fixtures"
  git branch -f base HEAD
  commit_change "scripts/release/lib/runtime-roots.ts" "export const runtimeRoots = [\"changed\"];"
  cat > "${STUB_DIR}/bun" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "simulated TypeScript dependency resolver failure" >&2
exit 19
EOF
  chmod +x "${STUB_DIR}/bun"

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 19 ]
  [[ "${output}" == *"Failed to resolve TypeScript dependencies for scripts/release/pin-runtime-deps.ts"* ]]
}

teardown() {
  rm -rf "${TEST_ROOT}"
}

commit_change() {
  local path="$1"
  local content="$2"
  mkdir -p "$(dirname "${path}")"
  printf '%s\n' "${content}" > "${path}"
  git add "${path}"
  git commit -qm "change ${path}"
}

install_registry_stub() {
  cat > "${TEST_ROOT}/scripts/all_fast_validate_checks.sh" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "--list-checks" ]]; then
  printf 'claude-plugin\tscripts/claude/validate_plugin.sh\n'
  printf 'deleted-check\tscripts/deleted-check.sh\n'
  printf 'stdlib-first\tscripts/conventions/validate-stdlib-first.sh\n'
  printf 'helper-consumer-one\tscripts/check-helper-consumer-one.sh\n'
  printf 'helper-consumer-two\tscripts/check-helper-consumer-two.sh\n'
  printf 'runtime-pins\tscripts/release/pin-runtime-deps.ts\n'
  exit 0
fi
printf '%s\n' "$*" >> "${PREPUSH_FAST_LOG}"
printf 'STDLIB_FIRST_BASE_REF=%s\n' "${STDLIB_FIRST_BASE_REF:-<unset>}" >> "${PREPUSH_FAST_LOG}"
EOF
  chmod +x "${TEST_ROOT}/scripts/all_fast_validate_checks.sh"
}

@test "a changed shell script selects shell checks without unrelated docs checks" {
  commit_change "scripts/example.sh" "#!/usr/bin/env bash"
  printf '%s\n' '# scripts/example.sh' > test/bats/example.bats

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  grep -Fqx -- '--only shellcheck,shell-portability,shell-sete,stdlib-first' "${FAST_LOG}"
  ! grep -Fq -- 'mkdocs-nav' "${FAST_LOG}"
  grep -Fqx -- 'test/bats/example.bats' "${BATS_LOG}"
}

@test "a changed registered fast-check implementation selects that check" {
  install_registry_stub
  commit_change "scripts/claude/validate_plugin.sh" "#!/usr/bin/env bash"

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  grep -Fqx -- '--only shellcheck,shell-portability,shell-sete,stdlib-first,claude-plugin' "${FAST_LOG}"
}

@test "a deleted registered fast-check implementation still selects that check" {
  install_registry_stub
  git rm -q scripts/deleted-check.sh
  git commit -qm "delete scripts/deleted-check.sh"

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  grep -Fqx -- '--only shellcheck,shell-portability,shell-sete,stdlib-first,deleted-check' "${FAST_LOG}"
}

@test "a changed sourced helper selects every registered consumer" {
  install_registry_stub
  printf '%s\n' 'helper changed' > scripts/lib/shared-helper.sh
  git add scripts/lib/shared-helper.sh
  git commit -qm "change scripts/lib/shared-helper.sh"

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  grep -Fqx -- '--only shellcheck,shell-portability,shell-sete,stdlib-first,helper-consumer-one,helper-consumer-two' "${FAST_LOG}"
}

@test "an unmatched scripts file selects no registered fast check" {
  install_registry_stub
  commit_change "scripts/unmatched-prepush-fixture.txt" "fixture"

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  grep -Fqx -- '--only stdlib-first' "${FAST_LOG}"
}

@test "a changed sete baseline selects shell-sete" {
  commit_change "scripts/shellcheck/sete-baseline.txt" "baseline fixture"

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  grep -Fqx -- '--only stdlib-first,shell-sete' "${FAST_LOG}"
}

@test "changed GitHub Python lock inputs select github-python-lock" {
  commit_change "scripts/github/uv.lock" "lock fixture"
  commit_change "scripts/github/pyproject.toml" '[project]'

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  grep -Fqx -- '--only stdlib-first,github-python-lock' "${FAST_LOG}"
}

@test "a changed shell script outside scripts/ selects shellcheck without portability or sete" {
  commit_change "demo/scripts/bad.sh" "#!/usr/bin/env bash"

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  grep -Fqx -- '--only shellcheck' "${FAST_LOG}"
}

@test "a changed package manifest selects dependency pin checks" {
  commit_change "package.json" '{"name":"fixture"}'

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  grep -Fqx -- '--only runtime-pins,sharp-matrix,bun-version-coherence,dependency-decisions,claude-plugin' "${FAST_LOG}"
}

@test "a bun.lock-only change does not select the Claude plugin check" {
  commit_change "bun.lock" 'lockfile fixture'

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  grep -Fqx -- '--only runtime-pins,sharp-matrix,bun-version-coherence,dependency-decisions' "${FAST_LOG}"
  ! grep -Fq -- 'claude-plugin' "${FAST_LOG}"
}

@test "a changed extensionless hook is shellchecked directly and selects shell checks" {
  commit_change ".githooks/pre-push" "#!/usr/bin/env bash"

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  grep -Fqx -- '--only shellcheck,shell-portability,shell-sete' "${FAST_LOG}"
  grep -Fqx -- '.githooks/pre-push' "${SHELLCHECK_LOG}"
}

@test "a failing changed extensionless hook fails prepush validation" {
  commit_change ".githooks/pre-push" "#!/usr/bin/env bash"
  export PREPUSH_SHELLCHECK_STATUS=23
  export PREPUSH_SHELLCHECK_ERROR="hook syntax error"

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 23 ]
  [[ "${output}" == *"hook syntax error"* ]]
  [[ "${output}" == *"ShellCheck failed"* ]]
}

@test "skill, agent wrapper, and Claude plugin changes select paired checks" {
  commit_change "skills/example/agents/openai.yaml" 'interface: {}'
  commit_change ".agents/skills/example/SKILL.md" '---'
  commit_change ".claude-plugin/plugin.json" '{}'

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  grep -Fqx -- '--only codex-skills,claude-plugin' "${FAST_LOG}"
}

@test "a changed BATS file runs without a fast validation selection" {
  commit_change "test/bats/only-this.bats" '@test "fails" { false; }'

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  [ ! -e "${FAST_LOG}" ]
  grep -Fqx -- 'test/bats/only-this.bats' "${BATS_LOG}"
}

@test "a changed gitattributes file selects LFS pointer validation" {
  commit_change ".gitattributes" '*.bin filter=lfs diff=lfs merge=lfs -text'

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  grep -Fqx -- '--only lfs-pointers' "${FAST_LOG}"
}

@test "Bun coherence inputs select only Bun version coherence" {
  commit_change ".github/actions/setup.yaml" 'name: setup'
  commit_change ".github/workflows/test.yml" 'name: test'
  commit_change "Dockerfile" 'FROM scratch'
  commit_change "scripts/local-dev/lib/deps.sh" '#!/usr/bin/env bash'

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  grep -Fqx -- '--only bun-version-coherence,shellcheck,shell-portability,shell-sete,stdlib-first' "${FAST_LOG}"
}

@test "a renamed script searches BATS using both old and new basenames" {
  git mv scripts/renamed-helper.sh scripts/renamed-helper-new.sh
  git commit -qm "rename helper"

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  grep -Fqx -- 'test/bats/renamed-helper.bats' "${BATS_LOG}"
}

@test "a deleted BATS file is not passed to bats" {
  git rm -q test/bats/renamed-helper.bats
  git commit -qm "delete BATS helper"

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  [ ! -e "${BATS_LOG}" ] || ! grep -Fq -- 'renamed-helper.bats' "${BATS_LOG}"
}

@test "the default base falls back to main when origin/main is unavailable" {
  commit_change "package.json" '{"name":"fixture"}'

  run bash scripts/prepush-shell.sh

  [ "${status}" -eq 0 ]
  grep -Fqx -- '--only runtime-pins,sharp-matrix,bun-version-coherence,dependency-decisions,claude-plugin' "${FAST_LOG}"
}

@test "an explicit --base is propagated to dependency-decisions checks" {
  commit_change "package.json" '{"name":"fixture"}'

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  grep -Fqx -- 'STDLIB_FIRST_BASE_REF=base' "${FAST_LOG}"
}

@test "a fallback-to-main base is propagated to dependency-decisions checks" {
  commit_change "package.json" '{"name":"fixture"}'

  run bash scripts/prepush-shell.sh

  [ "${status}" -eq 0 ]
  grep -Fqx -- 'STDLIB_FIRST_BASE_REF=main' "${FAST_LOG}"
}

@test "a runtime-graph.json change selects runtime pin validation" {
  commit_change "scripts/release/runtime-graph.json" '{}'

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  grep -Fqx -- '--only runtime-pins,stdlib-first' "${FAST_LOG}"
}

@test "unmatched changes skip all work" {
  commit_change "src/example.ts" "export const fixture = true;"

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  [[ "${output}" == *"No shell/BATS-relevant fast validation checks match changed files"* ]]
  [ ! -e "${FAST_LOG}" ]
  [ ! -e "${BATS_LOG}" ]
}

@test "help exits successfully" {
  run bash scripts/prepush-shell.sh --help

  [ "${status}" -eq 0 ]
  [[ "${output}" == *"Usage:"* ]]
}

@test "an invalid explicit base reports a clear error" {
  run bash scripts/prepush-shell.sh --base missing-base

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"Base ref 'missing-base' does not resolve"* ]]
}

@test "a failed changed-file diff aborts before nothing-to-validate" {
  commit_change "src/example.ts" "export const fixture = true;"
  export PREPUSH_GIT_DIFF_FAIL=1

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -ne 0 ]
  [[ "${output}" == *"Failed to list changed files between"* ]]
  [[ "${output}" != *"nothing to validate"* ]]
}
