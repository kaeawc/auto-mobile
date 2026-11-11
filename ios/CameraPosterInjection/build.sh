#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <output-directory>" >&2
  exit 2
fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
out="$1"
mkdir -p -- "$out/CameraFixture.app"

xcrun --sdk iphonesimulator clang -arch arm64 -dynamiclib -fobjc-arc \
  -framework Foundation -framework UIKit -framework AVFoundation \
  -framework CoreImage -framework CoreMedia -framework CoreVideo \
  -framework ImageIO -framework UniformTypeIdentifiers \
  -mios-simulator-version-min=17.0 \
  "$script_dir/Injection/CameraPosterInjection.m" -o "$out/libAMCameraPoster.dylib"
xcrun --sdk iphonesimulator swiftc -target arm64-apple-ios17.0-simulator \
  -parse-as-library "$script_dir"/Fixture/Sources/*.swift \
  -o "$out/CameraFixture.app/CameraFixture"
cp -- "$script_dir/Fixture/Info.plist" "$out/CameraFixture.app/Info.plist"
codesign -f -s - "$out/libAMCameraPoster.dylib"
codesign -f -s - "$out/CameraFixture.app"
