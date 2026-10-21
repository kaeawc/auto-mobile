#!/usr/bin/env bats
#
# Release workflows run with every publish secret, so they must not restore
# Actions caches (unsigned; writable by any job on main) or seed new ones.

@test "release workflows disable the Actions cache at the workflow level" {
  for workflow in .github/workflows/release.yml .github/workflows/prepare-release.yml; do
    grep -qx 'cache-mode: none' "$workflow"
    # No job may widen it back.
    ! grep -qE '^ +cache-mode: (read|write|write-only)$' "$workflow"
  done
}

@test "release steps do not ask for caches the mode would silently skip" {
  ! grep -q 'type=gha' .github/workflows/release.yml
  ! grep -q 'cache: "gradle"' .github/workflows/release.yml
  for workflow in .github/workflows/release.yml .github/workflows/prepare-release.yml; do
    setup_bun="$(grep -c 'uses: oven-sh/setup-bun@' "$workflow")"
    no_cache="$(grep -c 'no-cache: true' "$workflow")"
    [ "$setup_bun" -eq "$no_cache" ]
  done
}
