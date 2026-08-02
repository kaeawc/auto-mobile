#!/usr/bin/env bash
# Verify that the prepared desktop installers use the stable release-asset names.
#
# Usage: verify-desktop-installer-assets.sh <version> <directory>
#
# Desktop installers are direct downloads, so they deliberately have no
# RELEASE_CHECKSUM_REGISTRY entries. Their release contract is instead the
# prepared-run provenance plus these exact, versioned filenames.
set -euo pipefail

VERSION="${1:?Usage: verify-desktop-installer-assets.sh <version> <directory>}"
DIRECTORY="${2:?Usage: verify-desktop-installer-assets.sh <version> <directory>}"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "ERROR: invalid desktop installer version: $VERSION" >&2
  exit 1
fi

if [ ! -d "$DIRECTORY" ]; then
  echo "ERROR: desktop installer directory not found: $DIRECTORY" >&2
  exit 1
fi

expected_assets=(
  "AutoMobile-${VERSION}-macos.dmg"
  "AutoMobile-${VERSION}-windows.msi"
  "AutoMobile-${VERSION}-linux.deb"
)

missing=0
for asset in "${expected_assets[@]}"; do
  if [ ! -s "$DIRECTORY/$asset" ]; then
    echo "ERROR: required desktop installer is missing or empty: $DIRECTORY/$asset" >&2
    missing=1
  else
    echo "  OK  $asset"
  fi
done

if [ "$missing" -ne 0 ]; then
  exit 1
fi

echo "Desktop installer assets verified for version $VERSION."
