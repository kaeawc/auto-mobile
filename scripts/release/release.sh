#!/usr/bin/env bash
#
# Release script for AutoMobile Android libraries
#
# This script handles publishing Android libraries:
# 1. Updates VERSION_NAME to release version
# 2. Publishes to Maven Central
# 3. Restores next SNAPSHOT version
#
# Usage:
#   ./scripts/release/release.sh 0.0.10
#   ./scripts/release/release.sh --dry-run 0.0.10
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GRADLE_PROPERTIES="$REPO_ROOT/android/gradle.properties"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

dry_run=false
version=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [--dry-run] <version>"
      echo ""
      echo "Options:"
      echo "  --dry-run    Show what would happen without making changes"
      echo "  --help       Show this help message"
      echo ""
      echo "Example:"
      echo "  $0 0.0.10           # Release version 0.0.10"
      echo "  $0 --dry-run 0.0.10 # Dry run for version 0.0.10"
      exit 0
      ;;
    *)
      if [[ -z "$version" ]]; then
        version="$1"
      else
        echo -e "${RED}Error: Unexpected argument: $1${NC}" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "$version" ]]; then
  echo -e "${RED}Error: Version argument required${NC}" >&2
  echo "Usage: $0 [--dry-run] <version>"
  exit 1
fi

# Validate version format (semver without -SNAPSHOT)
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo -e "${RED}Error: Invalid version format: $version${NC}" >&2
  echo "Expected format: X.Y.Z (e.g., 0.0.10)"
  exit 1
fi

IFS='.' read -r major minor patch <<< "$version"
next_patch=$((patch + 1))
next_snapshot="${major}.${minor}.${next_patch}-SNAPSHOT"

echo -e "${GREEN}Release Configuration:${NC}"
echo "  Release version: $version"
echo "  Next snapshot:   $next_snapshot"
echo "  Dry run:         $dry_run"
echo ""

update_gradle_version() {
  local new_version="$1"
  if [[ "$dry_run" == true ]]; then
    echo -e "${YELLOW}[DRY RUN]${NC} Would update VERSION_NAME to $new_version in $GRADLE_PROPERTIES"
    return 0
  fi

  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s/^VERSION_NAME=.*/VERSION_NAME=$new_version/" "$GRADLE_PROPERTIES"
  else
    sed -i "s/^VERSION_NAME=.*/VERSION_NAME=$new_version/" "$GRADLE_PROPERTIES"
  fi

  echo -e "${GREEN}Updated${NC} VERSION_NAME to $new_version"
}

run_gradle() {
  if [[ "$dry_run" == true ]]; then
    echo -e "${YELLOW}[DRY RUN]${NC} ./gradlew $*"
    return 0
  fi
  (cd "$REPO_ROOT/android" && ./gradlew "$@")
}

echo ""
echo -e "${GREEN}Step 1: Update to release version ($version)${NC}"
update_gradle_version "$version"

echo ""
echo -e "${GREEN}Step 2: Publish to Maven Central${NC}"
# Isolated Projects forbids --no-configuration-cache, so force it off for this
# publish invocation only — a global/CI ~/.gradle enabling IP must not break the
# release. Does not touch IP for normal builds. See android/gradle.properties.
run_gradle :protocol:publishAndReleaseToMavenCentral :test-plan-validation:publishAndReleaseToMavenCentral :junit-runner:publishAndReleaseToMavenCentral :auto-mobile-sdk:publishAndReleaseToMavenCentral --no-configuration-cache -Dorg.gradle.unsafe.isolated-projects=false

echo ""
echo -e "${GREEN}Step 3: Restore snapshot version ($next_snapshot)${NC}"
update_gradle_version "$next_snapshot"

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Release complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
artifacts=(protocol test-plan-validation junit-runner sdk)
group="dev.jasonpearson.auto-mobile"

echo "Published artifacts:"
for a in "${artifacts[@]}"; do
  echo "  - $group:auto-mobile-$a:$version"
done
echo ""
echo "Next steps:"
echo "  - Commit, tag, and push when ready"
echo "  - Maven Central artifacts should be available shortly"
echo ""
echo "Maven Central URLs (may take a few minutes to appear):"
for a in "${artifacts[@]}"; do
  echo "  https://central.sonatype.com/artifact/$group/auto-mobile-$a/$version"
done
