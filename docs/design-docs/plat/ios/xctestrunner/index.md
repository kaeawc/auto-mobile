# XCTestRunner

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd> <kbd>📱 Simulator Only</kbd>

> **Current state:** `XCTestRunner` is a fully implemented Swift package (`ios/XCTestRunner/`) with
> `AutoMobileTestCase`, `AutoMobilePlanExecutor`, `AutoMobileTestObserver`, `TestTimingCache`,
> `AutoMobileSession`, and AI-assisted failure recovery (`TachikomaPlanRecoveryHandler`). Plans
> execute against a booted iOS Simulator via the AutoMobile daemon over a Unix domain socket.
> Published as a local SPM package; remote GitHub release in progress. Requires Swift 6.0+ and
> iOS 17 / macOS 14 (raised from iOS 15 / macOS 13 when the Tachikoma dependency was added for
> recovery). See the [Status Glossary](../../../status-glossary.md) for chip definitions.

The AutoMobile XCTestRunner lets you write host-side XCTest classes that drive a real iOS Simulator
over the AutoMobile daemon. Tests execute as ordinary unit tests inside a dedicated test target, so
they run with `xcodebuild test-without-building` with no separate UI test runner process required.

## How it works

```mermaid
sequenceDiagram
    participant X as xcodebuild test-without-building
    participant T as AutoMobileTestCase (XCTest)
    participant E as AutoMobilePlanExecutor
    participant D as AutoMobile Daemon
    participant S as iOS Simulator

    X->>T: run test method
    T->>E: setUpWithError → makeConfiguration
    T->>E: executePlan()
    E->>D: connect via Unix socket
    E->>D: executePlan(YAML content)
    D->>S: launchApp / observe / tapOn / …
    S-->>D: UI state + screenshots
    D-->>E: success / failedStep
    E-->>T: ExecutePlanResult
    T-->>X: PASS or FAIL
```

Each test class points to a YAML plan file bundled with the test target. The executor encodes the
plan and sends it to the AutoMobile daemon over a Unix domain socket. The daemon drives the
simulator step by step and returns a structured result. No separate UI test process or XCUITest
runner binary is involved.

## Why not XCUITest directly?

|                      | AutoMobile XCTestRunner                                  | XCUITest                          |
| -------------------- | -------------------------------------------------------- | --------------------------------- |
| **Runs as**          | Unit test target                                         | UI test target (separate process) |
| **Build required**   | Pre-built `.xctestrun` reused                            | Full UI test host recompile       |
| **Device needed at** | Test execution only                                      | Build time (linking) + execution  |
| **Parallel devices** | Daemon-managed pool                                      | One device per test bundle        |
| **AI recovery**      | Optional self-healing ([details](#ai-assisted-recovery)) | Not available                     |
| **Test authoring**   | YAML plans or AI prompt                                  | Swift/Objective-C code            |
| **App under test**   | Any installed app                                        | App compiled into UI test host    |

## Requirements

- macOS 14.0+ (Sonoma or newer)
- Xcode 16.0+ and Command Line Tools (Swift 6.0+ toolchain)
- iOS 17.0+ deployment target for the test host
- A booted iOS Simulator
- AutoMobile daemon running (`auto-mobile --daemon start`)
- CtrlProxy iOS installed in the simulator (see [CtrlProxy iOS](../ctrl-proxy-ios.md))

## Quick start

### 1. Add the dependency

=== "Local path (current)"
`yaml
    # ios/YourApp/project.yml (XcodeGen)
    packages:
      XCTestRunner:
        path: ../../libs/spm/XCTestRunner
    `

=== "Remote (once published)"
`yaml
    # ios/YourApp/project.yml (XcodeGen)
    packages:
      XCTestRunner:
        url: https://github.com/kaeawc/auto-mobile
        from: "0.0.14"
    `

    ```swift
    // Package.swift
    .package(url: "https://github.com/kaeawc/auto-mobile", from: "0.0.14")
    ```

See [Project Setup → Dependency](project-setup.md#dependency) for the full XcodeGen target
configuration and instructions for committing a local copy for CI reproducibility.

### 2. Write a test

```swift
// YourApp/Tests/AutoMobile/AppLaunchAutoMobileTests.swift
import XCTest
import XCTestRunner

final class AppLaunchAutoMobileTests: AutoMobileTestCase {

    override var planPath: String {
        "test-plans/launch-app.yaml"
    }

    override var cleanupOptions: AutoMobilePlanExecutor.CleanupOptions? {
        AutoMobilePlanExecutor.CleanupOptions(
            appId: "com.example.ios.YourApp",
            clearAppData: true
        )
    }

    override func setUpAutoMobile() throws {
        let daemonReady = DaemonManager.ensureDaemonRunning()
        guard daemonReady else {
            throw XCTSkip("AutoMobile daemon is not running and could not be started")
        }
    }

    func testAppLaunchesWithoutCrashing() throws {
        let result = try executePlan()
        XCTAssertTrue(result.success, "Plan failed: \(result.error ?? "unknown error")")
        XCTAssertGreaterThan(result.executedSteps, 0)
    }
}
```

### 3. Write the plan

```yaml
# YourApp/Tests/AutoMobile/test-plans/launch-app.yaml
name: launch-app
description: Launch the app and verify it opens without crashing
platform: ios
steps:
  - tool: launchApp
    appId: com.example.ios.YourApp
    clearAppData: true
    label: Launch the app with a clean state

  - tool: observe
    label: Verify the app UI renders without crashing

  - tool: terminateApp
    appId: com.example.ios.YourApp
    label: Terminate the app after test
```

### 4. Run

```bash
# Start the daemon (if not already running)
auto-mobile --daemon start &

# Build for testing
xcodebuild build-for-testing \
  -scheme YourApp \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -derivedDataPath build/DerivedData

# Run only the AutoMobile test bundle
xcodebuild test-without-building \
  -xctestrun build/DerivedData/Build/Products/*.xctestrun \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -only-testing:YourAppAutoMobileTests
```

See [Project Setup → Running tests locally](project-setup.md#running-tests-locally) for the full
step-by-step walkthrough.

## AI-assisted recovery

When a plan step fails, the executor can hand the failure to an AI agent that drives AutoMobile tools
to get the app back into the state the plan expects, then resumes from the **next** step — the iOS
counterpart to the Android JUnit runner's recovery loop. It is built on
[Tachikoma](https://github.com/steipete/Tachikoma) (a Swift AI SDK) rather than a bespoke client.

```mermaid
sequenceDiagram
    participant E as AutoMobilePlanExecutor
    participant H as TachikomaPlanRecoveryHandler
    participant M as LLM (Anthropic/OpenAI/Google)
    participant D as AutoMobile Daemon

    E->>D: executePlan(startStep = 0)
    D-->>E: failedStep(index = N, error, failureObservation)
    E->>H: attemptRecovery(FailedStepContext)
    loop up to maxToolCalls
        H->>M: prompt + tool results
        M-->>H: tool call (observe / tapOn / …)
        H->>D: callTool(...)
        D-->>H: result
    end
    H->>D: observe (verify device state)
    H-->>E: RecoveryOutcome(success)
    E->>D: executePlan(startStep = N + 1, pinned to device)
```

Key properties (parity with Android):

- **Gated**: runs only when `aiAssistance` is on, the `ai-recovery` feature flag is enabled, a model
  API key is present, and the run is not in CI.
- **At most once per test**: a second failure after a resume fails the test with the original error.
- **Backward compatible**: with no API key (CI, most unit tests) the handler is never constructed and
  the executor behaves exactly as before — a failed step throws.
- **Reuses the wire**: consumes the `failedStep.failureObservation` digest the daemon already sends,
  and reads the gate from the `automobile:config/feature-flags/ai-recovery` resource.

Configuration and model-selection env vars are documented in
[Writing Tests → AI-assisted recovery](writing-tests.md#ai-assisted-recovery). The implementation
lives in `AutoMobileRecovery.swift` (types + config) and `TachikomaPlanRecoveryHandler.swift` (the
agent loop); the executor wiring is in `AutoMobilePlanExecutor.handleFailure`.

## Pages in this section

| Page                                | What it covers                                                      |
| ----------------------------------- | ------------------------------------------------------------------- |
| [Project Setup](project-setup.md)   | SPM dependency, XcodeGen config, test target setup, running locally |
| [Writing Tests](writing-tests.md)   | `AutoMobileTestCase` properties, YAML plan reference, examples      |
| [CI Integration](ci-integration.md) | GitHub Actions, build-for-testing artifact, daemon setup            |

## Related

- [CtrlProxy iOS](../ctrl-proxy-ios.md) — Required for view hierarchy access and gesture injection
- [MCP Tools reference](../../../mcp/tools.md) — Full list of tools available in YAML plans
- [simctl integration](../simctl.md) — Simulator lifecycle management
