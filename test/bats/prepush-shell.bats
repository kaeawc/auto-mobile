#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  TEST_ROOT="$(mktemp -d)"
  STUB_DIR="${TEST_ROOT}/bin"
  FAST_LOG="${TEST_ROOT}/fast.log"
  BATS_LOG="${TEST_ROOT}/bats.log"
  SHELLCHECK_LOG="${TEST_ROOT}/shellcheck.log"
  mkdir -p "${TEST_ROOT}/scripts" "${TEST_ROOT}/test/bats" "${STUB_DIR}"

  cat > "${TEST_ROOT}/scripts/all_fast_validate_checks.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${PREPUSH_FAST_LOG}"
EOF
  chmod +x "${TEST_ROOT}/scripts/all_fast_validate_checks.sh"

  cat > "${STUB_DIR}/bats" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${PREPUSH_BATS_LOG}"
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

  cp "${REPO_ROOT}/scripts/prepush-shell.sh" "${TEST_ROOT}/scripts/prepush-shell.sh"
  chmod +x "${TEST_ROOT}/scripts/prepush-shell.sh"

  export PREPUSH_FAST_LOG="${FAST_LOG}"
  export PREPUSH_BATS_LOG="${BATS_LOG}"
  export PREPUSH_SHELLCHECK_LOG="${SHELLCHECK_LOG}"
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
  printf '%s\n' '# renamed-helper' > test/bats/renamed-helper.bats
  git add scripts/renamed-helper.sh test/bats/renamed-helper.bats
  git commit -qm "rename baseline"
  git branch -M main
  git branch base
  git checkout -qb feature
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

@test "a changed shell script selects shell checks without unrelated docs checks" {
  commit_change "scripts/example.sh" "#!/usr/bin/env bash"
  printf '%s\n' '# scripts/example.sh' > test/bats/example.bats

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  grep -Fqx -- '--only shellcheck,shell-portability,shell-sete,stdlib-first' "${FAST_LOG}"
  ! grep -Fq -- 'mkdocs-nav' "${FAST_LOG}"
  grep -Fqx -- 'test/bats/example.bats' "${BATS_LOG}"
}

@test "a changed package manifest selects dependency pin checks" {
  commit_change "package.json" '{"name":"fixture"}'

  run bash scripts/prepush-shell.sh --base base

  [ "${status}" -eq 0 ]
  grep -Fqx -- '--only runtime-pins,sharp-matrix,bun-version-coherence,dependency-decisions' "${FAST_LOG}"
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

@test "the default base falls back to main when origin/main is unavailable" {
  commit_change "package.json" '{"name":"fixture"}'

  run bash scripts/prepush-shell.sh

  [ "${status}" -eq 0 ]
  grep -Fqx -- '--only runtime-pins,sharp-matrix,bun-version-coherence,dependency-decisions' "${FAST_LOG}"
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
