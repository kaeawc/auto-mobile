# UI tests

AutoMobile UI tests keep the test assertion in Kotlin or Swift and the device
steps in a YAML plan. The same plan can be reviewed, reused, and run locally or
in CI.

## 1. Install a test runner

### Android / Gradle

Add the JUnit runner to the module that owns the tests:

```kotlin
// app/build.gradle.kts
dependencies {
    testImplementation("dev.jasonpearson.auto-mobile:auto-mobile-junit-runner:0.0.66")
}
```

The runner executes as a normal JVM test, so no test APK or
`connectedAndroidTest` task is required. Ensure `adb` is on `PATH` and an
Android device or emulator is available.

### iOS / Swift Package Manager

Add the local package at `ios/XCTestRunner` to the test target in Xcode
(**File → Add Package Dependencies → Add Local…**).

For a Swift package manifest, use a local dependency:

```swift
.package(path: "../../auto-mobile/ios/XCTestRunner")
```

Then add `XCTestRunner` to the test target's dependencies. The package
currently requires Swift 6, macOS 14, and iOS 17.

For both platforms, start the AutoMobile daemon if the runner does not start it
automatically:

```bash
auto-mobile --daemon start
```

## 2. Create a plan

Put the plan in Android `src/test/resources/test-plans/` or in the iOS test
bundle's `test-plans/` directory:

```yaml
name: launch-app
description: Launch the app and verify the home screen
platform: android # use ios for an iOS plan
steps:
  - tool: launchApp
    appId: com.example.app
    clearAppData: true

  - tool: observe
    waitFor:
      text: "Welcome"
      timeout: 10000

  - tool: terminateApp
    appId: com.example.app
```

Use an Android package ID or iOS bundle ID for `appId`. The app must already
be installed. A plain `observe` checks that a snapshot is returned;
`waitFor` asserts that required content appears.

## 3. Consume the plan from Kotlin

Place this test under `app/src/test/`:

```kotlin
import dev.jasonpearson.automobile.junit.AutoMobileRunner
import dev.jasonpearson.automobile.junit.AutoMobilePlan
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertTrue

@RunWith(AutoMobileRunner::class)
class LaunchTest {
    @Test
    fun appLaunches() {
        val result = AutoMobilePlan("test-plans/launch-app.yaml").execute()
        assertTrue(result.success, result.output)
    }
}
```

Run it with:

```bash
./gradlew :app:testDebugUnitTest --tests LaunchTest
```

## 4. Consume the plan from Swift

Add the plan to the iOS test bundle and create an `AutoMobileTestCase`:

```swift
import XCTest
import XCTestRunner

final class LaunchTests: AutoMobileTestCase {
    override var planPath: String {
        "test-plans/launch-app.yaml"
    }

    override var cleanupOptions: AutoMobilePlanExecutor.CleanupOptions? {
        .init(appId: "com.example.app", clearAppData: true)
    }

    func testAppLaunches() throws {
        let result = try executePlan()
        XCTAssertTrue(result.success, result.error ?? "AutoMobile plan failed")
    }
}
```

Run the test target from Xcode or with `xcodebuild test` against a booted iOS
Simulator. Keep selectors semantic and add `observe.waitFor` steps at important
checkpoints so failures explain which state was missing.

## 5. Run a multi-device plan

Add device labels when a flow spans two users or devices. Steps for different
labels run concurrently:

```yaml
devices: [sender, recipient]
steps:
  - tool: launchApp
    device: sender
    appId: com.example.chat
  - tool: launchApp
    device: recipient
    appId: com.example.chat
  - tool: inputText
    device: sender
    text: Hello
```

Use `barrier` to make device tracks meet at a point, or `criticalSection` only
when they must serialize access to a shared resource.

## 6. Pin CI releases

Use one release version for the runner, daemon, and device helpers. Restart a
shared daemon so it receives the pin, then check the environment before tests:

```bash
export AUTOMOBILE_VERSION=0.0.66
bunx @kaeawc/auto-mobile@0.0.66 --daemon restart
bunx @kaeawc/auto-mobile@0.0.66 --cli doctor
```

Replace `0.0.66` with the version used by your test runner dependency.
