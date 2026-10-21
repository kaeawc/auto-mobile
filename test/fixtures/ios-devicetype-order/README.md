# iOS device type ordering fixtures (issue #12288)

- `xcode-26.6-devicetypes.json` and `xcode-26.6-runtimes.json` are verbatim captures of
  `xcrun simctl list devicetypes -j` / `xcrun simctl list runtimes -j` from Xcode 26.6 (17F113).
  This Xcode lists device types newest-first within each product family.
- `derived-oldest-first-devicetypes.json` is NOT a capture. It is the Xcode 26.6 capture
  stably sorted ascending by `minRuntimeVersion`, approximating the older oldest-first listing
  shape that `chooseIosDeviceType` used to assume. Contents are otherwise identical.

Do not hand-edit these files; recapture instead.
