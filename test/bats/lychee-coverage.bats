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
# parser) so they run in the BATS lane, which does not install lychee. The one
# behavioral test needs the lychee binary and skips without it.

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
