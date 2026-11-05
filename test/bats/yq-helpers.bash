# Shared guard for bats files that parse workflow YAML or TOML with yq.
#
# The assertions use mikefarah yq v4 syntax (-o, -p, -oy, `//`). python-yq
# (the jq wrapper, which reports `yq 0.0.0`) passes those flags to jq and fails
# with `jq: Unknown option`, so a bare `command -v yq` is not enough: a dev
# machine with python-yq would report false failures instead of skipping.
#
# mikefarah releases before v4.49.1 keep "\t" in a double-quoted expression
# string as a backslash and a `t` (mikefarah/yq#2506), so assertions that join
# fields with "\t" fail on them. The guard treats those releases as missing.
#
# On a CI runner a missing or unsupported yq fails, so a runner image that loses
# mikefarah yq cannot silently retire the wiring assertions. Everywhere else it
# skips. Uses only shell builtins so tests can run it with a stub-only PATH.

YQ_MIN_MINOR=49
YQ_MIN_PATCH=1
YQ_MIN_VERSION="v4.${YQ_MIN_MINOR}.${YQ_MIN_PATCH}"

# Succeeds when a missing tool must fail the test instead of skipping it.
# GitHub Actions and CircleCI always fail closed. Any other environment that
# sets CI fails closed too, except the Claude Code cloud dev container, which
# exports CI=true to every command but is a developer machine (#16949).
yq_guard_fails_closed() {
  [[ "${GITHUB_ACTIONS:-}" == "true" || "${CIRCLECI:-}" == "true" ]] && return 0
  [[ -n "${CI:-}" && "${CLAUDE_CODE_REMOTE:-}" != "true" ]]
}

# Fails a test on a CI runner, skips it elsewhere. $1 is the reason.
yq_guard_unavailable() {
  if yq_guard_fails_closed; then
    echo "mikefarah yq ${YQ_MIN_VERSION} or newer is required in CI for ${BATS_TEST_FILENAME##*/}: $1" >&2
    return 1
  fi
  skip "requires mikefarah yq ${YQ_MIN_VERSION} or newer: $1"
}

# Prints why `yq` on PATH is unsupported, or nothing when it is mikefarah yq
# v4.49.1 or a newer v4. Its --version line reads
# "yq (https://github.com/mikefarah/yq/) version v4.54.1" (old v4 releases omit
# the leading "v").
yq_unsupported_reason() {
  local version_line="" minor patch
  if ! command -v yq >/dev/null 2>&1; then
    echo "yq is not installed"
    return 0
  fi
  read -r version_line < <(yq --version 2>&1) || true
  if [[ "${version_line}" != *mikefarah* || ! "${version_line}" =~ version\ v?4\.([0-9]+)\.([0-9]+) ]]; then
    echo "yq on PATH is not mikefarah yq v4 (reports: ${version_line:-nothing})"
    return 0
  fi
  minor=$((10#${BASH_REMATCH[1]}))
  patch=$((10#${BASH_REMATCH[2]}))
  if ((minor < YQ_MIN_MINOR || (minor == YQ_MIN_MINOR && patch < YQ_MIN_PATCH))); then
    echo "mikefarah yq on PATH is older than ${YQ_MIN_VERSION} (reports: ${version_line})"
  fi
}

require_mikefarah_yq() {
  local reason
  reason="$(yq_unsupported_reason)"
  [[ -z "${reason}" ]] && return 0
  yq_guard_unavailable "${reason}"
}
