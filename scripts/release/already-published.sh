#!/usr/bin/env bash
#
# Answer whether a release target already has <version> published.
#
# release.yml publishes to six targets in one sequential job, and `npm publish`
# is not idempotent. A failure late in that sequence leaves the run unrepeatable:
# the rerun dies on the first already-published target instead of resuming past
# it. Each guarded step consults this script and skips what is already done.
#
# Usage:
#   already-published.sh <npm|maven|mcp> <version>
#
# Prints "published" or "missing" on stdout.
#
# Exits non-zero when it cannot determine the answer -- an unreachable registry,
# an unexpected status, or a partially-published Maven coordinate set. Failing
# closed is deliberate. A guard that answered "missing" on error would republish
# over a good release; one that answered "published" on error would silently skip
# a real publish, which is precisely the fail-green shape this pipeline is being
# fixed to remove. An unclear answer is a human's problem, not a default's.
#
# Homebrew and the GitHub Release are deliberately absent: update-brew-formula.sh
# already exits early when the rendered formula is unchanged, and
# action-gh-release updates an existing release rather than failing on one.

set -euo pipefail

NPM_PACKAGE="@kaeawc/auto-mobile"
MAVEN_GROUP_PATH="dev/jasonpearson/auto-mobile"
MAVEN_ARTIFACTS=(
  auto-mobile-protocol
  auto-mobile-test-plan-validation
  auto-mobile-junit-runner
  auto-mobile-sdk
)
MCP_SERVER_NAME="dev.jasonpearson/auto-mobile"

# Overridable so the BATS suite can point at a stub instead of the real registry.
MAVEN_BASE_URL="${MAVEN_BASE_URL:-https://repo1.maven.org/maven2}"
MCP_REGISTRY_URL="${MCP_REGISTRY_URL:-https://registry.modelcontextprotocol.io}"

usage() {
  echo "usage: $(basename "$0") <npm|maven|mcp> <version>" >&2
}

check_npm() {
  local version="$1" out
  if out=$(npm view "${NPM_PACKAGE}@${version}" version 2>&1); then
    # A hit prints the version; an empty body means npm resolved nothing.
    if [[ -n "$out" ]]; then
      echo published
    else
      echo missing
    fi
    return 0
  fi

  if printf '%s\n' "$out" | grep -q '404'; then
    echo missing
    return 0
  fi

  echo "ERROR: npm view failed for ${NPM_PACKAGE}@${version}: ${out}" >&2
  return 1
}

check_maven() {
  local version="$1" artifact url code
  local found=0 absent=0
  local total="${#MAVEN_ARTIFACTS[@]}"

  for artifact in "${MAVEN_ARTIFACTS[@]}"; do
    url="${MAVEN_BASE_URL}/${MAVEN_GROUP_PATH}/${artifact}/${version}/${artifact}-${version}.pom"
    # No -f, deliberately. This is a status probe, not a download: the body goes
    # to /dev/null and a 404 is the meaningful "not published yet" answer. -f
    # exits non-zero on 404, which would turn that into a fail-closed error and
    # make every first-time publish look like an unreachable registry.
    if ! code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 --retry 3 "$url" 2>/dev/null); then # portability-ok
      echo "ERROR: could not reach Maven Central for ${artifact}" >&2
      return 1
    fi
    case "$code" in
      200) found=$((found + 1)) ;;
      404) absent=$((absent + 1)) ;;
      *)
        echo "ERROR: unexpected HTTP ${code} for ${url}" >&2
        return 1
        ;;
    esac
  done

  if [[ "$found" -eq "$total" ]]; then
    echo published
    return 0
  fi
  if [[ "$absent" -eq "$total" ]]; then
    echo missing
    return 0
  fi

  # All four modules publish in one step, so a split result means that step died
  # midway. Republishing would 409 on the ones that landed; skipping would leave
  # the rest missing forever. Neither is safe to pick automatically.
  echo "ERROR: Maven Central has ${found} of ${total} artifacts at ${version}." >&2
  echo "       A partial publish needs manual repair before rerunning." >&2
  return 1
}

check_mcp() {
  local version="$1" encoded body matches
  encoded="${MCP_SERVER_NAME//\//%2F}"

  if ! body=$(curl -sS --max-time 30 --retry 3 --retry-delay 2 \
    "${MCP_REGISTRY_URL}/v0/servers/${encoded}/versions" 2>/dev/null); then
    echo "ERROR: could not reach the MCP registry" >&2
    return 1
  fi

  if ! matches=$(printf '%s' "$body" \
    | jq -r --arg v "$version" \
      '[.servers[]?.server.version // empty | select(. == $v)] | length' 2>/dev/null); then
    echo "ERROR: unparseable MCP registry response" >&2
    return 1
  fi

  if ! [[ "$matches" =~ ^[0-9]+$ ]]; then
    echo "ERROR: unexpected MCP registry response shape" >&2
    return 1
  fi

  if [[ "$matches" -gt 0 ]]; then
    echo published
  else
    echo missing
  fi
}

main() {
  if [[ $# -ne 2 ]]; then
    usage
    return 2
  fi

  local target="$1" version="$2"

  if [[ -z "$version" ]]; then
    echo "ERROR: version must not be empty" >&2
    return 2
  fi

  case "$target" in
    npm) check_npm "$version" ;;
    maven) check_maven "$version" ;;
    mcp) check_mcp "$version" ;;
    *)
      echo "ERROR: unknown target: ${target}" >&2
      usage
      return 2
      ;;
  esac
}

main "$@"
