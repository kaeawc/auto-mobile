# UI tests

AutoMobile UI tests keep the test assertion in Kotlin or Swift and the device
steps in a YAML plan that you can review, reuse, and run locally or in CI.

`executePlan` accepts Android, iOS, tvOS, visionOS, and watchOS sessions. Each step
must use a tool supported on the target platform. visionOS and watchOS plans do
not record video.

## 1. Install a test runner

<div class="content-tabs" markdown>

### Android

**Gradle**

Maven Central has the AutoMobile Android libraries only up to `0.0.67`. To use a
newer release, build the runner from that release's tag and publish it to your
local Maven repository (`~/.m2`). This needs JDK 21 and an Android SDK
(`ANDROID_HOME` set, or `sdk.dir` in `android/local.properties`):

```bash
git clone --depth 1 --branch 0.0.94 https://github.com/kaeawc/auto-mobile.git
cd auto-mobile/android
./gradlew :test-plan-validation:publishToMavenLocal :junit-runner:publishToMavenLocal -PVERSION_NAME=0.0.94
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
    testImplementation("dev.jasonpearson.auto-mobile:auto-mobile-junit-runner:0.0.94")
}
```

To resolve the runner from Maven Central instead, skip the build and leave out
`mavenLocal()`. Use version `0.0.67` for the runner and for the CLI pin in
[Pin a release in CI](#6-pin-a-release-in-ci).

The runner executes as a normal JVM test, with no test APK or
`connectedAndroidTest` task. Ensure `adb` is on `PATH` and an Android device or
emulator is available.

### iOS

**Swift Package Manager**

Add AutoMobile from GitHub in Xcode (**File → Add Package Dependencies…**), then add the `XCTestRunner` product to the test target.

For a Swift package manifest, use the released package:

```swift
.package(url: "https://github.com/kaeawc/auto-mobile.git", from: "0.0.94")
```

`from:` resolves the newest compatible AutoMobile release, not an exact pin. The package requires Swift 6 and supports macOS 15 or iOS 17 test bundles. AI-assisted recovery runs only in a macOS test bundle, not in an iOS Simulator test bundle.

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
`execute()` to pick the device. With the default `device = "auto"`:

- a set `ANDROID_SERIAL` pins every single-device plan to that serial, and the
  class's tests run one at a time;
- otherwise the test uses the first booted device no other session holds.

Multi-device plans (section 4) choose their own devices and ignore
`ANDROID_SERIAL`. The test acquires the device with `getAndroid` before the plan
runs and releases it afterwards. If it cannot acquire the device, for example
because another session holds it, `result.output` says so.

A device you acquired yourself with `getAndroid` over MCP stays held while your
MCP connection is open, so the test cannot acquire it. Release it first with
`auto-mobile --daemon release-session <sessionUuid>` against the same daemon; the
device stays booted. The `sessionUuid` comes from the `getAndroid` result or from
`auto-mobile --daemon active-sessions`. Or point `ANDROID_SERIAL` at a device no
session holds.

**Daemon.** The runner uses the daemon on `AUTOMOBILE_DAEMON_SOCKET_PATH` when it
is set, or the default per-user daemon otherwise. It starts one only if none is
running. It never stops or replaces a running daemon of a different version; the
test fails and names both versions. Restart the daemon with the runner's version,
or set `-Dautomobile.daemon.force.restart=true` (the default in CI) to let the
runner replace the default per-user daemon. The runner never restarts a daemon on
an explicit `AUTOMOBILE_DAEMON_SOCKET_PATH`.

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
Simulator. Unless you pass an explicit issued session to the executor, set
`AUTOMOBILE_DEVICE_ID` to the simulator UDID or override `deviceId` in the test
class. The `AUTOMOBILE_DEVICE_UDID` variable also works when `AUTOMOBILE_DEVICE_ID` is unset or
empty.

Without an explicit session, the test acquires its own device session before
executing the plan, and the daemon releases it after the plan completes.
Acquisition and execution errors include the daemon's message.

Add `observe.waitFor` steps at important checkpoints so failures explain which
state was missing.

**Waiting for text**

By default `observe` lists actionable rows in `skeleton` and static text, such as
a status label, in `context`. Read `context` to verify a
result.

| `waitFor` form                                                                      | Matches                                                                                                      |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Only `text` or `textAny`; or `for: "appear"` / `for: "textEquals"` with only `text` | Hierarchy nodes, then `skeleton` or `context` rows when no node carries the text                             |
| `for: "textEquals"`                                                                 | The exact, case-sensitive value                                                                              |
| `for: "clickable"`, `"disappear"` or `"countStable"`                                | Hierarchy nodes only                                                                                         |
| With `elementId`, `container` or `selectionStrategy`                                | A single hierarchy node                                                                                      |
| No `for`, with `className` or `contentDescription`                                  | A single hierarchy node                                                                                      |
| No `for`, with `textSource: "displayed"`                                            | `text` against displayed text only, not content descriptions or rows; `textMatch: "exact"` is case-sensitive |
| With top-level `layer` (`app` or `prototype`)                                       | That layer of the hierarchy only, with no row match                                                          |

</div>

### Export a recording as an XCTest

`exportPlan` and `recordToolCalls` with `action: "end"` return the recorded plan
YAML in `planContent`. Pass `format: "xctest"` to also get an `xctest` object for
an iOS test target (the default, `format: "yaml"`, returns the plan only):

| Field              | Use                                                                        |
| ------------------ | -------------------------------------------------------------------------- |
| `planFileName`     | Save `planContent` under this name, for example `save-note.yaml`           |
| `planResourcePath` | Where the plan must sit in the test bundle, `test-plans/<planFileName>`    |
| `swiftFileName`    | Save `swiftSource` under this name in the test target                      |
| `swiftSource`      | An `AutoMobileTestCase` subclass whose `planPath` is `planResourcePath`    |
| `className`        | The class name, derived from the plan name (`save-note` → `SaveNoteTests`) |

To wire it up, add a `test-plans` folder to the test target as a folder
reference (in Xcode, **Add Files…** with **Create folder references**). The bundle
then keeps the `test-plans/` prefix. Save the plan file in it, add the Swift file
to the same target, and run it as in [Consume the plan](#3-consume-the-plan).

### Step expectations

A step can check the screen after its tool succeeds. AutoMobile checks each
entry in its `expectations` in order against a fresh observation of the same
device, matching elements the way `tapOn` does. The first expectation that does
not hold fails the step, and therefore the plan. An `optional` step is skipped
instead, and the plan continues.

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

`selector` accepts `testTag` (matched like the `tapOn` `testTag` selector), one
id (`resourceId` or `elementId`), `text`, `contentDescription` and `className`.
Every field given must match the same element.

For `textEquals` and `textContains`, put the expected value in `text`, not in
`selector.text`. AutoMobile compares it with the text the element displays: an
editable field's value, else its text. It never uses the content description or
accessibility label. `textEquals` is case-sensitive; `textContains` ignores case.

Each expectation waits up to `timeoutMs` for the condition, so it tolerates a
screen that is still settling. The default is the `observe.waitFor` default.

A failed expectation's error names it and lists what was on screen, for example
`Expectation 1/2 (textEquals testTag="counter_value" text="1") failed: not
satisfied after 5000ms; 1 near match(es); observed texts: "0"`. The step's
`failureObservation` holds the full observation. An expectation with a missing
or contradictory field fails the step without observing. AutoMobile skips an
expectation `type` not in the table, and the plan result carries a warning naming
it.

### Result checks

To check the tool's returned result, add optional `expect` beside `params`.
`contains` and `notContains` are non-empty, case-sensitive literal strings; when
both are supplied, both must hold.

- `getLogs` checks the returned log messages joined with newlines.
- Other tools, including `observe`, check the serialized JSON payload.

These checks use the original result, before response trimming, and do not poll
or observe again. A violation fails the plan, or skips an `optional` step. A
`notContains` log check also fails on truncated output, since incomplete logs
cannot prove absence.

```yaml
- tool: getLogs
  params:
    since: run-start
    tags: [AcceptApp]
  expect:
    contains: "reply received: [hello ] action=reply"
    notContains: "reply received: [null]"
```

`getLogs` accepts `since: run-start` only during plan execution; outside a plan
it fails. Its window starts at the current execution, including when resuming at
a later step, and device tracks share it. The look-back rounds up to whole
seconds, minimum one, so lines just before the start can appear. The one-hour cap
and output limits still apply.

### Plan parameters and special characters

A `${paramName}` value reaches the tool exactly as your test supplied it. This
holds for any characters: backslashes, quotes, ` #`, `: `, line breaks, unicode,
even `${other}`. The value never changes the plan's structure, and AutoMobile
substitutes it once, without re-expanding it.

Write the placeholder in a double-quoted scalar to keep a value a string:
`text: "${password}"`. In an unquoted scalar the value keeps the type YAML would
read from it. With `timeout: ${ms}`, `500` stays a number and `true` a boolean. A
value that is not a plain scalar, such as `shoes #1`, becomes a string.

### Redacting sensitive parameters

Parameters can carry a token, password, or other secret. When AI-assisted
recovery is on and a step fails, the runner sends failure context to your
configured LLM provider. That context holds the substituted plan YAML, the error,
and sampled on-screen text, so it would disclose any secret in the plan.

Mark the sensitive parameter keys, and the runner masks their values
(`***REDACTED***`) in the plan YAML, error string, and on-screen samples it sends.
The **local** daemon still receives the real values, so the plan runs.

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

For a macOS test bundle driving iOS, set `secretParameterKeys` on
`AutoMobilePlanExecutor.Configuration`. The runner combines plan-declared and
runner-supplied keys, so either source protects the value. Recovery stays opt-in.

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

Use semantic labels and identifiers in plans. To exercise TalkBack or VoiceOver,
see [Accessibility in UI tests](ui-tests-accessibility.md).

## 6. Pin a release in CI

Use one release version for the test runner and the AutoMobile CLI. Restart a
shared daemon so it receives the pin, then check the environment before tests:

```bash
export AUTOMOBILE_VERSION=0.0.94
bunx @kaeawc/auto-mobile@0.0.94 --daemon restart
bunx @kaeawc/auto-mobile@0.0.94 --cli doctor
```

Replace `0.0.94` with the version used by your test runner dependency.

`--cli doctor` reports the status of AutoMobile on each booted Android device,
including whether the accessibility service is installed and up to date. It never
changes the device. If it reports a mismatch, run an
AutoMobile device tool such as `observe` against that device to repair it, or
run `--daemon restart` or `--daemon diagnose` for daemon problems.
