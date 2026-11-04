# Shared guard for bats files that parse workflow YAML or TOML with yq.
#
# The assertions use mikefarah yq v4 syntax (-o, -p, -oy, `//`). python-yq
# (the jq wrapper, which reports `yq 0.0.0`) passes those flags to jq and fails
# with `jq: Unknown option`, so a bare `command -v yq` is not enough: a dev
# machine with python-yq would report false failures instead of skipping.
#
# Outside CI a missing or non-mikefarah yq skips the test. In CI it fails, so a
# runner image that loses mikefarah yq cannot silently retire the wiring
# assertions. Uses only shell builtins so tests can run it with a stub-only PATH.

# Succeeds when `yq` on PATH is mikefarah yq v4. Its --version line reads
# "yq (https://github.com/mikefarah/yq/) version v4.44.3" (older v4 releases
# omit the leading "v").
is_mikefarah_yq_v4() {
  local version_line=""
  read -r version_line < <(yq --version 2>&1) || [[ -n "${version_line}" ]] || return 1
  [[ "${version_line}" == *mikefarah* && "${version_line}" =~ version\ v?4\. ]]
}

require_mikefarah_yq() {
  local reason version_line=""
  if ! command -v yq >/dev/null 2>&1; then
    reason="yq is not installed"
  elif ! is_mikefarah_yq_v4; then
    read -r version_line < <(yq --version 2>&1) || true
    reason="yq on PATH is not mikefarah yq v4 (reports: ${version_line:-nothing})"
  else
    return 0
  fi
  if [[ -n "${CI:-}" ]]; then
    echo "mikefarah yq v4 is required in CI for ${BATS_TEST_FILENAME##*/}: ${reason}" >&2
    return 1
  fi
  skip "requires mikefarah yq v4: ${reason}"
}
