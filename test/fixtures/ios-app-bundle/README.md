# iOS app bundle fixture (hand-authored)

`DeepLinkDemo.app/` stands in for an installed `.app` bundle in
`getDeepLinks` tests (#14094). It is hand-authored, not a capture:

- `Info.plist.json` is the JSON that `plutil -convert json -o - -- Info.plist`
  prints for the bundle's `Info.plist`. Tests read it through a fake
  `PlistReader`, because `plutil` only exists on macOS.
- `entitlements.json` is the entitlements dictionary `codesign -d --entitlements`
  reports for the bundle, returned by a fake `AppBundleMetadata`.

Both the Simulator path (host container path) and the physical-device path
(bundle copied off the device by `devicectl device copy from`) read this same
directory, so the tests compare the two paths on one build.
