#!/usr/bin/env bats
#
# Pins #5098: the iOS Playground tab views must route colours through the design
# theme (theme.textSecondary / theme.primary), not raw SwiftUI `.secondary` or
# `.autoMobileRed` literals that ignore the crayon palette. Mirrors the issue's
# acceptance grep over ios/Playground/Sources/Tabs. Source-level guard, no Xcode.

setup() {
  repo_root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  tabs_dir="$repo_root/ios/Playground/Sources/Tabs"
}

@test "iOS Playground tab views have no raw .secondary / .autoMobileRed colour leaks (#5098)" {
  [ -d "$tabs_dir" ]
  leaks="$(grep -rInE '\.secondary\b|Color\.autoMobileRed|\.autoMobileRed' "$tabs_dir" || true)"
  if [ -n "$leaks" ]; then
    echo "Raw colour literals must route through the theme"
    echo "(.secondary -> theme.textSecondary, .autoMobileRed -> theme.primary):"
    echo "$leaks"
    false
  fi
}
