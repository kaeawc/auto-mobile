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
# github.com `issues/*` links are deliberately NOT excluded: they are legitimate
# references we want validated, routed through the authenticated GitHub API
# (GITHUB_TOKEN, #5405) rather than throttled HTTP scraping; the backoff above is
# the correct lever for their transient timeouts.
#
# TOML is parsed with yq (the repo's canonical config/workflow parser), not
# grepped, so a value in a comment cannot satisfy these assertions. The
# behavioral exclusion check drives the real lychee binary; the bats CI job does
# not install lychee, so that test skips there and runs in local pre-PR
# validation where lychee is present.

CONFIG=".lycherc.toml"

requires_yq() {
  command -v yq >/dev/null 2>&1 && return 0
  if [[ -n "${CI:-}" ]]; then
    echo "yq is required in CI to verify .lycherc.toml hardening" >&2
    return 1
  fi
  skip "yq not installed"
}

requires_lychee() {
  command -v lychee >/dev/null 2>&1 && return 0
  # The bats CI job does not install lychee (only the dedicated doc-links job
  # does), so skip rather than fail when the binary is absent.
  skip "lychee not installed"
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
  requires_lychee

  local fixture
  # Plain mktemp (no -t template) for GNU/BSD portability; lychee parses markdown
  # link syntax from the file content, so no .md extension is required.
  fixture="$(mktemp)"
  cat > "$fixture" <<'EOF'
# fixture
[faq](https://www.contributor-covenant.org/faq)
[root](https://www.contributor-covenant.org/)
[issue](https://github.com/kaeawc/auto-mobile/issues/50)
EOF

  # `--dump` extracts and filters links through the config WITHOUT hitting the
  # network, so this is fast and deterministic.
  run lychee --config "$CONFIG" --dump "$fixture"
  rm -f "$fixture"

  [ "$status" -eq 0 ]
  # The connection-reset URL from the flake must now be excluded.
  [[ "$output" != *"contributor-covenant.org/faq"* ]]
  # Sanity: github issue links are still checked (not over-excluded), so we keep
  # validating real references.
  [[ "$output" == *"github.com/kaeawc/auto-mobile/issues/50"* ]]
}
