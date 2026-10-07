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
    testImplementation("dev.jasonpearson.auto-mobile:auto-mobile-junit-runner:0.0.83")
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
.package(url: "https://github.com/kaeawc/auto-mobile.git", from: "0.0.83")
```

`from:` resolves the newest compatible AutoMobile release; it is not an exact pin. The package requires Swift 6, macOS 15, and iOS 17.

</div>

## 2. Create a plan

<div class="content-tabs" markdown>

### Android

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

### iOS

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

</div>

## 3. Consume the plan

<div class="content-tabs" markdown>

### Android

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

### iOS

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
answer the allow or deny button. Android also supports the
default-off debug tool `accessibilityFocus` for setting or clearing TalkBack
focus. Check text alternatives, content descriptions or accessibility labels,
focus order, contrast, and tap-target size as part of the assertions; support
for toggling services varies by device type and OS version.

## 6. Pin CI releases

Use one release version for the runner, daemon, and device helpers. Restart a
shared daemon so it receives the pin, then check the environment before tests:

```bash
export AUTOMOBILE_VERSION=0.0.83
bunx @kaeawc/auto-mobile@0.0.83 --daemon restart
bunx @kaeawc/auto-mobile@0.0.83 --cli doctor
```

Replace `0.0.83` with the version used by your test runner dependency.

`--cli doctor` runs locally, without a daemon tool connection. It is status-only: it never installs, updates or enables Android CtrlProxy,
and never resets running session state. It reports installation, accessibility and
APK checksum status for every booted Android device, up to eight devices per run;
if more are attached, it reports how many were not checked. A mismatch is a warning
(or a failure for a known explicit version pin).

To install or update CtrlProxy, run an AutoMobile device tool such as `observe`
against the affected device: device readiness performs the repair. Alternatively,
use the IDE plugin's update-service action. Enable CtrlProxy in Settings >
Accessibility if it is disabled. Use `--daemon restart` or `--daemon diagnose`
for daemon remedies.

# Foldable posture lane

The nightly workflow and manual workflow dispatch run the opt-in foldable
scenario on API 36 `google_apis` AVD profiles `pixel_10_pro_fold` and
`resizable`. This job remains advisory until the first nightly run confirms the
profiles, display server, and recording assertions on the hosted Linux runner.
To run it locally, install FFmpeg, boot one of those AVDs,
build AutoMobile, install the matching CtrlProxy APK, then run:

```bash
AUTOMOBILE_FOLDABLE_LANE=1 AUTOMOBILE_FOLDABLE_PROFILE=pixel_10_pro_fold \
  AUTOMOBILE_FOLDABLE_DEVICE_ID=emulator-5554 \
  bun test test/integration/foldablePostureRoundTrip.integration.test.ts
```

Use `AUTOMOBILE_FOLDABLE_PROFILE=resizable` for the Resizable AVD. The Pixel
Fold exercises the inner/cover swap and rear-display state; Resizable exercises
the phone/unfolded presets. The nightly Resizable job uses Xvfb because the
emulator does not support `resize-display` in headless mode. Generic foldable
AVD profiles model hinge posture only and cannot emulate a cover screen.
Samsung FlexWindow and Razr external displays cannot be emulated by these
profiles.

Before creating either AVD, the lane prints cmdline-tools/emulator versions and
`avdmanager list device -c`, updates `cmdline-tools;latest`, then checks the
device list again. If the update installs newer tools into `cmdline-tools/latest-*`,
the prepare step promotes the newest revision to `latest` and parks the previous
install outside `cmdline-tools/` so subsequent AVD creation uses the updated tools.
A missing requested profile fails early with the available
fold profiles. There is no silent fallback: the test requires the exact profile
and its panel sizes.

Resizable's windowed emulator also needs `libpulse0` and related X11/Qt runtime
libraries. The Ubuntu 24.04 runner lacked `libpulse.so.0` in nightly run
36807944824, causing the windowed qemu process to exit before boot. The prepare
step installs these libraries; an always-running diagnostic checks qemu and
the Qt xcb plugin with `ldd`. The failure artifact includes
`scratch/foldable-lane/sdk-diagnostics.txt` with versions and full device lists.
The lane remains advisory. The next nightly must confirm the exact profiles
exist, all windowed libraries resolve, and both AVDs boot and pass their posture
round trips.

A separate recording test starts on the opened panel, folds, then unfolds. On
Pixel Fold it checks that `metadata.recordedPanel` remains the inner panel and
that `metadata.transitions` reports the cover then inner changes in order.
Both profiles require `startedAt + durationMs` to cover the post-unfold settled screenshot's host timestamp within a 100 ms timestamp/finalization tolerance.
Resizable only checks span coverage and that a recording is produced, because
its single display emits no `recordedPanel`/`transitions` metadata. The stop result does not
expose measured video dimensions, so a size-based check for a letterboxed union
canvas is deferred. Recordings and stop metadata are copied under
`scratch/foldable-lane/recordings/`, included in the nightly failure artifact.
Both tests release their session and restore opened posture in `finally`; the
recording test also stops capture in `finally`. Without
`AUTOMOBILE_FOLDABLE_LANE=1`, both tests skip.

## Nightly randomized unit diagnostic

Alongside the device lanes above, Nightly runs **Node Randomized Unit Tests
(Advisory)** on Ubuntu. Like the race guard and XCTestRunner Thread Sanitizer,
it uses job-level `continue-on-error` and has no downstream dependents. It does
not run per PR. It diagnoses cross-file state leaks (#6698) in one shared Bun
process, without isolation, parallel execution or sharding.

The seed is `github.run_number`, so retrying a workflow preserves its order.
`scripts/test-ts.sh` prints it before running and includes it in the failure
summary. The script shares the ordinary unit shards' file selector, excluding
`*.integration.test.ts` (including daemon lifecycle tests) and `test/stress/**`.
Reproduce with the seed from the failed run and the same checkout/Bun version:

```bash
AUTOMOBILE_TEST_MODE=true AUTOMOBILE_UNIT_RANDOM_SEED=N bash scripts/test-ts.sh unit
```

This executes `bun test --randomize --seed=N <files>` with an explicit, non-empty
canonical unit file list. Do not omit `<files>` when invoking Bun directly.
