# CarPlay fixture

A standalone charging-category app with fixed list and grid tabs. Selecting a list item pushes a detail list. The phone scene initializes AutoMobileSDK; CarPlay connection opts in to its read-only template snapshot. This app is not a required CI build.

From the repository root, generate and build without booting a simulator:

```bash
xcodegen generate --spec ios/CarPlayFixture/project.yml
xcodebuild -project ios/CarPlayFixture/CarPlayFixture.xcodeproj -scheme CarPlayFixture -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath scratch/carplay-fixture-dd build
```

The generated project is checked in, following Playground. The repository XcodeGen drift check discovers project.yml files; its pbxproj normalizer only sorts target arrays (this project has one target). Use the pinned XcodeGen version from scripts/ios/xcodegen_version.sh.

For manual use on an already booted simulator:

```bash
xcrun simctl install booted scratch/carplay-fixture-dd/Build/Products/Debug-iphonesimulator/CarPlayFixture.app
xcrun simctl launch booted dev.jasonpearson.automobile.CarPlayFixture
```

In Simulator, select **I/O > External Displays > CarPlay**, then open the fixture on the CarPlay display. The headless alternative is the `ios/carplay-power` helper:

```bash
swift run --package-path ios/carplay-power carplay-power-helper <udid> power-on --enable
```

This powers the display without opening Simulator.app. Device distribution requires Apple's charging entitlement approval and a signing profile; simulator builds disable signing. No image assets or app icon catalog are required.
