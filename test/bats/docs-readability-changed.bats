#!/usr/bin/env bats

# scripts/docs/check-readability-changed.sh runs the readability checker on the
# docs pages a branch changed. `bun` is stubbed to record the pages it receives.

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  TEST_ROOT="$(mktemp -d)"
  STUB_DIR="${TEST_ROOT}/stub-bin"
  BUN_LOG="${TEST_ROOT}/bun.log"
  mkdir -p "${TEST_ROOT}/scripts/docs" "${TEST_ROOT}/scripts/lib" "${STUB_DIR}"
  cp "${REPO_ROOT}/scripts/docs/check-readability-changed.sh" "${TEST_ROOT}/scripts/docs/"
  cp "${REPO_ROOT}/scripts/lib/vcs-diff.sh" "${TEST_ROOT}/scripts/lib/"

  cat > "${STUB_DIR}/bun" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "${DOCS_READABILITY_BUN_LOG}"
exit "${DOCS_READABILITY_BUN_STATUS:-0}"
STUB
  chmod +x "${STUB_DIR}/bun"

  export DOCS_READABILITY_BUN_LOG="${BUN_LOG}"
  export PATH="${STUB_DIR}:${PATH}"
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_SYSTEM=/dev/null
  unset DOCS_READABILITY_BASE_REF

  cd "${TEST_ROOT}"
  git init -q
  git config user.email test@example.com
  git config user.name test
  git config commit.gpgsign false
  printf '%s\n' "stub-bin/" "*.log" > .gitignore
  mkdir -p docs/using docs/devlog
  printf '%s\n' "# Untouched" > docs/using/untouched.md
  printf '%s\n' "# Gone" > docs/using/gone.md
  git add .gitignore scripts docs
  git commit -qm "baseline"
  git branch -M main
  git checkout -qb feature
}

teardown() {
  rm -rf "${TEST_ROOT}"
}

checked_pages() {
  sed -n '/^--files$/,$p' "${BUN_LOG}" | sed '1d'
}

@test "no changed docs page skips the checker and passes" {
  printf '%s\n' "x" > notes.txt
  git add notes.txt
  git commit -qm "non-docs change"

  run bash scripts/docs/check-readability-changed.sh

  [ "${status}" -eq 0 ]
  [[ "${output}" == *"no docs pages changed since the merge-base with main"* ]]
  [ ! -e "${BUN_LOG}" ]
}

@test "committed, unstaged and untracked pages are checked; untouched, deleted and non-Markdown files are not" {
  printf '%s\n' "# Committed" > docs/using/committed.md
  git rm -q docs/using/gone.md
  printf '%s\n' "asset" > docs/using/image.txt
  git add docs
  git commit -qm "docs change"
  printf '%s\n' "# Unstaged" > docs/devlog/unstaged.md
  git add docs/devlog/unstaged.md
  git commit -qm "tracked page"
  printf '%s\n' "# Untracked" > docs/devlog/new.md
  printf '%s\n' "# Edited" >> docs/devlog/unstaged.md

  run bash scripts/docs/check-readability-changed.sh

  [ "${status}" -eq 0 ]
  head -n 1 "${BUN_LOG}" | grep -Fq "scripts/docs/check-readability.ts"
  [ "$(checked_pages)" = "$(printf '%s\n' docs/devlog/new.md docs/devlog/unstaged.md docs/using/committed.md)" ]
}

@test "the checker's failing status fails the check" {
  printf '%s\n' "# Long" > docs/using/long.md
  git add docs/using/long.md
  git commit -qm "page with findings"
  export DOCS_READABILITY_BUN_STATUS=1

  run bash scripts/docs/check-readability-changed.sh

  [ "${status}" -eq 1 ]
  [ "$(checked_pages)" = "docs/using/long.md" ]
}

@test "the base ref comes from DOCS_READABILITY_BASE_REF" {
  printf '%s\n' "# First" > docs/using/first.md
  git add docs/using/first.md
  git commit -qm "first page"
  git branch mid
  printf '%s\n' "# Second" > docs/using/second.md
  git add docs/using/second.md
  git commit -qm "second page"

  DOCS_READABILITY_BASE_REF=mid run bash scripts/docs/check-readability-changed.sh

  [ "${status}" -eq 0 ]
  [ "$(checked_pages)" = "docs/using/second.md" ]
}

@test "an explicit base that does not resolve fails without falling back" {
  DOCS_READABILITY_BASE_REF=missing-ref run bash scripts/docs/check-readability-changed.sh

  [ "${status}" -eq 2 ]
  [[ "${output}" == *"base ref 'missing-ref' does not resolve"* ]]
  [ ! -e "${BUN_LOG}" ]
}
