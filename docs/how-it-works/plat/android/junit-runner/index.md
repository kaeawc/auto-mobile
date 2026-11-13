# Test runners

AutoMobile plans run from a normal platform test: the test owns pass/fail
assertions while the YAML plan keeps device actions easy to review. See
[UI tests](../../../../using/ui-tests.md) for setup and copy-paste code.

<div class="content-tabs" markdown>

## Android

The JUnit runner lets a normal JVM test execute a plan against a connected
Android device.

```mermaid
sequenceDiagram
  participant Gradle as Gradle testDebugUnitTest
  participant Runner as AutoMobileRunner (JVM)
  participant Daemon as AutoMobile Daemon
  participant Device as Android device (ADB)

  Gradle->>Runner: run test class
  Runner->>Daemon: connect
  Runner->>Daemon: getAndroid (acquire a device session)
  Runner->>Daemon: execute YAML plan under the issued session
  Daemon->>Device: launch, observe, interact
  Device-->>Daemon: UI state and screenshots
  Daemon-->>Runner: success or failed step
  Runner->>Daemon: release the session
  Runner-->>Gradle: pass or fail
```

Each attempt runs under a session the daemon issued: the daemon refuses a
`sessionUuid` it never issued, so the runner acquires one with `getAndroid`
(on the configured device or `ANDROID_SERIAL`, otherwise the first booted
device `automobile:devices/booted/android` lists as free) and releases it when
the attempt ends. A failed attempt held for AI recovery is released by the
recovery flow instead, unless the daemon reports it as not held.

## iOS

The XCTestRunner lets an `AutoMobileTestCase` execute a plan against a booted
iOS Simulator.

```mermaid
sequenceDiagram
  participant Xcode as xcodebuild test
  participant Runner as AutoMobileTestCase (XCTest)
  participant Daemon as AutoMobile Daemon
  participant Sim as iOS Simulator

  Xcode->>Runner: run test case
  Runner->>Daemon: connect
  Runner->>Daemon: execute YAML plan
  Daemon->>Sim: launch, observe, interact
  Sim-->>Daemon: UI state and screenshots
  Daemon-->>Runner: success or failed step
  Runner-->>Xcode: pass or fail
```

</div>
