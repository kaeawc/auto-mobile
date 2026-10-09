# iOS XCTest Runner

XCTest integration framework for executing AutoMobile YAML automation plans.

## Overview

The XCTest Runner provides XCTest integration for iOS automation, mirroring the Android JUnitRunner functionality. It enables:

- Execution of YAML automation plans within XCTest framework
- Automatic retry logic for flaky tests
- Timing data collection and performance tracking
- XCTestObservation integration for test lifecycle hooks
- Environment variable configuration
- Test ordering and organization

## Architecture

This component:

1. Provides `AutoMobileTestCase` base class for plan-based tests
2. Wraps plan execution with `AutoMobilePlanExecutor`
3. Integrates with XCTestObservation for timing and lifecycle events
4. Supports configuration via environment variables and test schemes
5. Enables timing history collection and analysis

## Components

### AutoMobileTestCase

Base XCTestCase class for executing automation plans:

```swift
import XCTest
import XCTestRunner

final class MyAppTests: AutoMobileTestCase {
    override var planPath: String { "Plans/login-flow.yaml" }
    override var retryCount: Int { 2 }
    override var timeoutSeconds: TimeInterval { 300 }

    func testLoginFlow() async throws {
        try await executePlan()
    }
}
```

### AutoMobilePlanExecutor

Executes automation plans with retry logic:

```swift
let config = AutoMobilePlanExecutor.Configuration(
    transport: .daemonUnixSocket(path: DaemonManager.socketPath),
    planPath: "Plans/checkout.yaml",
    retryCount: 3
)

let executor = AutoMobilePlanExecutor(configuration: config)
try await executor.execute()
```

### AutoMobileTestObserver

Collects timing data and test results:

```swift
// Register observer (typically in test suite setup)
let observer = AutoMobileTestObserver.register()

// After tests complete
let timingData = observer.getTimingData()
try observer.exportTimingData(to: "timing-history.json")
```

### Async migration (step 3 of 3)

This source-breaking migration ships in the next minor release (#6061, owner decision D29).
The test body, executor, recovery handler, and MCP transports now use native async calls.

Source breaks in this step and their replacements:
- `AutoMobileTestCase.executePlan()` is now `async throws`. Use `try await executePlan()` from an
  `async throws` XCTest method. Setup remains synchronous.
- The synchronous (throwing, non-async) `initialize`, `callTool`, and `readResource` methods are
  removed from `AutoMobileMCPClient`, `AutoMobileDaemonClient`, and `StreamableHTTPMCPClient`.
  Await the async methods instead, and implement native async methods in transport doubles.
  `resetSession()` remains synchronous.
- `AutoMobilePlanExecutor.init` no longer accepts `sessionIdProvider`. Pass `sessionUuid:` to
  `execute`, or inject the initializer's `idGenerator` for a fresh id per execution.
- The public `AutoMobileSession` type (including `shared`, `currentSessionUuid`, `setSessionUuid`,
  and `setCurrentSessionUuid`) is removed. Keep the id explicitly and pass it to the executor;
  there is no thread-local or task-local session storage.

Session identity is one explicit value owned by the executor. The test case generates it once per
execution with its internal `idGenerator` and passes it to `execute(testMetadata:sessionUuid:)`.
For direct executor calls, an explicit `sessionUuid` wins; otherwise its injectable `idGenerator`
creates one id before suspension. That value survives all tool calls, retries, recovery, and resumed
attempts. The observer tracks test objects and timestamps, without consuming session ids.
Independent concurrent runs need distinct transport clients to isolate transport session lifetimes.

`XCTestCase.defaultTestSuite` is the sole synchronous fetch boundary. XCTest constructs the suite
before async test bodies run, so loading lazily on first async use cannot order a cold-start suite.
The private `SynchronousTimingFetch` next to `TestTimingCache` waits for an async resource read on a
synchronous XCTest thread, using the unchanged five-second default timeout and best-effort logging.
Never call it from an async context or the cooperative pool. Its awaited path must stay free of
main-actor/main-queue work; a source guard test enforces that invariant. Ordinary cache reads never
block on a fetch. The internal cache fetch seam supports hermetic tests without a daemon.

Timing prefetch preserves existing user-visible ordering: it passes an explicit fresh session id as
a row filter. No execution session exists at suite construction, so that filter matches no recorded
runs today. Omitting it would activate timing ordering and needs a separate owner decision (D-needed).
The general execution blocking bridge and legacy synchronous daemon connection adapter are deleted.

Earlier steps made `AutoMobilePlanExecutor.execute` async throwing, `PlanRecoveryHandler.attemptRecovery`
and `RecoveryConfigProviding` async nonthrowing, and removed `asyncBridge` and the semaphore recovery
bridge. Cancellation propagates as `CancellationError` without retry or recovery. Daemon preflight
and retry ensures still run on a dedicated dispatch queue; cancellation releases the await and
ignores a late ensure result. Only a daemon-socket retry resets the transport session, before its
virtual-testable delay; success, final failure, cancellation, and HTTP retries do not reset it.
Model deadlines return without joining uncooperative providers and discard late responses.

## Configuration

### Environment Variables

Primary:
- `AUTOMOBILE_MCP_URL` / `AUTOMOBILE_MCP_HTTP_URL`: MCP StreamableHTTP endpoint. Setting either (or
  the legacy `MCP_ENDPOINT`) selects the HTTP transport instead of the daemon Unix socket; the value
  is normalized to `…/auto-mobile/streamable`. The daemon answers POSTs with `text/event-stream`, so
  the client parses SSE frames as well as plain JSON bodies.
- `AUTOMOBILE_DAEMON_SOCKET_PATH`: Daemon socket path (default: `/tmp/auto-mobile-daemon-$UID.sock`;
  with `AUTOMOBILE_AUX_SOCKET_DIR` set, the same hash-suffixed path the daemon uses).
- `AUTOMOBILE_TEST_PLAN`: Path to YAML automation plan.
- `AUTOMOBILE_TEST_RETRY_COUNT`: Number of retry attempts (default: `0`).
- `AUTOMOBILE_TEST_TIMEOUT_SECONDS`: Test timeout in seconds (default: `300`).
- `AUTOMOBILE_TEST_RETRY_DELAY_SECONDS`: Retry backoff in seconds (default: `1`).
- `AUTOMOBILE_CI_MODE`: Marks runs as CI for metadata and timing fetch behavior.
- `AUTOMOBILE_APP_VERSION`: App version metadata passed to MCP.
- `AUTOMOBILE_GIT_COMMIT`: Git commit metadata passed to MCP.

Legacy (still supported):
- `AUTO_MOBILE_DAEMON_SOCKET_PATH`
- `MCP_ENDPOINT`
- `PLAN_PATH`
- `RETRY_COUNT`
- `TEST_TIMEOUT`
- `AUTO_MOBILE_APP_VERSION`
- `APP_VERSION`
- `AUTO_MOBILE_GIT_COMMIT`
- `GITHUB_SHA`
- `GIT_COMMIT`
- `CI_COMMIT_SHA`
- `CI`
- `GITHUB_ACTIONS`

### Test Scheme Settings

Configure in Xcode test scheme:
1. Edit Scheme → Test → Arguments
2. Add environment variables
3. Configure test ordering and parallelization

Test ordering and timing settings (via environment variables or UserDefaults):
- `automobile.junit.timing.ordering`: `auto`, `duration-asc`, `duration-desc`, `none`.
- `automobile.junit.timing.enabled`: Enable/disable timing fetch (default: `true`).
- `automobile.junit.timing.lookback.days`: Timing history window (default: `90`).
- `automobile.junit.timing.limit`: Max timing records to load (default: `1000`).
- `automobile.junit.timing.min.samples`: Minimum samples per test (default: `1`).
- `automobile.junit.timing.fetch.timeout.ms`: Timing fetch timeout in ms (default: `5000`).
- `automobile.ci.mode`: Disable timing fetch in CI (default: `false`).

Parallel worker count is derived from either:
- `-parallel-testing-worker-count <n>` (Xcode argument).
- `XCTEST_PARALLEL_THREAD_COUNT=<n>` (environment variable).

Example scheme argument values:
```
-automobile.junit.timing.ordering duration-desc
-automobile.junit.timing.limit 500
```

## Building

```bash
# Build the package
swift build

# Run hermetic async/session/timing tests; CI disables shared suite timing I/O
CI=1 swift test --filter 'AsyncExecutorTests|AsyncSourceInvariantTests|TestTimingCacheTests|AsyncDaemonTransportTests|AsyncHTTPTransportTests|AutoMobileDaemonClientTests|StreamableHTTPSSETests|AsyncProtocolWitnessTests|MCPConcurrencyTests'

# Build for iOS
xcodebuild -scheme XCTestRunner -destination 'platform=iOS Simulator,name=iPhone 15'
```

## Integration with Xcode

1. Add XCTestRunner package to your Xcode project
2. Import XCTestRunner in your test files
3. Subclass AutoMobileTestCase
4. Configure test scheme with environment variables
5. Run tests via Xcode Test Navigator or xcodebuild

When using the daemon socket transport (default), XCTestRunner will attempt to start the AutoMobile
daemon automatically if it cannot connect.

## Example Plans (Reminders)

Plan fixtures live in `ios/XCTestRunner/Sources/XCTestRunnerTests/Resources/Plans`:
- `Plans/launch-reminders-app.yaml`
- `Plans/add-reminder.yaml`

Platform-specific plans should declare a top-level `platform` field (e.g., `platform: ios`). Multi-device plans must declare platform per device at the top level.

`RemindersLaunchPlanTests` is a hermetic contract test. It loads the bundled launch plan,
executes `AutoMobilePlanExecutor` against an injected MCP fake, and verifies the complete
`setToolEnabled` / `executePlan` request without starting a daemon or simulator:

```swift
import XCTest
import XCTestRunner

final class RemindersLaunchPlanTests: XCTestCase {
    func testLaunchRemindersPlan() async throws {
        // Constructs an AutoMobilePlanExecutor with the bundled plan and an MCP fake.
    }
}
```

The contract test is implemented in
`ios/XCTestRunner/Sources/XCTestRunnerTests/RemindersIntegrationTests.swift` and runs as part
of the ordinary macOS Swift package test sweep:

```bash
swift test --filter RemindersLaunchPlanTests
```

The add-reminder sample remains an opt-in integration test that requires the daemon and a
booted iOS simulator:

```bash
AUTOMOBILE_DAEMON_SOCKET_PATH=/tmp/auto-mobile-daemon-$UID.sock \
swift test --filter RemindersAddPlanTests
```

Note: The Reminders plans assume English UI labels and may need adjustment for other locales.

## CI vs local execution

The opt-in Reminders integration uses daemon socket transport:

```bash
AUTOMOBILE_TEST_PLAN=Plans/add-reminder.yaml \
swift test --filter RemindersAddPlanTests
```

CI should set explicit MCP metadata:

```bash
AUTOMOBILE_CI_MODE=1 \
AUTOMOBILE_TEST_PLAN=Plans/add-reminder.yaml \
AUTOMOBILE_APP_VERSION="1.2.3" \
AUTOMOBILE_GIT_COMMIT="$GITHUB_SHA" \
xcodebuild test -scheme XCTestRunner -destination 'platform=iOS Simulator,name=iPhone 15'
```

## Development Status

**MVP Scaffold** - This is a minimal viable product scaffold with:
- AutoMobileTestCase base class
- AutoMobilePlanExecutor with retry logic
- XCTestObservation integration
- Timing data collection
- Test scaffolding

**Next Steps:**
- Implement YAML plan parsing (integrate Yams)
- Implement MCP client for tool execution
- Add assertion verification logic
- Add comprehensive test coverage
- Add example test cases
- Integrate with Xcode test schemes
