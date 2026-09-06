# UI tests

AutoMobile UI tests keep the test assertion in Kotlin or Swift and the device
steps in a YAML plan. The same plan can be reviewed, reused, and run locally or
in CI.

## 1. Install a test runner

=== "Android"

    **Gradle**

    Add the JUnit runner to the module that owns the tests:

    ```kotlin
    // app/build.gradle.kts
    dependencies {
        testImplementation("dev.jasonpearson.auto-mobile:auto-mobile-junit-runner:0.0.68")
    }
    ```

    The runner executes as a normal JVM test, so no test APK or
    `connectedAndroidTest` task is required. Ensure `adb` is on `PATH` and an
    Android device or emulator is available.

=== "iOS"

    **Swift Package Manager**

    Add AutoMobile from GitHub in Xcode (**File → Add Package Dependencies…**), then add the `XCTestRunner` product to the test target.

    For a Swift package manifest, use the released package:

    ```swift
    .package(url: "https://github.com/kaeawc/auto-mobile.git", from: "0.0.68")
    ```

    `from:` resolves the newest compatible AutoMobile release; it is not an exact pin. The package requires Swift 6, macOS 15, and iOS 17.

## 2. Create a plan

=== "Android"

    Put the plan in `src/test/resources/test-plans/`. This is AutoMobile's own
    [`launch-clock-app.yaml`](https://github.com/kaeawc/auto-mobile/blob/main/android/junit-runner/src/test/resources/test-plans/launch-clock-app.yaml),
    which launches the system Clock app and waits for its UI:

    ```yaml
    name: launch-clock-app
    description: Very simple test to launch Clock app
    steps:
      - tool: launchApp
        appId: com.google.android.deskclock
        clearAppData: true
        label: Launch Clock application with clean state

      - tool: observe
        waitFor:
          elementId: "com.google.android.deskclock:id/tab_menu_alarm"
          timeout: 20000
        label: Wait for Clock UI to be ready

      - tool: terminateApp
        appId: com.google.android.deskclock
    ```

=== "iOS"

    Put the plan in the iOS test bundle's `test-plans/` directory. This is
    AutoMobile's own
    [`launch-reminders-app.yaml`](https://github.com/kaeawc/auto-mobile/blob/main/ios/XCTestRunner/Sources/XCTestRunnerTests/Resources/Plans/launch-reminders-app.yaml),
    which launches the system Reminders app and waits for it to foreground:

    ```yaml
    name: launch-reminders-app
    description: Launch the iOS Reminders app and wait for it to reach the foreground
    platform: ios
    steps:
      - tool: launchApp
        appId: com.apple.reminders
        label: Launch Reminders

      - tool: observe
        waitFor:
          activeWindow:
            appId: com.apple.reminders
          timeout: 30000
        label: Wait for Reminders to be foregrounded

      - tool: terminateApp
        appId: com.apple.reminders
        label: Close Reminders
    ```

## 3. Consume the plan

=== "Android"

    Place this test under `src/test/`. AutoMobile runs the same plan from
    [`ClockAppAutoMobileTest.kt`](https://github.com/kaeawc/auto-mobile/blob/main/android/junit-runner/src/test/kotlin/dev/jasonpearson/automobile/junit/ClockAppAutoMobileTest.kt):

    ```kotlin
    import dev.jasonpearson.automobile.junit.AutoMobilePlan
    import dev.jasonpearson.automobile.junit.AutoMobileRunner
    import org.junit.Test
    import org.junit.runner.RunWith
    import kotlin.test.assertTrue

    @RunWith(AutoMobileRunner::class)
    class ClockAppTest {
        @Test
        fun launchesClock() {
            val result = AutoMobilePlan("test-plans/launch-clock-app.yaml").execute()
            assertTrue(result.success, result.output)
        }
    }
    ```

    Run it with:

    ```bash
    ./gradlew :app:testDebugUnitTest --tests ClockAppTest
    ```

=== "iOS"

    Add the plan to the iOS test bundle and create an `AutoMobileTestCase`.
    AutoMobile runs the same plan from
    [`RemindersIntegrationTests.swift`](https://github.com/kaeawc/auto-mobile/blob/main/ios/XCTestRunner/Sources/XCTestRunnerTests/RemindersIntegrationTests.swift):

    ```swift
    import XCTest
    import XCTestRunner

    final class RemindersTests: AutoMobileTestCase {
        override var planPath: String {
            "test-plans/launch-reminders-app.yaml"
        }

        func testLaunchReminders() throws {
            let result = try executePlan()
            XCTAssertTrue(result.success, result.error ?? "AutoMobile plan failed")
        }
    }
    ```

    Run the test target from Xcode or with `xcodebuild test` against a booted iOS
    Simulator. Keep selectors semantic and add `observe.waitFor` steps at important
    checkpoints so failures explain which state was missing.

### Redacting sensitive parameters

Plans substitute `${paramName}` placeholders with values you pass from the test
(experiment groups, environments, and occasionally a token, password, or other
secret). When AI-assisted recovery is enabled and a step fails, the runner sends
failure context — the substituted plan YAML, the
error, and sampled on-screen text — to your configured LLM provider. Any secret
substituted into the plan would be disclosed to that provider.

Mark the parameter keys whose values are sensitive and the runner masks them
(`***REDACTED***`) in everything sent to the provider — the plan YAML, the error
string, and the on-screen samples. The values still reach the **local** daemon
unredacted so the plan actually runs; only what leaves the process for the LLM is
masked.

Declare them in the plan (applies on both platforms):

```yaml
name: login
secretParameters:
  - apiToken
  - password
steps:
  - tool: inputText
    text: "${apiToken}"
```

Or pass them from the test runner. Android:

```kotlin
AutoMobilePlan("test-plans/login.yaml") { "apiToken" to token }
    .execute(AutoMobilePlanExecutionOptions(secretParameterKeys = setOf("apiToken")))
```

iOS — set `secretParameterKeys` on `AutoMobilePlanExecutor.Configuration`. The
plan-declared and runner-supplied sets are unioned, so either source (or both)
protects the value. Recovery stays opt-in; this only changes what recovery may
disclose.

## 4. Run a multi-device plan

Add device labels when a flow spans two users or devices. Steps for different
labels run concurrently:

```yaml
devices:
  - label: sender
    platform: ios
  - label: recipient
    platform: ios
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

## 5. Accessibility workflows

Use semantic labels and identifiers in plans, then verify the same elements in
`observe` output before interacting with them. To exercise a screen reader,
enable the default-off `accessibility` tool for the current MCP connection:

```json
{
  "name": "setToolEnabled",
  "arguments": { "toolName": "accessibility", "enabled": true }
}
```

Call `accessibility` with `talkback: true` on Android or `voiceover: true` on
iOS, run the flow, and disable it afterward. Android also supports the
default-off debug tool `accessibilityFocus` for setting or clearing TalkBack
focus. Check text alternatives, content descriptions or accessibility labels,
focus order, contrast, and tap-target size as part of the assertions; support
for toggling services varies by device type and OS version.

## 6. Pin CI releases

Use one release version for the runner, daemon, and device helpers. Restart a
shared daemon so it receives the pin, then check the environment before tests:

```bash
export AUTOMOBILE_VERSION=0.0.68
bunx @kaeawc/auto-mobile@0.0.68 --daemon restart
bunx @kaeawc/auto-mobile@0.0.68 --cli doctor
```

Replace `0.0.68` with the version used by your test runner dependency.
