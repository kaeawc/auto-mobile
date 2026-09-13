#!/usr/bin/env bash
# Render and push the Homebrew formula for the current release to the
# kaeawc/homebrew-tap repository.
#
# Required env:
#   TAG       Release tag (e.g. v0.1.0)
#   REPO      Source repo, owner/name (e.g. kaeawc/auto-mobile)
#
# Optional env:
#   GH_TOKEN       PAT with Contents:Write on kaeawc/homebrew-tap. When unset,
#                  the publish is skipped cleanly (exit 0) so this optional
#                  channel does not block the rest of the release.
#   RENDER_ONLY=1  Write the rendered formula to ./auto-mobile.rb in the
#                  current directory and exit without git operations. Used
#                  by tests; in CI the unset default does the full publish.
#   BREW_NPM_PROPAGATION_ATTEMPTS / _DELAY_SECONDS / _MAX_DELAY_SECONDS
#                  Bound on the wait for npm to start serving this version
#                  (default 10 attempts, 5s initial delay doubling to a 60s
#                  cap ~= 6 min). Exceeding it warns and falls through to the
#                  tarball fetch below.
#
# Resolves the published npm tarball SHA256 from the registry; the npm
# publish step must run before this script.

set -euo pipefail

: "${TAG:?TAG is required}"
: "${REPO:?REPO is required}"

# Homebrew publishing is an optional release channel. The tap token
# (HOMEBREW_TAP_TOKEN -> GH_TOKEN) is not always configured, in which case there
# is nowhere to push the formula. Skip cleanly rather than hard-failing, so a
# missing optional channel does not block the rest of the release (Maven
# Central, Docker, and the GitHub Release all run after this step). RENDER_ONLY
# (tests) never pushes, so it does not need the token. When the token IS set,
# any clone/push failure below still fails the step under `set -e`.
if [[ "${RENDER_ONLY:-0}" != "1" && -z "${GH_TOKEN:-}" ]]; then
  # REQUIRE_TOKEN=1 (set by the release workflow's publish step) turns the
  # historically-silent skip into a loud failure. The silent skip is what let
  # the Homebrew channel no-op unnoticed across every release when the tap
  # token was never configured: the step "passed" while the formula never
  # landed. On a real tagged release a missing/expired token is a defect we
  # want surfaced, not swallowed. Pair this with `continue-on-error: true` on
  # the workflow step so the failure shows red without blocking the other
  # release channels (Maven, npm, GitHub Release) that run alongside it.
  if [[ "${REQUIRE_TOKEN:-0}" == "1" ]]; then
    echo "ERROR: GH_TOKEN (HOMEBREW_TAP_TOKEN) is not set but REQUIRE_TOKEN=1; refusing to silently skip the Homebrew formula publish." >&2
    exit 1
  fi
  echo "GH_TOKEN (HOMEBREW_TAP_TOKEN) is not set; skipping Homebrew formula publish." >&2
  exit 0
fi

VERSION="${TAG#v}"
PKG="@kaeawc/auto-mobile"
TARBALL_URL="https://registry.npmjs.org/${PKG}/-/auto-mobile-${VERSION}.tgz"
# The registry's own statement that this version exists. `npm publish` returns
# before the version is served, so this document is the thing to wait on: the
# tarball URL only ever 404s until the version is published, and a 404 there is
# indistinguishable from a release that will never appear.
VERSION_DOC_URL="https://registry.npmjs.org/@kaeawc%2fauto-mobile/${VERSION}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Pull the just-published tarball and compute its sha256. Retries cover the
# window where the npm CDN hasn't propagated the new version yet immediately
# after `npm publish`. The previous budget (10 x 6s ~= 1 min) was too tight:
# npm publish returns before the tarball is fetchable at the registry URL, and
# propagation has been observed to take several minutes, 404ing the whole
# release (run 30568093771). Widen to ~5 min so a slow-but-normal publish does
# not fail the release; genuine failures still surface, just later.
max_attempts="${BREW_TARBALL_FETCH_ATTEMPTS:-30}"
retry_delay="${BREW_TARBALL_FETCH_DELAY_SECONDS:-10}"
# Reject non-base-10 / zero-padded overrides up front. A value like "08" is an
# invalid octal in bash arithmetic, so the `-ge` comparison below errors; because
# that comparison is the `while` loop's condition, `set -e` does not fire and the
# error is swallowed, turning the attempt cap into an infinite loop. Validate
# here as scripts/ci/run-gradle-with-retry.sh does.
if ! [[ "$max_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid BREW_TARBALL_FETCH_ATTEMPTS='${max_attempts}' (want a positive base-10 integer)" >&2
  exit 1
fi
if ! [[ "$retry_delay" =~ ^[0-9]+$ ]]; then
  echo "Invalid BREW_TARBALL_FETCH_DELAY_SECONDS='${retry_delay}' (want a non-negative base-10 integer)" >&2
  exit 1
fi

# --- npm publish/propagation wait -------------------------------------------
# Release 0.0.69 went red here: the Homebrew job started while npm had accepted
# the publish but was not yet serving the version, so every tarball attempt
# 404'd, the 30x10s budget drained, and the release failed on a race that had
# resolved itself minutes later (issue #6810). Poll the *version document*
# first, with exponential backoff, so slow-but-normal propagation is waited out
# on cheap requests instead of eating the tarball budget.
npm_propagation_attempts="${BREW_NPM_PROPAGATION_ATTEMPTS:-10}"
npm_propagation_delay="${BREW_NPM_PROPAGATION_DELAY_SECONDS:-5}"
npm_propagation_max_delay="${BREW_NPM_PROPAGATION_MAX_DELAY_SECONDS:-60}"
# Same zero-padded/non-decimal guard as the tarball knobs above: an invalid
# octal literal in a `while` condition is swallowed by `set -e` and turns the
# bound into an unbounded loop.
if ! [[ "$npm_propagation_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid BREW_NPM_PROPAGATION_ATTEMPTS='${npm_propagation_attempts}' (want a positive base-10 integer)" >&2
  exit 1
fi
if ! [[ "$npm_propagation_delay" =~ ^(0|[1-9][0-9]*)$ ]]; then
  echo "Invalid BREW_NPM_PROPAGATION_DELAY_SECONDS='${npm_propagation_delay}' (want a non-negative base-10 integer)" >&2
  exit 1
fi
if ! [[ "$npm_propagation_max_delay" =~ ^(0|[1-9][0-9]*)$ ]]; then
  echo "Invalid BREW_NPM_PROPAGATION_MAX_DELAY_SECONDS='${npm_propagation_max_delay}' (want a non-negative base-10 integer)" >&2
  exit 1
fi

wait_for_npm_propagation() {
  local attempt=1
  local delay="$npm_propagation_delay"

  while ! curl -fsS "$VERSION_DOC_URL" -o /dev/null; do
    if [[ "$attempt" -ge "$npm_propagation_attempts" ]]; then
      # Bounded on purpose, and deliberately non-fatal: the tarball fetch below
      # owns the definitive error for "this version is not on npm", so warn and
      # let it speak rather than inventing a second hard failure mode.
      echo "WARNING: ${PKG}@${VERSION} is still not visible in the npm registry after ${attempt} attempts; trying the tarball anyway" >&2
      return 0
    fi
    echo "npm has not published ${PKG}@${VERSION} yet, retrying in ${delay}s (attempt ${attempt}/${npm_propagation_attempts})" >&2
    attempt=$((attempt + 1))
    sleep "$delay"
    delay=$((delay * 2))
    if [[ "$delay" -gt "$npm_propagation_max_delay" ]]; then
      delay="$npm_propagation_max_delay"
    fi
  done

  echo "npm registry serves ${PKG}@${VERSION}; fetching the tarball." >&2
}

wait_for_npm_propagation

attempt=1
while ! curl -fsSL "$TARBALL_URL" -o "$tmp/auto-mobile.tgz"; do
  if [[ "$attempt" -ge "$max_attempts" ]]; then
    echo "ERROR: failed to fetch ${TARBALL_URL} after ${attempt} attempts" >&2
    exit 1
  fi
  echo "tarball not yet available, retrying in ${retry_delay}s (attempt ${attempt}/${max_attempts})" >&2
  attempt=$((attempt + 1))
  sleep "$retry_delay"
done

SHA="$(shasum -a 256 "$tmp/auto-mobile.tgz" | awk '{print $1}')"

render_formula() {
  cat <<EOF
class AutoMobile < Formula
  desc "Mobile device interaction automation via MCP"
  homepage "https://github.com/${REPO}"
  url "${TARBALL_URL}"
  sha256 "${SHA}"
  license "Apache-2.0"

  # Track new releases from the npm registry's dist-tags. \`brew livecheck\`
  # (and Homebrew's autobump tooling) reads this to detect that a newer
  # version than the pinned \`url\` is available.
  livecheck do
    url "https://registry.npmjs.org/${PKG}"
    strategy :json do |json|
      json.dig("dist-tags", "latest")
    end
  end

  depends_on "bun"

  def install
    libexec.install Dir["*"]
    (bin/"auto-mobile").write <<~SH
      #!/bin/bash
      exec "#{formula_opt_bin("bun")}/bun" "#{libexec}/dist/src/index.js" "\$@"
    SH
    chmod 0755, bin/"auto-mobile"
  end

  test do
    output = shell_output("#{bin}/auto-mobile --cli help 2>&1")
    assert_match(/Usage|help|tool/i, output)
  end
end
EOF
}

if [[ "${RENDER_ONLY:-0}" == "1" ]]; then
  render_formula > auto-mobile.rb
  echo "Rendered auto-mobile.rb (RENDER_ONLY)"
  exit 0
fi

# GH_TOKEN presence is enforced early (see the skip guard near the top); a
# non-RENDER_ONLY run reaches here only when the token is set.
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$tmp" "$WORKDIR"' EXIT
cd "$WORKDIR"

git clone "https://x-access-token:${GH_TOKEN}@github.com/kaeawc/homebrew-tap.git" .
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

mkdir -p Formula
render_formula > Formula/auto-mobile.rb

git add Formula/auto-mobile.rb
if git diff --cached --quiet; then
  echo "no changes to brew formula"
  exit 0
fi
git commit -m "auto-mobile ${TAG}"
git push origin HEAD
