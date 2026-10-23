#!/usr/bin/env bash
# Build the offline ProtoViewer library app (Core + Agent + ProtoViewer, no Loader.c).
# Usage: scripts/ios/protoviewer-build.sh [output-dir]
# Env: PROTOVIEWER_ARCHS (default "arm64 x86_64"), PROTOVIEWER_MIN_IOS (default 17.0).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/lib/spotlight-exclude.sh
source "${repo_root}/scripts/lib/spotlight-exclude.sh"
out_dir="${1:-${repo_root}/scratch/protoviewer}"
mkdir_spotlight_excluded "${out_dir}"
out_dir="$(cd "${out_dir}" && pwd)"
app="${out_dir}/ProtoViewer.app"
mkdir -p "${app}"
sources_root="${repo_root}/ios/prototype-agent/Sources"
viewer_root="${repo_root}/ios/prototype-agent/ProtoViewer"
sdk="$(xcrun --sdk iphonesimulator --show-sdk-path)"
min_ios="${PROTOVIEWER_MIN_IOS:-17.0}"
read -r -a archs <<< "${PROTOVIEWER_ARCHS:-arm64 x86_64}"
if [[ ${#archs[@]} -eq 0 ]]; then
  echo "PROTOVIEWER_ARCHS must name at least one simulator architecture" >&2
  exit 1
fi

# One executable module, including Core + Agent Swift, never Loader.c or an asset catalog.
swift_sources=()
while IFS= read -r -d '' file; do
  swift_sources+=("${file}")
done < <(find "${sources_root}/AutoMobilePrototypeAgentCore" \
  "${sources_root}/AutoMobilePrototypeAgent" "${viewer_root}" -name '*.swift' -print0 | sort -z)
slices=()
for arch in "${archs[@]}"; do
  case "${arch}" in
    arm64|x86_64) ;;
    *) echo "Unsupported simulator architecture: ${arch}" >&2; exit 1 ;;
  esac
  slice="${out_dir}/ProtoViewer-${arch}"
  xcrun --sdk iphonesimulator swiftc \
    -target "${arch}-apple-ios${min_ios}-simulator" -sdk "${sdk}" \
    -swift-version 6 -warnings-as-errors -O -parse-as-library \
    -module-name AutoMobileProtoViewer \
    -o "${slice}" ${swift_sources[@]+"${swift_sources[@]}"}
  slices+=("${slice}")
done
lipo -create ${slices[@]+"${slices[@]}"} -output "${app}/ProtoViewer"
lipo "${app}/ProtoViewer" -verify_arch "${archs[@]}"
cp "${viewer_root}/Info.plist" "${app}/Info.plist"
plutil -replace MinimumOSVersion -string "${min_ios}" "${app}/Info.plist"
plutil -lint "${app}/Info.plist"

# Native host APIs generate loose placeholder PNGs, with no committed binary assets.
# Also inspect the plist structurally: a CFBundleIconName anywhere would break stamping.
cat > "${out_dir}/viewer-icons.swift" <<'SWIFT'
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let plist = try PropertyListSerialization.propertyList(
    from: Data(contentsOf: directory.appendingPathComponent("Info.plist")), options: [], format: nil
)
func hasCompiledIconName(_ value: Any) -> Bool {
    if let dictionary = value as? [String: Any] {
        return dictionary["CFBundleIconName"] != nil || dictionary.values.contains(where: hasCompiledIconName)
    }
    if let array = value as? [Any] { return array.contains(where: hasCompiledIconName) }
    return false
}
guard let metadata = plist as? [String: Any],
      metadata["NSAppTransportSecurity"] == nil, metadata["UIFileSharingEnabled"] == nil
else { fatalError("ProtoViewer must not enable ATS exceptions or file sharing") }
guard !hasCompiledIconName(plist) else { fatalError("Template must not contain CFBundleIconName") }
for (scale, size) in [(2, 120), (3, 180)] {
    guard let context = CGContext(
        data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { fatalError("Cannot create icon context") }
    context.setFillColor(CGColor(red: 0.18, green: 0.35, blue: 0.75, alpha: 1))
    context.addPath(CGPath(
        roundedRect: CGRect(x: 0, y: 0, width: CGFloat(size), height: CGFloat(size)),
        cornerWidth: CGFloat(size) * 0.22, cornerHeight: CGFloat(size) * 0.22, transform: nil
    ))
    context.fillPath()
    let url = directory.appendingPathComponent("ProtoViewerIcon60x60@\(scale)x.png")
    guard let image = context.makeImage(),
          let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { fatalError("Cannot create icon PNG") }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { fatalError("Cannot write icon PNG") }
}
SWIFT
xcrun --sdk macosx swift -swift-version 6 -warnings-as-errors "${out_dir}/viewer-icons.swift" "${app}"
if [[ -n "$(find "${app}" \( -name Assets.car -o -name InfoPlist.strings \) -print -quit)" ]]; then
  echo "Viewer template must not contain Assets.car or InfoPlist.strings" >&2
  exit 1
fi
codesign --force --sign - "${app}" > /dev/null
echo "${app}"
