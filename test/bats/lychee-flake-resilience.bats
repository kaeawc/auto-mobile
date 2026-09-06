#!/usr/bin/env bats
#
# Regression guard for #5622: the "Validate Documentation Links" (lychee) job
# reddened `main` on `On Merge` from purely transient network failures — 10
# timeouts against github.com's own `issues/*` URLs and a "Connection reset by
# server" against https://www.contributor-covenant.org/faq — not real broken
# links.
#
# This pins the `.lycherc.toml` hardening so the flake signature cannot recur
# silently:
#   - a retry backoff (`retry_wait_time`) so a rate-limited/slow endpoint is
#     re-tried after a wait instead of hammered and failed immediately, plus a
#     roomier per-request `timeout` for the slow responses that stalled the run;
#   - a contributor-covenant.org exclusion that covers *all* paths under that
#     host (the prior narrow `/?$` + `/translations/?$` patterns let `/faq`
#     through, which is exactly the URL that reset the connection).
#
# #5622 recurred TWICE after the retry/backoff hardening above landed (runs
# 33010560252 and 33032939183) — both still exited 2 with 20 [TIMEOUT]s, 0 real
# errors, 100% against self-referential `github.com/kaeawc/auto-mobile/issues/*`
# and `pull/*` links (GITHUB_TOKEN routing, #5405, was already in effect too).
# Client-side retries cannot outrun GitHub's own rate limit under bulk lookups,
# so those self-referential links (we created the issue/PR, so the link is
# guaranteed valid) are now excluded from network validation entirely. Links to
# OTHER repos' issues/PRs are unaffected and still checked.
#
# TOML is parsed with yq (the repo's canonical config/workflow parser), not
# grepped, so a value in a comment cannot satisfy these assertions. All
# assertions here are config-level (parsing `.lycherc.toml` with yq) rather
# than invoking the real `lychee` binary: the required BATS lane in
# `pull_request.yml` does not install lychee, and a test gated behind
# "skip if lychee is missing" never actually runs there — it would guard
# nothing pre-merge (the exact gap this test exists to close). yq ships on
# the GitHub-hosted macOS runner image the BATS lane uses, so no new install
# step is needed.

CONFIG=".lycherc.toml"

requires_yq() {
  command -v yq >/dev/null 2>&1 && return 0
  if [[ -n "${CI:-}" ]]; then
    echo "yq is required in CI to verify .lycherc.toml hardening" >&2
    return 1
  fi
  skip "yq not installed"
}

# Extracts the single exclude pattern that mentions kaeawc/auto-mobile, as a
# raw (non-JSON-escaped) string usable directly as a bash =~ regex.
self_referential_exclude_pattern() {
  yq -p toml -oy '.exclude[] | select(test("kaeawc/auto-mobile"))' "$CONFIG"
}

@test "lychee retries failed requests with a backoff (retry_wait_time)" {
  requires_yq
  run yq -p toml -o json '.retry_wait_time' "$CONFIG"
  [ "$status" -eq 0 ]
  # Must be a positive number: retrying immediately (no wait) against a
  # rate-limited endpoint is what let the timeouts fail the run.
  [[ "$output" =~ ^[0-9]+$ ]]
  [ "$output" -gt 0 ]
}

@test "lychee allows a roomier per-request timeout for slow responses" {
  requires_yq
  run yq -p toml -o json '.timeout' "$CONFIG"
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^[0-9]+$ ]]
  # The stalled requests in run 32703978446 needed more headroom than the prior
  # 20s ceiling.
  [ "$output" -ge 30 ]
}

@test "contributor-covenant.org is excluded for all paths, not just the root" {
  requires_yq
  run yq -p toml -o json '.exclude[] | select(test("contributor-covenant"))' "$CONFIG"
  [ "$status" -eq 0 ]
  [ -n "$output" ]
  # Must cover the whole host, not the old narrow `/?$` + `/translations/?$`
  # patterns that let `/faq` (the URL that reset the connection) through.
  [[ "$output" == *'contributor-covenant\\.org/"'* ]]
}

@test "self-referential auto-mobile issue/pull exclude pattern is present in .lycherc.toml" {
  requires_yq
  run self_referential_exclude_pattern
  [ "$status" -eq 0 ]
  # Exactly one exclude entry mentions kaeawc/auto-mobile, and it covers both
  # issues and pull, any number, on github.com/kaeawc/auto-mobile specifically.
  [ "$output" = '^https://github\.com/kaeawc/auto-mobile/(issues|pull)/[0-9]+' ]

  # It must match our own repo's issue/pull links (the guaranteed-valid,
  # self-referential links #5622 recurred against)...
  local own_issue="https://github.com/kaeawc/auto-mobile/issues/50"
  local own_pr="https://github.com/kaeawc/auto-mobile/pull/6000"
  [[ "$own_issue" =~ $output ]]
  [[ "$own_pr" =~ $output ]]
}

@test "self-referential exclude pattern does not over-exclude other repos' issue/pull links" {
  requires_yq
  run self_referential_exclude_pattern
  [ "$status" -eq 0 ]
  local pattern="$output"

  # A different repo's issue/PR link must still be checked (not swallowed by
  # an over-broad pattern) — otherwise this exclusion would silently stop
  # validating real, non-self-referential references.
  local other_repo_issue="https://github.com/lycheeverse/lychee/issues/50"
  local other_repo_pr="https://github.com/lycheeverse/lychee/pull/50"
  [[ ! "$other_repo_issue" =~ $pattern ]]
  [[ ! "$other_repo_pr" =~ $pattern ]]

  # A lookalike repo name sharing the "auto-mobile" prefix must not slip
  # through either — the pattern is scoped to the exact
  # kaeawc/auto-mobile path segment, not a prefix match.
  local lookalike="https://github.com/kaeawc/auto-mobile-extra/issues/50"
  [[ ! "$lookalike" =~ $pattern ]]
}
