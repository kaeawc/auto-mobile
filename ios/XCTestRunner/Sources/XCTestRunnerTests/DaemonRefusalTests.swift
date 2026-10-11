import Foundation
import XCTest
@testable import XCTestRunner
import XCTestRunnerTestSupport

/// The executor reads the daemon's typed refusals (#11195) instead of failing them as an opaque
/// decode error: held-device codes are waited out within Android's bounded budget, honouring
/// `retryAfterMs`, and `nextAction: acquire_new_session` retries under a fresh session.
final class DaemonRefusalTests: XCTestCase {
    private typealias Refusal = AutoMobilePlanExecutor.DaemonRefusal

    // MARK: - Payloads

    /// A real daemon reply, captured by `test/daemon/desktopWireContract.test.ts` from the daemon's
    /// handlers: the `rotate` tool call refused because another session holds the device.
    private func capturedHeldDeviceToolRefusal() throws -> String {
        let fixture = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // XCTestRunnerTests
            .deletingLastPathComponent() // Sources
            .deletingLastPathComponent() // XCTestRunner
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // repository root
            .appendingPathComponent("test/fixtures/desktop-wire/held-device-input-refused.json")
        let root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [String: Any]
        )
        let exchanges = try XCTUnwrap(root["exchanges"] as? [[String: Any]])
        let refused = try XCTUnwrap(exchanges.first { $0["label"] as? String == "rotate-refused" })
        let response = try XCTUnwrap(refused["response"] as? [String: Any])
        let result = try XCTUnwrap(response["result"] as? [String: Any])
        let content = try XCTUnwrap(result["content"] as? [[String: Any]])
        return try XCTUnwrap(content.first?["text"] as? String)
    }

    /// `sessionOwnershipLostPayload` for a session terminalized by another daemon (#11098), as the
    /// Android runner's tests pin it.
    private let terminalSessionPayload = """
    {"error":{"code":"session_ownership_lost","message":"Session terminal","sessionUuid":"test-session",\
    "reason":"identity-recovery-owned-by-other-daemon","retryable":false,"nextAction":"acquire_new_session",\
    "ownerPid":4242,"recovery":{"action":"acquire_replacement_session","tools":["getAndroid","getApple"]}}}
    """

    /// `shapeToolCallError` for a `DeviceCleanupInProgressError` (#10960).
    private let cleanupPayload = """
    {"success":false,"error":"Device 'sim-1' is still completing the previous session's cleanup",\
    "code":"device_cleanup_in_progress","deviceId":"sim-1","retryable":true,"retryAfterMs":4000}
    """

    /// `shapeToolCallError` for a `DeviceShuttingDownError` (#11088).
    private let shuttingDownPayload = """
    {"success":false,"error":"Device 'sim-1' is shutting down (code device_shutting_down)",\
    "code":"device_shutting_down","deviceId":"sim-1","retryable":true,"retryAfterMs":2000}
    """

    private let successPayload = #"{"success":true,"executedSteps":1,"totalSteps":1}"#

    // MARK: - Parsing

    func testParsesTheCapturedHeldDeviceRefusal() throws {
        let refusal = try XCTUnwrap(Refusal.parse(capturedHeldDeviceToolRefusal()))
        XCTAssertEqual(refusal.code, "device_owned_by_other_session")
        XCTAssertFalse(refusal.retryable)
        XCTAssertTrue(refusal.message.hasPrefix("rotate refused: device 'emulator-5554' is held by another session."))
        XCTAssertTrue(refusal.waitsForDevice, "a held device is waited out even though retryable is false")
    }

    func testParsesTheNestedSessionEnvelope() throws {
        let refusal = try XCTUnwrap(Refusal.parse(terminalSessionPayload))
        XCTAssertEqual(refusal.code, "session_ownership_lost")
        XCTAssertEqual(refusal.message, "Session terminal")
        XCTAssertEqual(refusal.nextAction, "acquire_new_session")
        XCTAssertTrue(refusal.acquiresNewSession)
        XCTAssertFalse(refusal.waitsForDevice)
    }

    func testReadsRetryAfterMs() throws {
        let refusal = try XCTUnwrap(Refusal.parse(cleanupPayload))
        XCTAssertEqual(refusal.retryAfterMs, 4000)
        XCTAssertTrue(refusal.retryable)
    }

    func testPlanResultsAndSuccessesAreNotRefusals() {
        XCTAssertNil(Refusal.parse(successPayload))
        XCTAssertNil(Refusal.parse(#"{"success":false,"executedSteps":1,"totalSteps":3,"error":"step failed"}"#))
        XCTAssertNil(Refusal.parse(#"{"enabled":true}"#))
        XCTAssertNil(Refusal.parse("not json"))
    }

    func testCapacityAndDiscoveryCodesWaitOnlyWhenRetryable() {
        for code in ["capacity_exhausted", "discovery_incomplete"] {
            let retryable = Refusal(code: code, message: "m", retryable: true, nextAction: nil, retryAfterMs: nil)
            let terminal = Refusal(code: code, message: "m", retryable: false, nextAction: nil, retryAfterMs: nil)
            XCTAssertTrue(retryable.waitsForDevice, code)
            XCTAssertFalse(terminal.waitsForDevice, code)
        }
    }

    func testBackoffDoublesToTheCapHonoursRetryAfterAndStopsAtTheBudget() {
        var backoff = AutoMobilePlanExecutor.DeviceWaitBackoff()
        var delays: [Int] = []
        while let delay = backoff.nextDelayMs(retryAfterMs: nil) {
            delays.append(delay)
        }
        XCTAssertEqual(delays, [500, 1000, 2000, 4000, 4000, 4000, 4000, 4000, 4000, 2500])
        XCTAssertEqual(backoff.waitedMs, 30000, "the same 30 s budget as the Android runner")

        var hinted = AutoMobilePlanExecutor.DeviceWaitBackoff()
        XCTAssertEqual(hinted.nextDelayMs(retryAfterMs: 2000), 2000, "a longer hint replaces the first step")
        XCTAssertEqual(hinted.nextDelayMs(retryAfterMs: 100), 1000, "a shorter hint never undercuts the backoff")
        var nearlySpent = AutoMobilePlanExecutor.DeviceWaitBackoff(budgetMs: 3000)
        XCTAssertEqual(nearlySpent.nextDelayMs(retryAfterMs: 60000), 3000, "a hint never extends the budget")
        XCTAssertNil(nearlySpent.nextDelayMs(retryAfterMs: nil))
    }

    /// #11538: the finalize wait ends when the daemon finishes and is bounded by the remaining-time
    /// hint (clamped to 150 s) for the two finalize codes only; every other code keeps 30 s.
    func testFinalizeWaitEndsWhenTheDaemonFinishesAndIsBoundedForFinalizeCodesOnly() {
        let cases: [(String, Bool, Int?, Int)] = [
            ("device_cleanup_in_progress", true, nil, 30000),
            ("device_cleanup_in_progress", true, 1000, 1500),
            ("device_cleanup_in_progress", true, 125_000, 125_000),
            ("device_cleanup_in_progress", true, 600_000, 150_000),
            ("device_shutting_down", true, nil, 30000),
            ("device_shutting_down", true, 1000, 1500),
            ("device_shutting_down", true, 125_000, 125_000),
            ("device_shutting_down", true, 600_000, 150_000),
            ("device_owned_by_other_session", false, 125_000, 30000),
            ("device_owned_by_other_daemon", false, 125_000, 30000),
            ("capacity_exhausted", false, 125_000, 30000),
            ("discovery_incomplete", false, 125_000, 30000),
        ]
        for (code, finalizes, finalizeAtMs, total) in cases {
            var backoff = AutoMobilePlanExecutor.DeviceWaitBackoff()
            while !(finalizes && finalizeAtMs.map { backoff.waitedMs >= $0 } == true) {
                // For the finalize codes the daemon's retryAfterMs is the finalize time remaining.
                let hint = finalizes ? finalizeAtMs.map { $0 - backoff.waitedMs } : finalizeAtMs
                if backoff.nextDelayMs(retryAfterMs: hint, code: code) == nil { break }
            }
            XCTAssertEqual(backoff.waitedMs, total, "\(code)/\(String(describing: finalizeAtMs))")
        }
    }

    func testCleanupRefusalAdvertisingTheFinalizeCapIsRetriedOnTheOrdinaryBackoff() async throws {
        let client = RefusalMCPClient()
        let refusal =
            #"{"success":false,"error":"finalizing","code":"device_cleanup_in_progress","retryable":true,"retryAfterMs":125000}"#
        client.executePlanReplies = [refusal, refusal, refusal, successPayload]
        let scheduler = RecordingScheduler()
        let executor = makeExecutor(client: client, scheduler: scheduler, retryCount: 0)

        let result = try await executor.execute(sessionUuid: "first")

        XCTAssertTrue(result.success)
        XCTAssertEqual(scheduler.delays, [0.5, 1.0, 2.0])
        XCTAssertEqual(client.executePlanSessions.count, 4)
    }

    // MARK: - Executor

    func testHeldDeviceRefusalIsWaitedOutUnderFreshSessionsWithoutSpendingARetry() async throws {
        let client = RefusalMCPClient()
        try client.executePlanReplies = [capturedHeldDeviceToolRefusal(), cleanupPayload, successPayload]
        let scheduler = RecordingScheduler()
        let executor = makeExecutor(client: client, scheduler: scheduler, retryCount: 0)

        let result = try await executor.execute(sessionUuid: "first")

        XCTAssertTrue(result.success)
        XCTAssertEqual(scheduler.delays, [0.5, 1.0], "the finalize refusal stays on the ordinary backoff (#11538)")
        XCTAssertEqual(client.executePlanSessions, ["first", "session-1", "session-2"])
    }

    func testHeldDeviceGivesUpAfterTheBudgetWithoutRetrying() async throws {
        let client = RefusalMCPClient()
        let refusal = try capturedHeldDeviceToolRefusal()
        client.executePlanReplies = Array(repeating: refusal, count: 20)
        let scheduler = RecordingScheduler()
        let executor = makeExecutor(client: client, scheduler: scheduler, retryCount: 2)

        do {
            _ = try await executor.execute(sessionUuid: "first")
            XCTFail("expected the bounded wait to give up")
        } catch let AutoMobilePlanExecutor.ExecutorError.deviceUnavailable(message) {
            XCTAssertTrue(message.contains("device_owned_by_other_session"), message)
            XCTAssertTrue(message.contains("waited 30000ms"), message)
        }
        XCTAssertEqual(scheduler.delays.reduce(0, +), 30, accuracy: 0.001)
        XCTAssertEqual(client.executePlanSessions.count, scheduler.delays.count + 1, "no retry after giving up")
    }

    func testRefusedSetToolEnabledIsWaitedOutAndNeverReachesExecutePlan() async throws {
        let client = RefusalMCPClient()
        client.setToolEnabledReplies = [shuttingDownPayload]
        client.executePlanReplies = [successPayload]
        let scheduler = RecordingScheduler()
        let executor = makeExecutor(client: client, scheduler: scheduler, retryCount: 0)

        let result = try await executor.execute(sessionUuid: "first")

        XCTAssertTrue(result.success)
        XCTAssertEqual(scheduler.delays, [0.5], "a shutting-down refusal stays on the ordinary backoff (#11538)")
        XCTAssertEqual(client.setToolEnabledSessions, ["first", "session-1"])
        XCTAssertEqual(client.executePlanSessions, ["session-1"], "the refused session never ran executePlan")
    }

    func testAcquireNewSessionRetriesUnderAFreshSession() async throws {
        let client = RefusalMCPClient()
        client.executePlanReplies = [terminalSessionPayload, successPayload]
        let executor = makeExecutor(client: client, scheduler: RecordingScheduler(), retryCount: 1)

        let result = try await executor.execute(sessionUuid: "first")

        XCTAssertTrue(result.success)
        XCTAssertEqual(client.executePlanSessions, ["first", "session-1"])
    }

    func testTerminalRefusalSurfacesItsCodeInsteadOfADecodeError() async throws {
        let client = RefusalMCPClient()
        client.executePlanReplies = [terminalSessionPayload]
        let executor = makeExecutor(client: client, scheduler: RecordingScheduler(), retryCount: 0)

        do {
            _ = try await executor.execute(sessionUuid: "first")
            XCTFail("expected the refusal to throw")
        } catch let AutoMobilePlanExecutor.ExecutorError.refused(tool, refusal) {
            XCTAssertEqual(tool, "executePlan")
            XCTAssertEqual(refusal.code, "session_ownership_lost")
        }
    }

    /// `managedEndedPayload` (#11341): a managed connection's answer after its execution's session was
    /// released. The runner decides whether to relaunch, so it is neither retried nor treated as
    /// acquire-new-session.
    func testManagedExecutionEndedIsTerminalAndNotRetried() async throws {
        let payload = """
        {"error":{"code":"managed_execution_ended","message":"ended","sessionUuid":"s1",\
        "reason":"heartbeat_timeout","retryable":false,"nextAction":"relaunch_execution",\
        "slotIndex":1,"assignmentGeneration":3}}
        """
        let refusal = try XCTUnwrap(Refusal.parse(payload))
        XCTAssertEqual(refusal.code, "managed_execution_ended")
        XCTAssertFalse(refusal.retryable)
        XCTAssertFalse(refusal.acquiresNewSession)
        XCTAssertFalse(refusal.waitsForDevice)

        let client = RefusalMCPClient()
        client.executePlanReplies = [payload, successPayload]
        let scheduler = RecordingScheduler()
        let executor = makeExecutor(client: client, scheduler: scheduler, retryCount: 2)
        do {
            _ = try await executor.execute(sessionUuid: "first")
            XCTFail("expected the refusal to throw")
        } catch let AutoMobilePlanExecutor.ExecutorError.refused(_, refused) {
            XCTAssertEqual(refused.code, "managed_execution_ended")
        }
        XCTAssertEqual(client.executePlanSessions, ["first"])
        XCTAssertTrue(scheduler.delays.isEmpty)
    }

    /// #11544: a typed failed frame reaches the executor as `MCPClientError.refused`; only a retryable
    /// one is retried, a terminal code is not, and an untyped failure keeps the blind retry.
    func testFailedFramesAreRetriedOnlyWhenTheirTypedRetryableFlagSays() async throws {
        func frame(_ code: String?, retryable: Bool) -> MCPClientError {
            .refused(Refusal(code: code, message: "m", retryable: retryable, nextAction: nil, retryAfterMs: nil))
        }
        let cases: [(String, MCPClientError, Int)] = [
            ("daemon_queue_timeout", frame("daemon_queue_timeout", retryable: true), 2),
            ("daemon_shutting_down", frame("daemon_shutting_down", retryable: true), 2),
            ("daemon_restart_pending", frame("daemon_restart_pending", retryable: true), 2),
            ("session_recovery_pending", frame("session_recovery_pending", retryable: true), 2),
            ("daemon_session_suspect", frame("daemon_session_suspect", retryable: true), 2),
            ("device_outside_bound_session", frame("device_outside_bound_session", retryable: false), 1),
            ("some_terminal_code", frame("some_terminal_code", retryable: false), 1),
            ("untyped", .serverError("daemon request timeout"), 2),
        ]
        for (name, error, calls) in cases {
            let client = RefusalMCPClient()
            client.executePlanErrors = [error, error, error]
            let executor = makeExecutor(client: client, scheduler: RecordingScheduler(), retryCount: 1)

            do {
                _ = try await executor.execute(sessionUuid: "first")
                XCTFail("\(name): expected the failure to throw")
            } catch {}
            XCTAssertEqual(client.executePlanSessions.count, calls, name)
        }
    }

    func testAFailedFrameForAHeldDeviceIsWaitedOutWithoutSpendingARetry() async throws {
        let client = RefusalMCPClient()
        client.executePlanErrors = [
            .refused(Refusal(
                code: "device_owned_by_other_session", message: "held", retryable: false, nextAction: nil,
                retryAfterMs: nil
            )),
        ]
        client.executePlanReplies = [successPayload]
        let scheduler = RecordingScheduler()
        let executor = makeExecutor(client: client, scheduler: scheduler, retryCount: 0)

        let result = try await executor.execute(sessionUuid: "first")

        XCTAssertTrue(result.success)
        XCTAssertEqual(scheduler.delays, [0.5])
    }

    func testNonRetryableTypedRefusalIsNotRetried() async throws {
        let client = RefusalMCPClient()
        client.executePlanReplies = [
            #"{"success":false,"error":"no booted simulator","code":"discovery_incomplete","retryable":false}"#,
            successPayload,
        ]
        let scheduler = RecordingScheduler()
        let executor = makeExecutor(client: client, scheduler: scheduler, retryCount: 2)

        do {
            _ = try await executor.execute(sessionUuid: "first")
            XCTFail("expected the refusal to throw")
        } catch let AutoMobilePlanExecutor.ExecutorError.refused(_, refusal) {
            XCTAssertEqual(refusal.code, "discovery_incomplete")
        }
        XCTAssertEqual(client.executePlanSessions, ["first"])
        XCTAssertTrue(scheduler.delays.isEmpty)
    }

    // MARK: - Helpers

    private func makeExecutor(
        client: RefusalMCPClient,
        scheduler: RecordingScheduler,
        retryCount: Int
    )
        -> AutoMobilePlanExecutor
    {
        let ids = SequentialIds()
        return AutoMobilePlanExecutor(
            configuration: AutoMobilePlanExecutor.Configuration(
                transport: .daemonUnixSocket(path: "/tmp/xctestrunner-refusal-test.sock"),
                planPath: "refusal-plan.yaml",
                retryCount: retryCount,
                timeoutSeconds: 5,
                retryDelaySeconds: 0,
                aiAssistance: false
            ),
            planLoader: FixedPlanLoader(),
            mcpClient: client,
            timer: FakeTimer(),
            logger: QuietLogger(),
            recoveryModelConfig: nil,
            daemonEnsurer: HermeticDaemonEnsurer(),
            deadlineScheduler: scheduler,
            idGenerator: { ids.next() },
            heldSessionController: RecordingHeldSessionController()
        )
    }
}

private struct FixedPlanLoader: AutoMobilePlanLoading {
    func loadPlan(at _: String, bundle _: Bundle?) throws -> String {
        "name: Refusal Plan\nsteps:\n  - tool: observe\n"
    }
}

private struct QuietLogger: AutoMobileLogger {
    func info(_: String) {}
    func warn(_: String) {}
    func error(_: String) {}
}

private final class SequentialIds: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func next() -> String {
        lock.lock()
        defer { lock.unlock() }
        count += 1
        return "session-\(count)"
    }
}

/// Returns at once and records each requested delay, so the wait runs in no real time.
private final class RecordingScheduler: DeadlineScheduler, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [TimeInterval] = []

    var delays: [TimeInterval] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    func sleep(seconds: TimeInterval) async throws {
        try Task.checkCancellation()
        record(seconds)
    }

    private func record(_ seconds: TimeInterval) {
        lock.lock()
        defer { lock.unlock() }
        recorded.append(seconds)
    }
}

/// Sequential fake: the executor calls it serially; tests inspect it after the awaited run.
private final class RefusalMCPClient: AutoMobileMCPClient, @unchecked Sendable {
    var setToolEnabledReplies: [String] = []
    var executePlanReplies: [String] = []
    /// Failures thrown (in order) before any reply is served, as a failed daemon frame is.
    var executePlanErrors: [MCPClientError] = []
    private(set) var setToolEnabledSessions: [String] = []
    private(set) var executePlanSessions: [String] = []

    func initialize(timeout _: TimeInterval) async throws {}

    func callTool(name: String, arguments: [String: Any], timeout _: TimeInterval) async throws -> MCPToolResponse {
        let session = arguments["sessionUuid"] as? String ?? ""
        switch name {
        case "setToolEnabled":
            setToolEnabledSessions.append(session)
            let reply = setToolEnabledReplies.isEmpty ? #"{"enabled":true}"# : setToolEnabledReplies.removeFirst()
            return MCPToolResponse(text: reply)
        case "executePlan":
            executePlanSessions.append(session)
            if !executePlanErrors.isEmpty { throw executePlanErrors.removeFirst() }
            return MCPToolResponse(text: executePlanReplies.removeFirst())
        default:
            return MCPToolResponse(text: "{}")
        }
    }

    func readResource(uri _: String, timeout _: TimeInterval) async throws -> MCPResourceResponse {
        MCPResourceResponse(text: "{}")
    }

    func resetSession() {}
}
