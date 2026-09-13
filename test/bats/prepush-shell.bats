#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  TEST_ROOT="$(mktemp -d)"
  STUB_DIR="${TEST_ROOT}/bin"
  FAST_LOG="${TEST_ROOT}/fast.log"
  BATS_LOG="${TEST_ROOT}/bats.log"
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

  cp "${REPO_ROOT}/scripts/prepush-shell.sh" "${TEST_ROOT}/scripts/prepush-shell.sh"
  chmod +x "${TEST_ROOT}/scripts/prepush-shell.sh"

  export PREPUSH_FAST_LOG="${FAST_LOG}"
  export PREPUSH_BATS_LOG="${BATS_LOG}"
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
