#!/usr/bin/env bats

# #11977: the Android lane's input hash folds in the environment variables the build reads. A new
# read must be hashed (TIER2_CONSUMED_ENV) or excluded with a reason (TIER2_EXCLUDED_ENV).

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
}

android_env_reads() {
  grep -rhoE '(getenv|environmentVariable)\([[:space:]]*"[A-Za-z_0-9]+"[[:space:]]*\)' \
    "$REPO_ROOT/android" --include='*.kt' --include='*.kts' --include='*.gradle' --include='*.java' \
    | sed -E 's/.*\([[:space:]]*"([^"]+)".*/\1/' | sort -u
}

listed_env() {
  (cd "$REPO_ROOT" && bun -e '
    import { TIER2_CONSUMED_ENV, TIER2_EXCLUDED_ENV } from "./scripts/ci/attestation/tier23InputHash";
    for (const name of [...TIER2_CONSUMED_ENV, ...TIER2_EXCLUDED_ENV]) console.log(name);
  ' | sort -u)
}

@test "every environment variable the Android build reads is hashed or excluded" {
  reads="$(android_env_reads)"
  [ -n "$reads" ]
  listed="$(listed_env)"
  unlisted="$(comm -23 <(printf '%s\n' "$reads") <(printf '%s\n' "$listed"))"
  if [ -n "$unlisted" ]; then
    echo "unlisted environment reads (add to tier23InputHash.ts):" >&2
    printf '%s\n' "$unlisted" >&2
  fi
  [ -z "$unlisted" ]
}

@test "the lists name no variable the Android build no longer reads" {
  reads="$(android_env_reads)"
  listed="$(listed_env)"
  stale="$(comm -13 <(printf '%s\n' "$reads") <(printf '%s\n' "$listed"))"
  if [ -n "$stale" ]; then
    echo "stale entries:" >&2
    printf '%s\n' "$stale" >&2
  fi
  [ -z "$stale" ]
}
