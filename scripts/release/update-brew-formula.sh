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
  echo "GH_TOKEN (HOMEBREW_TAP_TOKEN) is not set; skipping Homebrew formula publish." >&2
  exit 0
fi

VERSION="${TAG#v}"
PKG="@kaeawc/auto-mobile"
TARBALL_URL="https://registry.npmjs.org/${PKG}/-/auto-mobile-${VERSION}.tgz"

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

  depends_on "bun"

  def install
    libexec.install Dir["*"]
    (bin/"auto-mobile").write <<~SH
      #!/bin/bash
      exec "#{Formula["bun"].opt_bin}/bun" "#{libexec}/dist/src/index.js" "\$@"
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
