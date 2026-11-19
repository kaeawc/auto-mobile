#!/usr/bin/env bats

# A gitignored, locally generated docs/changelog.md must not reach the docs scanners (#18637).

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  WORK="$(mktemp -d)"
  git -C "$WORK" init -q
  mkdir "$WORK/docs"
  printf 'docs/changelog.md\n' >"$WORK/.gitignore"
  printf 'This is seamless and genuine.\n' >"$WORK/docs/changelog.md"
  printf '# Index\n' >"$WORK/docs/index.md"
}

teardown() {
  rm -rf "$WORK"
}

@test "dropGitIgnored removes the ignored generated changelog from a docs listing" {
  run bun -e "
    import { dropGitIgnored } from '$REPO_ROOT/scripts/lib/gitIgnored';
    console.log(JSON.stringify(dropGitIgnored('$WORK', ['docs/changelog.md', 'docs/index.md'])));
  "
  [ "$status" -eq 0 ]
  [ "$output" = '["docs/index.md"]' ]
}

@test "banned-phrase check passes when the only offending docs file is ignored" {
  cd "$REPO_ROOT"
  local ignored=0
  if [ ! -e docs/changelog.md ]; then
    printf 'This is seamless and genuine.\n' >docs/changelog.md
    ignored=1
  fi
  run bun scripts/docs/check-banned-phrases.ts
  if [ "$ignored" -eq 1 ]; then rm -f docs/changelog.md; fi
  [ "$status" -eq 0 ]
}
