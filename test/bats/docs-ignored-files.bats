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
  CHANGELOG="$REPO_ROOT/docs/changelog.md"
  CHANGELOG_BACKUP="$WORK/changelog.backup"
  CHANGELOG_INSTALLED=0
}

teardown() {
  # Restore a developer's generated changelog even when the test fails (#18662).
  if [ "$CHANGELOG_INSTALLED" -eq 1 ]; then
    if [ -e "$CHANGELOG_BACKUP" ]; then
      mv -f "$CHANGELOG_BACKUP" "$CHANGELOG"
    else
      rm -f "$CHANGELOG"
    fi
  fi
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
  # Always install the offending content, so a clean existing changelog cannot mask a
  # banned-phrase check that stops dropping ignored files (#18662).
  if [ -e "$CHANGELOG" ]; then
    cp -p "$CHANGELOG" "$CHANGELOG_BACKUP"
  fi
  CHANGELOG_INSTALLED=1
  printf 'This is seamless and genuine.\n' >"$CHANGELOG"
  run bun scripts/docs/check-banned-phrases.ts
  [ "$status" -eq 0 ]
}
