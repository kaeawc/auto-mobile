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

    private var recoveryFixtureDirectory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/refusal-wire")
    }

    private func recoveryFixtureText(_ file: URL) throws -> String {
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        let result = try XCTUnwrap(root["result"] as? [String: Any])
        let content = try XCTUnwrap(result["content"] as? [[String: Any]])
        return try XCTUnwrap(content.first?["text"] as? String)
    }

    private func assertUnhealthyMessage(_ message: String, refusal: Refusal) {
        XCTAssertTrue(message.contains("device_unhealthy"), message)
        XCTAssertTrue(message.contains(refusal.message), message)
        let rendered = refusal.unhealthyDevices.map {
            "\($0.deviceId) (\($0.reason), \($0.recovering ? "recovering" : "not recovering"))"
        }.joined(separator: ", ")
        XCTAssertFalse(refusal.unhealthyDevices.isEmpty)
        XCTAssertTrue(message.contains("Unhealthy devices: \(rendered)"), message)
    }

    func testRecoveryCorpusWaitsWithoutRetriesAndPermanentHealthFailuresIncludeReasons() async throws {
        let files = try FileManager.default.contentsOfDirectory(
            at: recoveryFixtureDirectory,
            includingPropertiesForKeys: nil
        )
        .filter { $0.pathExtension == "json" && $0.lastPathComponent != "expectations.json" }
        var hinted = false
        var unbounded = false
        var permanent = false
        for file in files {
            let text = try recoveryFixtureText(file)
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
            let envelope = object["error"] as? [String: Any]
            let code = (envelope?["code"] ?? object["code"]) as? String
            guard code == "device_unhealthy" || code == "session_held_by_recovery" else { continue }
            let recovering = ((envelope?["recovering"] ?? object["recovering"]) as? Bool) == true
            let retryable = ((envelope?["retryable"] ?? object["retryable"]) as? Bool) == true
            let waits = retryable && (code == "session_held_by_recovery" || recovering)
            let hint = ((envelope?["retryAfterMs"] ?? object["retryAfterMs"]) as? NSNumber)?.intValue
            let refusal = try XCTUnwrap(Refusal.parse(text))
            XCTAssertEqual(refusal.waitsForDevice, waits, file.lastPathComponent)
            XCTAssertEqual(refusal.recovering, recovering, file.lastPathComponent)
            if code == "device_unhealthy" {
                let entries = try XCTUnwrap((envelope?["devices"] ?? object["devices"]) as? [[String: Any]])
                let expectedDevices = try entries.map { entry in
                    try Refusal.UnhealthyDevice(
                        deviceId: XCTUnwrap(entry["deviceId"] as? String),
                        reason: XCTUnwrap(entry["reason"] as? String),
                        recovering: (entry["recovering"] as? Bool) == true
                    )
                }
                XCTAssertEqual(refusal.unhealthyDevices, expectedDevices, file.lastPathComponent)
            }
            let client = RefusalMCPClient()
            client.executePlanReplies = [text, successPayload]
            let scheduler = RecordingScheduler()
            let executor = makeExecutor(client: client, scheduler: scheduler, retryCount: waits ? 0 : 2)
            if waits {
                let result = try await executor.execute(sessionUuid: "first")
                XCTAssertTrue(result.success)
                XCTAssertEqual(scheduler.delays, [Double(max(500, hint ?? 0)) / 1000], file.lastPathComponent)
                XCTAssertEqual(client.executePlanSessions.count, 2)
                if code == "device_unhealthy" {
                    hinted = hinted || hint != nil
                    unbounded = unbounded || hint == nil
                }
            } else {
                do {
                    _ = try await executor.execute(sessionUuid: "first")
                    XCTFail("expected permanent refusal: \(file.lastPathComponent)")
                } catch {
                    if code == "device_unhealthy" {
                        assertUnhealthyMessage(String(describing: error), refusal: refusal)
                        XCTAssertTrue(
                            String(describing: error)
                                .contains("Replace the device with killDevice then startDevice.")
                        )
                    }
                }
                XCTAssertTrue(scheduler.delays.isEmpty)
                XCTAssertEqual(client.executePlanSessions.count, 1)
                permanent = permanent || (code == "device_unhealthy" && !recovering)
            }
        }
        XCTAssertTrue(hinted && unbounded && permanent)
    }

    func testRecoveryGiveUpSpendsExactlyTheBoundedBudgetAndReportsRecovery() async throws {
        for (name, lead) in [
            ("device_unhealthy", "Device is still being recovered"),
            ("session_held_by_recovery", "Session's device is still being recovered"),
        ] {
            let text = try recoveryFixtureText(recoveryFixtureDirectory.appendingPathComponent("\(name).json"))
            let refusal = try XCTUnwrap(Refusal.parse(text))
            let client = RefusalMCPClient()
            client.executePlanReplies = Array(repeating: text, count: 30)
            let scheduler = RecordingScheduler()
            let executor = makeExecutor(client: client, scheduler: scheduler, retryCount: 0)
            do {
                _ = try await executor.execute(sessionUuid: "first")
                XCTFail("expected recovery wait to give up")
            } catch let AutoMobilePlanExecutor.ExecutorError.deviceUnavailable(message) {
                XCTAssertTrue(message.hasPrefix("\(lead) (\(name))"), message)
                XCTAssertTrue(message.contains("The runner waited 30000ms for the recovery to finish."), message)
                if name == "device_unhealthy" { assertUnhealthyMessage(message, refusal: refusal) }
            }
            XCTAssertEqual(scheduler.delays.reduce(0, +), 30, accuracy: 0.001)
            XCTAssertEqual(client.executePlanSessions.count, scheduler.delays.count + 1)
        }
    }

    func testFailedHealthFramesWaitOrFailWithReasonsFromDetails() async throws {
        let files = try FileManager.default.contentsOfDirectory(
            at: recoveryFixtureDirectory.appendingPathComponent("surfaces"),
            includingPropertiesForKeys: nil
        ).filter { $0.lastPathComponent.hasPrefix("socket-frame.") && $0.pathExtension == "json" }
        var waitingUnhealthy = false
        var nonWaitingUnhealthy = false
        for file in files {
            let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
            let frame = try XCTUnwrap(root["payload"] as? [String: Any])
            let code = frame["code"] as? String
            guard code == "device_unhealthy" || code == "session_held_by_recovery" else { continue }
            let refusal = try XCTUnwrap(Refusal.parse(frame))
            let details = frame["details"] as? [String: Any]
            let waits = (frame["retryable"] as? Bool) == true &&
                (code == "session_held_by_recovery" || (details?["recovering"] as? Bool) == true)
            let hint = (frame["retryAfterMs"] as? NSNumber)?.intValue
            if code == "device_unhealthy" {
                waitingUnhealthy = waitingUnhealthy || waits
                nonWaitingUnhealthy = nonWaitingUnhealthy || !waits
            }
            let client = RefusalMCPClient()
            client.executePlanErrors = [.refused(refusal)]
            client.executePlanReplies = [successPayload]
            let scheduler = RecordingScheduler()
            let executor = makeExecutor(client: client, scheduler: scheduler, retryCount: waits ? 0 : 2)
            if waits {
                let result = try await executor.execute(sessionUuid: "first")
                XCTAssertTrue(result.success)
                XCTAssertEqual(scheduler.delays, [Double(max(500, hint ?? 0)) / 1000])
                XCTAssertEqual(client.executePlanSessions.count, 2)
            } else {
                do {
                    _ = try await executor.execute(sessionUuid: "first")
                    XCTFail("expected permanent failed frame")
                } catch {
                    if code == "device_unhealthy" {
                        assertUnhealthyMessage(String(describing: error), refusal: refusal)
                        XCTAssertTrue(
                            String(describing: error)
                                .contains("Replace the device with killDevice then startDevice.")
                        )
                    }
                }
                XCTAssertTrue(scheduler.delays.isEmpty)
                XCTAssertEqual(client.executePlanSessions.count, 1)
            }
        }
        XCTAssertTrue(waitingUnhealthy && nonWaitingUnhealthy)
    }

    func testRecoveringRequiresAStrictBooleanAndHealthFieldsUseEnvelopeThenPayloadThenDetails() throws {
        let text = try recoveryFixtureText(recoveryFixtureDirectory.appendingPathComponent("device_unhealthy.json"))
        var payload = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        payload["recovering"] = "true"
        XCTAssertFalse(try XCTUnwrap(Refusal.parse(payload)).recovering)
        payload.removeValue(forKey: "recovering")
        XCTAssertFalse(try XCTUnwrap(Refusal.parse(payload)).recovering)
        payload["details"] = ["recovering": true]
        XCTAssertTrue(try XCTUnwrap(Refusal.parse(payload)).recovering)
        payload["recovering"] = false
        payload["retryable"] = false
        XCTAssertFalse(try XCTUnwrap(Refusal.parse(payload)).recovering)
        let original = try XCTUnwrap(Refusal.parse(text))
        let devices = try XCTUnwrap(payload.removeValue(forKey: "devices") as? [[String: Any]])
        payload["error"] = ["message": original.message, "recovering": true, "devices": devices]
        let enveloped = try XCTUnwrap(Refusal.parse(payload))
        XCTAssertTrue(enveloped.recovering)
        XCTAssertEqual(enveloped.unhealthyDevices, original.unhealthyDevices)
        payload["error"] = original.message
        payload["recovering"] = true
        XCTAssertEqual(try XCTUnwrap(Refusal.parse(payload)).unhealthyDevices, original.unhealthyDevices)
    }

    func testDefaultRecoveringKeepsTheExistingPublicInitializerFromWaiting() {
        let refusal = Refusal(
            code: "device_unhealthy",
            message: "unhealthy",
            retryable: true,
            nextAction: nil,
            retryAfterMs: nil
        )
        XCTAssertFalse(refusal.waitsForDevice)
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
