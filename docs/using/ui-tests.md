# UI tests

AutoMobile UI tests keep the test assertion in Kotlin or Swift and the device
steps in a YAML plan. The same plan can be reviewed, reused, and run locally or
in CI.

`executePlan` accepts Android, iOS, tvOS, visionOS, and watchOS sessions. Each step
must use a tool supported on the target platform. visionOS and watchOS plans do
not record video.

## 1. Install a test runner

<div class="content-tabs" markdown>

### Android

**Gradle**

Maven Central has the AutoMobile Android libraries only up to `0.0.67`; newer
releases are not published there yet. To use a newer release, build the runner from
that release's tag and publish it to your local Maven repository (`~/.m2`). This
needs JDK 21 and an Android SDK (`ANDROID_HOME` set, or `sdk.dir` in
`android/local.properties`):

```bash
git clone --depth 1 --branch 0.0.93 https://github.com/kaeawc/auto-mobile.git
cd auto-mobile/android
./gradlew :test-plan-validation:publishToMavenLocal :junit-runner:publishToMavenLocal -PVERSION_NAME=0.0.93
```

Then add `mavenLocal()` to the consuming project's repositories and the JUnit runner
to the module that owns the tests:

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
    repositories {
        mavenLocal()
        google()
        mavenCentral()
    }
}

// app/build.gradle.kts
dependencies {
    testImplementation("dev.jasonpearson.auto-mobile:auto-mobile-junit-runner:0.0.93")
}
```

To resolve the runner from Maven Central instead, skip the build, leave out
`mavenLocal()`, and use version `0.0.67` for the runner and for the CLI pin in
[Pin a release in CI](#6-pin-a-release-in-ci).

The runner executes as a normal JVM test, so no test APK or
`connectedAndroidTest` task is required. Ensure `adb` is on `PATH` and an
Android device or emulator is available.

### iOS

**Swift Package Manager**

Add AutoMobile from GitHub in Xcode (**File → Add Package Dependencies…**), then add the `XCTestRunner` product to the test target.

For a Swift package manifest, use the released package:

```swift
.package(url: "https://github.com/kaeawc/auto-mobile.git", from: "0.0.93")
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

**Device.** Pass `AutoMobilePlanExecutionOptions(device = "<serial>")` to
`execute()` to pick the device. With the default `device = "auto"`, a set
`ANDROID_SERIAL` pins every single-device plan to that serial and runs the
class's tests one at a time; without either, the daemon picks a free device.
Multi-device plans (section 4) choose their own devices and ignore
`ANDROID_SERIAL`.

**Daemon.** The runner uses the daemon on `AUTOMOBILE_DAEMON_SOCKET_PATH` when
it is set, or the default per-user daemon otherwise, and starts one only if
none is running. It never stops or replaces a running daemon of a different
version: the test fails and names both versions. Restart the daemon with the
runner's version, or set `-Dautomobile.daemon.force.restart=true` (the default
in CI) to let the runner replace the default per-user daemon. A daemon on an
explicit `AUTOMOBILE_DAEMON_SOCKET_PATH` is never restarted.

**Failures.** When a plan fails, `result.output` holds the error, the daemon
socket, and the device selector, so `assertTrue(result.success, result.output)`
puts all three in the test report.

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
Simulator. The device identifier is optional; set `AUTOMOBILE_DEVICE_ID` to the
simulator UDID, or override `deviceId` in the test class when more than one device
is booted. `AUTOMOBILE_DEVICE_UDID` is also accepted when `AUTOMOBILE_DEVICE_ID`
is unset or empty. The test acquires its own
device session before executing the plan, and the daemon releases it after the
plan completes. Acquisition and execution errors include the daemon's message.
Keep selectors semantic and add `observe.waitFor` steps at important checkpoints
so failures explain which state was missing.

By default `observe` lists actionable rows in `skeleton` and static text, such as
a status label or a validation error, in `context`. Read `context` to verify a
result. A `waitFor` with only `text` or `textAny`, or `for: "appear"` or
`for: "textEquals"` with only `text`, also matches text from either array when no
hierarchy node carries that text (`textEquals` requires the exact, case-sensitive
value). `for: "clickable"`, `"disappear"` and `"countStable"` check hierarchy nodes
only. Add `elementId`, `container` or `selectionStrategy` to match a single
hierarchy node instead; `className` and `contentDescription` do the same for waits
without `for`. With `textSource: "displayed"`, a wait without `for` matches `text`
only against the text an element displays, not its content description, and does
not match rows; its `textMatch: "exact"` comparison is case-sensitive. The top-level `layer` argument limits the wait to the `app` or
`prototype` layer of the hierarchy and also turns off the row match.

</div>

### Step expectations

A step can check the screen after its tool succeeds. Each entry in
its `expectations` is checked in order against a fresh observation of the same
device. Elements are matched the same way `tapOn` matches them. The first
expectation that does not hold fails the step, and therefore the plan. If the
step is `optional`, the step is skipped instead and the plan continues.

```yaml
- tool: tapOn
  id: counter_add
  expectations:
    - type: textEquals
      selector: { testTag: counter_value }
      text: "1"
    - type: elementAbsent
      selector: { text: Loading }
      timeoutMs: 2000
```

| `type`           | Passes when                                                             | Needs      |
| ---------------- | ----------------------------------------------------------------------- | ---------- |
| `elementVisible` | an element matching `selector` is on screen                             | `selector` |
| `elementAbsent`  | no element matches `selector`                                           | `selector` |
| `textEquals`     | an element (matching `selector`, if given) shows exactly `text`         | `text`     |
| `textContains`   | an element (matching `selector`, if given) shows text containing `text` | `text`     |

`selector` accepts `testTag` (matched like the `tapOn` `testTag` selector),
one id (`resourceId` or `elementId`), `text`, `contentDescription` and
`className`; every field given must match the same element. For `textEquals` and
`textContains`, put the expected value in `text`, not in `selector.text`; it is
compared with the text the element displays (an editable field's value, else its
text), never its content description or accessibility label. `textEquals` is
case-sensitive; `textContains` ignores case. Each
expectation waits up to `timeoutMs` for the condition (the `observe.waitFor`
default when you omit it), so it tolerates a screen that is still settling.

A failed expectation's error names it and lists what was on screen, for example
`Expectation 1/2 (textEquals testTag="counter_value" text="1") failed: not
satisfied after 5000ms; 1 near match(es); observed texts: "0"`. The step's
`failureObservation` holds the full observation. An expectation with a missing
or contradictory field fails the step without observing. An expectation `type`
not in the table is not checked: the plan result carries a warning naming it.

For a check against the tool's returned result, use optional `expect` beside
`params`. `contains` and `notContains` are non-empty, case-sensitive literal
strings; when both are supplied, both must hold. `getLogs` checks the returned
log messages joined with newlines; other tools, including `observe`, check the
serialized JSON payload. These checks use the original result, before response
trimming, and do not poll or make another observation. A violation fails the
plan, or skips an `optional` step. A negative log check also fails if the output
was truncated, because absence cannot be verified from incomplete logs.

```yaml
- tool: getLogs
  params:
    since: run-start
    tags: [AcceptApp]
  expect:
    contains: "reply received: [hello ] action=reply"
    notContains: "reply received: [null]"
```

`getLogs` accepts `since: run-start` only during plan execution. Its window
starts at the current execution, including when resuming at a later step, and
is shared across device tracks. It uses the log reader's whole-second look-back
(rounded up, minimum one second), so boundary lines just before the start can
appear. The existing one-hour cap and output limits still apply. Outside a plan,
`run-start` fails instead of falling back to an older window. Other `since`
options keep their usual behavior.

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
runtime permission prompt covering the screen, sometimes a few seconds after the
setting changes. The call waits up to 4 seconds for a system prompt, ending sooner once the
screen is stable and TalkBack has no runtime permission left to request, and reports it through
`warning` and `blockingPrompt` (`kind`, `package`, `activity`) when detected:
`runtime-permission` for a permission prompt (TalkBack's own or another app's) and
`system-dialog` for a SystemUI or framework dialog activity. AutoMobile does not dismiss it.
Use `observe` to inspect it, then `tapOn` to answer the allow or deny button (or dismiss the
dialog), or set a `systemAlerts` policy to answer permission prompts around each interaction. On Android, when `sendKeys` cannot
focus its field because a system window (permission prompt, SystemUI or
framework dialog) holds focus over the app, the failure reports that window in
`blockingPrompt` (`kind`, `package`) and says to dismiss it rather than scroll. The default-off debug tool
`accessibilityFocus` sets focus on Android (TalkBack) and iOS (VoiceOver).
iOS requires VoiceOver enabled and the AutoMobile in-app SDK in the foreground
app; focus read-back is unavailable. Clearing focus is supported only on Android.
With VoiceOver on, iOS can hold or swallow a tap. When a `tapOn`, `tapAny` or
`tapAt` tap times out with VoiceOver on, the error says the outcome is
indeterminate (the tap may or may not have run, so it is not retried
automatically) and names VoiceOver. Call `observe` to see whether the tap took
effect; if it did not, call `accessibility` with `voiceover: false`, then retry.
With TalkBack on, `tapOn` activates the nearest clickable owner of the matched
element: by accessibility action when the owner has a stable id, otherwise by a
TalkBack focus and double tap at the owner's center. Success does not prove the
intended control responded, so the result's `warnings` flag two cases: the
activated element's bounds do not contain the matched element's bounds (a
different control may have been activated; not reported for `action: "focus"`),
and the tap or double tap reported success but the screen did not change (moving
TalkBack focus counts as a change; not reported for `action: "focus"` once the
field's focus is verified). Each
warning names the elements and gives the matched element's center. Call
`observe`; if the intended control did not respond, call `tapAt` at that center.
Check text alternatives, content descriptions or accessibility labels,
focus order, contrast, and tap-target size as part of the assertions; support
for toggling services varies by device type and OS version.

## 6. Pin a release in CI

Use one release version for the test runner and the AutoMobile CLI. Restart a
shared daemon so it receives the pin, then check the environment before tests:

```bash
export AUTOMOBILE_VERSION=0.0.93
bunx @kaeawc/auto-mobile@0.0.93 --daemon restart
bunx @kaeawc/auto-mobile@0.0.93 --cli doctor
```

Replace `0.0.93` with the version used by your test runner dependency.

`--cli doctor` reports the status of AutoMobile on each booted Android device,
including whether the accessibility service is installed and up to date. It is
read-only and never changes the device. If it reports a mismatch, run an
AutoMobile device tool such as `observe` against that device to repair it, or
run `--daemon restart` or `--daemon diagnose` for daemon problems.
