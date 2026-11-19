# CarPlay fixture

A standalone charging-category app with fixed list and grid tabs. Selecting a list item pushes a detail list. The phone scene initializes AutoMobileSDK; CarPlay connection opts in to its read-only template snapshot. This app is not a required CI build.

From the repository root, generate and build without booting a simulator:

```bash
xcodegen generate --spec ios/CarPlayFixture/project.yml
xcodebuild -project ios/CarPlayFixture/CarPlayFixture.xcodeproj -scheme CarPlayFixture -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath scratch/carplay-fixture-dd build
```

The generated project is checked in, following Playground. The repository XcodeGen drift check discovers project.yml files; its pbxproj normalizer only sorts target arrays (this project has one target). Use the pinned XcodeGen version from scripts/ios/xcodegen_version.sh.

The project enables ad-hoc signing with `CODE_SIGNING_ALLOWED: YES` and `CODE_SIGN_IDENTITY: "-"`.
The signature embeds the charging entitlement. An unsigned build installs on the simulator but
never appears on CarPlay. Device distribution requires Apple's charging entitlement approval and
a signing profile.

For headless use, boot an iOS 26.x simulator and run the following commands with its UDID. Run
`power-on` after every boot to restore the CarPlay configuration.

```bash
swift run --package-path ios/carplay-power carplay-power-helper <udid> power-on
xcrun simctl install <udid> scratch/carplay-fixture-dd/Build/Products/Debug-iphonesimulator/CarPlayFixture.app
xcrun simctl launch <udid> dev.jasonpearson.automobile.CarPlayFixture
xcrun simctl io <udid> screenshot --display=2
```

For interactive use on iOS 26.x, select **I/O > External Displays > CarPlay** in Simulator, then
open the fixture on the CarPlay display. iOS 27.x simulators lack CarPlay projection support.
Use the SDK route (`GET /carplay/templates`) for template snapshots there.
