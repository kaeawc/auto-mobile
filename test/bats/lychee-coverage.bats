#!/usr/bin/env bats
#
# Regression guard for the documentation link check's blind spots. The
# "Validate Documentation Links" job stayed green on `main` while real links
# were broken, because lychee never looked at them:
#   - `#fragment` anchors were not verified (README -> ui-tests.md
#     `#ios--swift-package-manager`, CONTRIBUTING -> `#design-principles`);
#   - links inside MkDocs content tabs are indented four spaces, which
#     CommonMark parses as a code block, and lychee skips verbatim blocks by
#     default (install GIF, desktop downloads, agent-example GIFs);
#   - the redirect shims were excluded outright, so the a11y shim's
#     `#accessibility-workflows` target (really `#5-accessibility-workflows`)
#     was never checked, and nothing ever checked the built site;
#   - the site's Contributing page is copied from .github/CONTRIBUTING.md at
#     deploy time, but the job validated an empty `touch`ed stub instead;
#   - unanchored `exclude_path` regexes (`site/`) matched any path containing
#     that substring.
#
# Config-level assertions parse TOML/YAML with yq (the repo's canonical
# parser) so they run in the `bats-tests` lane, which does not install lychee;
# the separate `fast-validation` job does. The behavioral tests need the
# lychee binary and skip without it.

CONFIG=".lycherc.toml"
SCRIPT="scripts/lychee/validate_lychee.sh"
MERGE_WORKFLOW=".github/workflows/merge.yml"

requires_yq() {
  command -v yq >/dev/null 2>&1 && return 0
  if [[ -n "${CI:-}" ]]; then
    echo "yq is required in CI to verify lychee coverage" >&2
    return 1
  fi
  skip "yq not installed"
}

@test "lychee checks links inside verbatim blocks (MkDocs content tabs)" {
  requires_yq
  run yq -p toml -o json '.include_verbatim' "$CONFIG"
  [ "$status" -eq 0 ]
  [ "$output" = "true" ]
}

@test "include_fragments is passed as a CLI flag, not a version-specific config key" {
  requires_yq
  # The key is a bool in lychee 0.22 (CI pin) and an enum string in 0.24+, so
  # any value in the config fails to load under one of them.
  run yq -p toml -o json 'has("include_fragments")' "$CONFIG"
  [ "$status" -eq 0 ]
  [ "$output" = "false" ]
  grep -Eq -- 'lychee --config "\$LYCHEE_CONFIG" [^#]*--include-fragments' "$SCRIPT"
}

@test "every exclude_path regex is anchored" {
  requires_yq
  run yq -p toml -oy '.exclude_path[]' "$CONFIG"
  [ "$status" -eq 0 ]
  [ -n "$output" ]
  while IFS= read -r pattern; do
    [[ "$pattern" == ^* || "$pattern" == "(^|/)"* ]] || {
      echo "unanchored exclude_path pattern: $pattern" >&2
      return 1
    }
  done <<<"$output"
}

@test "validate_lychee.sh checks .github/CONTRIBUTING.md and the built site" {
  grep -Fq '".github/CONTRIBUTING.md"' "$SCRIPT"
  # Stage every page deploy_pages.py copies in, so none is built unchecked.
  grep -Fq 'docs/contributing.md:.github/CONTRIBUTING.md' "$SCRIPT"
  grep -Fq 'docs/changelog.md:CHANGELOG.md' "$SCRIPT"
  grep -Fq -- '--index-files index.html' "$SCRIPT"
  grep -Fq 'LYCHEE_REQUIRE_SITE' "$SCRIPT"
}

@test "merge workflow requires the built-site pass and drops the empty contributing stub" {
  requires_yq
  run yq -r '.jobs["validate-documentation-links"].steps[] | select(.name == "Validate Links") | .env.LYCHEE_REQUIRE_SITE' "$MERGE_WORKFLOW"
  [ "$status" -eq 0 ]
  [ "$output" = "true" ]
  run yq -r '.jobs["validate-documentation-links"].steps[].run // ""' "$MERGE_WORKFLOW"
  [ "$status" -eq 0 ]
  [[ "$output" != *"touch docs/contributing.md"* ]]
}

@test "reserved example.com subdomains are excluded (include_verbatim samples)" {
  command -v lychee >/dev/null 2>&1 || skip "lychee not installed"
  dir="$BATS_TEST_TMPDIR/docs"
  mkdir -p "$dir"
  # A fenced code sample citing an illustrative subdomain host, like
  # docs/webrtc-streaming.md's mediamtx.example.com. It must not be dialed.
  printf '# S\n\n```\ncurl https://mediamtx.example.com:8889/whip\n```\n' >"$dir/s.md"
  run lychee --config "$CONFIG" --no-progress --include-verbatim --dump "$dir/s.md"
  [ "$status" -eq 0 ]
  [[ "$output" != *"example.com"* ]]
}

@test "lychee flags a missing #fragment under the repo config" {
  command -v lychee >/dev/null 2>&1 || skip "lychee not installed"
  dir="$BATS_TEST_TMPDIR/docs"
  mkdir -p "$dir"
  printf '# Target\n\n## Real heading\n' >"$dir/target.md"
  printf '[ok](target.md#real-heading)\n\n[broken](target.md#missing-heading)\n' >"$dir/source.md"

  run lychee --config "$CONFIG" --no-progress --offline --include-fragments "$dir/source.md"
  [ "$status" -eq 2 ]
  [[ "$output" == *"missing-heading"* ]]
  [[ "$output" != *"#real-heading"*"Cannot find fragment"* ]]
}

@test "lychee-offline check is registered in all_fast_validate_checks.sh" {
  local checks="scripts/all_fast_validate_checks.sh"
  grep -Fq 'add_check "lychee-offline"' "$checks"
  grep -Fq -- '--offline' <(grep 'add_check "lychee-offline"' "$checks")
  grep -Fq 'LYCHEE_REQUIRE_SITE=true' <(grep 'add_check "lychee-offline"' "$checks")
}

@test "pull_request.yml runs lychee-offline in its own step, not fanned out with the docs-globbing checks" {
  requires_yq
  local workflow=".github/workflows/pull_request.yml"
  run yq -r '.jobs["fast-validation"].steps[] | select(.name == "Run offline lychee link check") | .run' "$workflow"
  [ "$status" -eq 0 ]
  [ "$output" = 'scripts/all_fast_validate_checks.sh --only lychee-offline' ]
  run yq -r '.jobs["fast-validation"].steps[] | select(.name == "Run offline lychee link check") | .background // false' "$workflow"
  [ "$status" -eq 0 ]
  [ "$output" = "false" ]
  # The docs-globbing checks must not share lychee-offline's --only invocation.
  run grep -- '--only lychee-offline' "$workflow"
  [ "$status" -eq 0 ]
  [[ "$output" != *"mkdocs-nav"* ]]
  [[ "$output" != *"docs-github-markdown"* ]]
}

@test "install-fast-validation-deps.sh installs lychee" {
  grep -Fq 'install_lychee.sh' "scripts/ci/install-fast-validation-deps.sh"
}

# --- own-repo blob/main + tree/main links are verified offline, not fetched ---

OWN_LINKS="scripts/lychee/check_own_repo_links.sh"
OWN_P="https://github.com/kaeawc/auto-mobile"

own_repo_fixture() {
  mkdir -p "$BATS_TEST_TMPDIR/repo/src/dir" "$BATS_TEST_TMPDIR/repo/docs"
  printf 'one\ntwo\nthree\n' >"$BATS_TEST_TMPDIR/repo/src/a.txt"
}

@test "own-repo links: existing file, directory and in-range line anchor pass" {
  own_repo_fixture
  printf '[f](%s/blob/main/src/a.txt) [d](%s/tree/main/src/dir) [l](%s/blob/main/src/a.txt#L2-L3)\n' "$OWN_P" "$OWN_P" "$OWN_P" >"$BATS_TEST_TMPDIR/repo/docs/ok.md"
  OWN_REPO_ROOT="$BATS_TEST_TMPDIR/repo" run "$OWN_LINKS" "$BATS_TEST_TMPDIR/repo/docs/ok.md"
  [ "$status" -eq 0 ]
  [[ "$output" == *"checked offline: 3, dead: 0"* ]]
}

@test "own-repo links: a dead file link fails" {
  own_repo_fixture
  printf '[x](%s/blob/main/src/gone.txt).\n' "$OWN_P" >"$BATS_TEST_TMPDIR/repo/docs/dead.md"
  OWN_REPO_ROOT="$BATS_TEST_TMPDIR/repo" run "$OWN_LINKS" "$BATS_TEST_TMPDIR/repo/docs/dead.md"
  [ "$status" -eq 2 ]
  [[ "$output" == *"[DEAD]"*"src/gone.txt"*"file not found"* ]]
}

@test "own-repo links: a tree link to a file and a blob link to a directory fail" {
  own_repo_fixture
  printf '[a](%s/tree/main/src/a.txt)\n[b](%s/blob/main/src/dir)\n' "$OWN_P" "$OWN_P" >"$BATS_TEST_TMPDIR/repo/docs/kind.md"
  OWN_REPO_ROOT="$BATS_TEST_TMPDIR/repo" run "$OWN_LINKS" "$BATS_TEST_TMPDIR/repo/docs/kind.md"
  [ "$status" -eq 2 ]
  [[ "$output" == *"dead: 2"* ]]
}

@test "own-repo links: a line anchor past EOF fails" {
  own_repo_fixture
  printf '[x](%s/blob/main/src/a.txt#L4)\n' "$OWN_P" >"$BATS_TEST_TMPDIR/repo/docs/eof.md"
  OWN_REPO_ROOT="$BATS_TEST_TMPDIR/repo" run "$OWN_LINKS" "$BATS_TEST_TMPDIR/repo/docs/eof.md"
  [ "$status" -eq 2 ]
  [[ "$output" == *"past EOF (3 lines)"* ]]
}

@test "own-repo links: .lycherc.toml excludes the shape and validate_lychee.sh runs the script" {
  requires_yq
  run yq -p toml -oy '.exclude[] | select(test("kaeawc/auto-mobile/") and test("blob"))' "$CONFIG"
  [ "$status" -eq 0 ]
  [[ "$OWN_P/blob/main/a/b.kt#L3" =~ $output ]]
  [[ "$OWN_P/tree/main/a" =~ $output ]]
  [[ ! "https://github.com/other/repo/blob/main/a" =~ $output ]]
  grep -Fq 'check_own_repo_links.sh' "$SCRIPT"
}

@test "504 Gateway Timeout is accepted for external links" {
  requires_yq
  run yq -p toml -oy '.accept[] | select(. == "504")' "$CONFIG"
  [ "$status" -eq 0 ]
  [ "$output" = "504" ]
}
