# UI tests

AutoMobile UI tests keep the test assertion in Kotlin or Swift and the device
steps in a YAML plan. The same plan can be reviewed, reused, and run locally or
in CI.

## 1. Install a test runner

<div class="content-tabs" markdown>

### Android

**Gradle**

Add the JUnit runner to the module that owns the tests:

```kotlin
// app/build.gradle.kts
dependencies {
    testImplementation("dev.jasonpearson.auto-mobile:auto-mobile-junit-runner:0.0.88")
}
```

The runner executes as a normal JVM test, so no test APK or
`connectedAndroidTest` task is required. Ensure `adb` is on `PATH` and an
Android device or emulator is available.

### iOS

**Swift Package Manager**

Add AutoMobile from GitHub in Xcode (**File → Add Package Dependencies…**), then add the `XCTestRunner` product to the test target.

For a Swift package manifest, use the released package:

```swift
.package(url: "https://github.com/kaeawc/auto-mobile.git", from: "0.0.88")
```

`from:` resolves the newest compatible AutoMobile release; it is not an exact pin. The package requires Swift 6, macOS 15, and iOS 17.

</div>

## 2. Create a plan

<div class="content-tabs" markdown>

### Android

Put the plan in `src/test/resources/test-plans/`. This one launches the system
Clock app and waits for its UI:

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

### iOS

Put the plan in the iOS test bundle's `test-plans/` directory. This one
launches the system Reminders app and waits for it to foreground:

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

</div>

## 3. Consume the plan

<div class="content-tabs" markdown>

### Android

Place this test under `src/test/`:

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

### iOS

Add the plan to the iOS test bundle and create an `AutoMobileTestCase`:

```swift
import XCTest
import XCTestRunner

final class RemindersTests: AutoMobileTestCase {
    override var planPath: String {
        "test-plans/launch-reminders-app.yaml"
    }

    func testLaunchReminders() async throws {
        let result = try await executePlan()
        XCTAssertTrue(result.success, result.error ?? "AutoMobile plan failed")
    }
}
```

Run the test target from Xcode or with `xcodebuild test` against a booted iOS
Simulator. Keep selectors semantic and add `observe.waitFor` steps at important
checkpoints so failures explain which state was missing.

</div>

### Plan parameters and special characters

A `${paramName}` value reaches the tool exactly as your test supplied it, whatever
characters it contains (backslashes, quotes, ` #`, `: `, line breaks, unicode,
even `${other}`): it never changes the plan's structure and is substituted once,
never re-expanded. Write the placeholder in a double-quoted scalar to keep a
value a string — `text: "${password}"`. In an unquoted scalar the value keeps
the type YAML would read from it, as before: `timeout: ${ms}` with `500` or
`true` stays a number or boolean, while a value that is not a plain scalar (for
example `shoes #1`) becomes a string.

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
  - tool: sendKeys
    commands:
      - action: type
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
  - tool: sendKeys
    device: sender
    commands:
      - action: type
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
iOS, run the flow, and disable it afterward. Enabling TalkBack may leave a system
runtime permission prompt covering the screen. The result reports it through
`warning` and `blockingPrompt` (`kind`, `package`, `activity`) when detected;
AutoMobile does not dismiss it. Use `observe` to inspect it, then `tapOn` to
answer the allow or deny button, or set a `systemAlerts` policy to answer
permission prompts around each interaction. Android also supports the
default-off debug tool `accessibilityFocus` for setting or clearing TalkBack
focus. Check text alternatives, content descriptions or accessibility labels,
focus order, contrast, and tap-target size as part of the assertions; support
for toggling services varies by device type and OS version.

## 6. Pin a release in CI

Use one release version for the test runner and the AutoMobile CLI. Restart a
shared daemon so it receives the pin, then check the environment before tests:

```bash
export AUTOMOBILE_VERSION=0.0.88
bunx @kaeawc/auto-mobile@0.0.88 --daemon restart
bunx @kaeawc/auto-mobile@0.0.88 --cli doctor
```

Replace `0.0.88` with the version used by your test runner dependency.

`--cli doctor` reports the status of AutoMobile on each booted Android device,
including whether the accessibility service is installed and up to date. It is
read-only and never changes the device. If it reports a mismatch, run an
AutoMobile device tool such as `observe` against that device to repair it, or
run `--daemon restart` or `--daemon diagnose` for daemon problems.
