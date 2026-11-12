import Foundation
import XCTest
@testable import XCTestRunner
import XCTestRunnerTestSupport

@MainActor
final class SessionAcquisitionTests: XCTestCase {
    private let capturedSession = "5f35fd39-6573-4070-864c-3a8b0fb724ba"

    func testAcquiresCapturedAppleSessionWithConfiguredUdidBeforeEnablingAndExecuting() async throws {
        let client = AcquisitionMCPClient()
        client.replies["getApple"] = try [capturedAppleResponse()]
        let executor = makeExecutor(client: client, deviceId: "1AE70165-A725-4868-B2EF-FAB7AB66868F")

        _ = try await executor.execute()

        XCTAssertEqual(client.events, ["initialize", "getApple", "setToolEnabled", "executePlan"])
        XCTAssertEqual(client.calls[0].arguments["udid"] as? String, "1AE70165-A725-4868-B2EF-FAB7AB66868F")
        XCTAssertNil(client.calls[0].arguments["sessionUuid"], "acquisition mints the session")
        XCTAssertEqual(client.calls[1].arguments["sessionUuid"] as? String, capturedSession)
        XCTAssertEqual(client.calls[2].arguments["sessionUuid"] as? String, capturedSession)
    }

    func testAndroidPlanAcquiresWithDeviceId() async throws {
        let client = AcquisitionMCPClient()
        let executor = makeExecutor(client: client, platform: "android", deviceId: "emulator-5554")

        _ = try await executor.execute()

        XCTAssertEqual(client.events, ["initialize", "getAndroid", "setToolEnabled", "executePlan"])
        XCTAssertEqual(client.calls[0].arguments["deviceId"] as? String, "emulator-5554")
        XCTAssertNil(client.calls[0].arguments["udid"])
        XCTAssertEqual(client.calls[2].arguments["sessionUuid"] as? String, "issued-session")
    }

    func testAcquisitionRequiresADeviceIdentifier() async throws {
        for platform in ["ios", "android"] {
            for deviceId: String? in [nil, ""] {
                let client = AcquisitionMCPClient()
                do {
                    _ = try await makeExecutor(client: client, platform: platform, deviceId: deviceId).execute()
                    XCTFail("expected missing device identifier error for \(platform)")
                } catch let AutoMobilePlanExecutor.ExecutorError.invalidPlan(message) {
                    for guidance in [
                        "requires a device identifier", "AUTOMOBILE_DEVICE_ID", "AUTOMOBILE_DEVICE_UDID",
                        "override deviceId", "Configuration.deviceId", "explicit issued sessionUuid",
                    ] {
                        XCTAssertTrue(message.contains(guidance), message)
                    }
                }
                XCTAssertEqual(client.events, ["initialize"])
                XCTAssertTrue(client.calls.isEmpty, "missing identifiers must fail before any tool call")
            }
        }
    }

    func testExplicitSessionSkipsAcquisition() async throws {
        for platform in ["ios", "android"] {
            for deviceId: String? in [nil, ""] {
                let client = AcquisitionMCPClient()
                _ = try await makeExecutor(client: client, platform: platform, deviceId: deviceId)
                    .execute(sessionUuid: "already-acquired")
                XCTAssertEqual(client.events, ["initialize", "setToolEnabled", "executePlan"])
                XCTAssertEqual(client.calls.compactMap { $0.arguments["sessionUuid"] as? String }, [
                    "already-acquired", "already-acquired",
                ])
            }
        }
    }

    func testEnableFailuresReleaseOnlyTheAcquiredSessionExactlyOnce() async {
        for sessionUuid: String? in [nil, "caller-session"] {
            for response: MCPToolResponse? in [
                nil,
                MCPToolResponse(text: "enable failed", isError: true),
                MCPToolResponse(
                    text: #"{"success":false,"error":"terminal session","code":"daemon_session_not_found","retryable":false}"#,
                    isError: true
                ),
            ] {
                let client = AcquisitionMCPClient()
                if let response {
                    client.replies["setToolEnabled"] = [response]
                } else {
                    client.errors["setToolEnabled"] = .requestFailed("enable transport failed")
                }
                let heldSessions = RecordingHeldSessionController()
                let executor = makeExecutor(client: client, heldSessionController: heldSessions)

                await assertAsyncThrowsError { try await executor.execute(sessionUuid: sessionUuid) }

                XCTAssertEqual(heldSessions.releasedSessions, sessionUuid == nil ? ["issued-session"] : [])
                XCTAssertEqual(
                    client.events,
                    sessionUuid == nil
                        ? ["initialize", "getApple", "setToolEnabled"]
                        : ["initialize", "setToolEnabled"]
                )
            }
        }
    }

    func testCancellationBeforeDispatchReleasesOnlyTheAcquiredSessionOutsideCancellation() async throws {
        for sessionUuid: String? in [nil, "caller-session"] {
            for tool in sessionUuid == nil ? ["getApple", "setToolEnabled"] : ["setToolEnabled"] {
                let client = AcquisitionMCPClient()
                client.cancelOnCall = tool
                let heldSessions = RecordingHeldSessionController()
                let executor = makeExecutor(
                    client: client,
                    heldSessionController: CancellationCheckingHeldSessionController(recording: heldSessions)
                )
                let task = Task { try await executor.execute(sessionUuid: sessionUuid) }

                do {
                    _ = try await task.value
                    XCTFail("expected cancellation after \(tool)")
                } catch is CancellationError {}

                XCTAssertEqual(heldSessions.releasedSessions, sessionUuid == nil ? ["issued-session"] : [])
                XCTAssertEqual(client.events.last, tool)
                XCTAssertFalse(client.events.contains("executePlan"))
            }
        }
    }

    func testExecutePlanTransportAndDecodeErrorsReleaseOnlyTheAcquiredSessionExactlyOnce() async {
        for sessionUuid: String? in [nil, "caller-session"] {
            for recoveryEnabled in [false, true] {
                for transportError in [false, true] {
                    let client = AcquisitionMCPClient()
                    if transportError {
                        client.errors["executePlan"] = .requestFailed("plan transport failed")
                    } else {
                        client.replies["executePlan"] = [MCPToolResponse(text: "{broken")]
                    }
                    let heldSessions = RecordingHeldSessionController()
                    let executor = makeExecutor(
                        client: client,
                        heldSessionController: heldSessions,
                        recoveryEnabled: recoveryEnabled
                    )

                    await assertAsyncThrowsError { try await executor.execute(sessionUuid: sessionUuid) }

                    XCTAssertEqual(
                        heldSessions.releasedSessions,

                        sessionUuid == nil ? ["issued-session"] : (recoveryEnabled ? ["caller-session"] : [])
                    )
                    XCTAssertEqual(client.events.filter { $0 == "executePlan" }.count, 1)
                    XCTAssertEqual(
                        client.calls.last?.arguments["holdSessionOnFailure"] as? Bool,
                        recoveryEnabled ? true : nil
                    )
                }
            }
        }
    }

    func testCancellationAfterDispatchReleasesOnlyTheAcquiredSessionOutsideCancellation() async throws {
        for sessionUuid: String? in [nil, "caller-session"] {
            let client = AcquisitionMCPClient()
            client.cancelOnCall = "executePlan"
            let heldSessions = RecordingHeldSessionController()
            let executor = makeExecutor(
                client: client,
                heldSessionController: CancellationCheckingHeldSessionController(recording: heldSessions)
            )
            let task = Task { try await executor.execute(sessionUuid: sessionUuid) }

            do {
                _ = try await task.value
                XCTFail("expected cancellation after dispatch")
            } catch is CancellationError {}

            XCTAssertEqual(heldSessions.releasedSessions, sessionUuid == nil ? ["issued-session"] : [])
            XCTAssertEqual(client.events.last, "executePlan")
        }
    }

    func testSuccessfulRunReleasesOnlyTheAcquiredSessionExactlyOnce() async throws {
        for sessionUuid: String? in [nil, "caller-session"] {
            for recoveryEnabled in [false, true] {
                let client = AcquisitionMCPClient()
                let heldSessions = RecordingHeldSessionController()
                let executor = makeExecutor(
                    client: client, heldSessionController: heldSessions, recoveryEnabled: recoveryEnabled
                )

                let result = try await executor.execute(sessionUuid: sessionUuid)

                XCTAssertTrue(result.success)
                XCTAssertEqual(heldSessions.releasedSessions, sessionUuid == nil ? ["issued-session"] : [])
            }
        }
    }

    func testDecodedFailureReleasesOnlyTheAcquiredOrHeldSessionExactlyOnce() async {
        for sessionUuid: String? in [nil, "caller-session"] {
            for recoveryEnabled in [false, true] {
                let client = AcquisitionMCPClient()
                client.replies["executePlan"] = [MCPToolResponse(
                    text: #"{"success":false,"executedSteps":0,"totalSteps":1}"#
                )]
                let heldSessions = RecordingHeldSessionController()
                let executor = makeExecutor(
                    client: client, heldSessionController: heldSessions, recoveryEnabled: recoveryEnabled
                )

                await assertAsyncThrowsError { try await executor.execute(sessionUuid: sessionUuid) }

                XCTAssertEqual(
                    heldSessions.releasedSessions,
                    sessionUuid == nil ? ["issued-session"] : (recoveryEnabled ? ["caller-session"] : [])
                )
            }
        }
    }

    func testAcquiredSessionRecoveryReleasesExactlyOnceAfterResumeCompletes() async throws {
        for success in [false, true] {
            let client = AcquisitionMCPClient()
            client.replies["executePlan"] = [
                recoverableFailure,
                MCPToolResponse(text: "{\"success\":\(success),\"executedSteps\":1,\"totalSteps\":1}"),
            ]
            let heldSessions = RecordingHeldSessionController()
            let executor = makeExecutor(
                client: client,
                heldSessionController: heldSessions,
                recoveryEnabled: true,
                recoveryHandler: AcquisitionSuccessfulRecoveryHandler(heldSessions: heldSessions)
            )

            if success {
                let result = try await executor.execute()
                XCTAssertTrue(result.success)
                XCTAssertTrue(result.aiRecoverySuccessful)
            } else {
                await assertAsyncThrowsError { try await executor.execute() }
            }

            XCTAssertEqual(heldSessions.events, [
                .heartbeatStarted("issued-session"), .heartbeatStopped("issued-session"), .released("issued-session"),
            ])
            XCTAssertEqual(client.events.filter { $0 == "getApple" }.count, 1, "resume reuses the acquisition")
            let plans = client.calls.filter { $0.name == "executePlan" }
            XCTAssertEqual(plans.count, 2)
            XCTAssertEqual(plans.first?.arguments["holdSessionOnFailure"] as? Bool, true)
            XCTAssertNil(plans.last?.arguments["holdSessionOnFailure"])
        }
    }

    func testAcquiredSessionResumeFailuresReleaseExactlyOnceBeforeOrAfterDispatch() async {
        for beforeDispatch in [false, true] {
            let client = AcquisitionMCPClient()
            client.replies["executePlan"] = [recoverableFailure, MCPToolResponse(text: "{broken")]
            if beforeDispatch {
                client.replies["setToolEnabled"] = [
                    MCPToolResponse(text: #"{"enabled":true}"#),
                    MCPToolResponse(text: "enable failed", isError: true),
                ]
            }
            let heldSessions = RecordingHeldSessionController()
            let executor = makeExecutor(
                client: client,
                heldSessionController: heldSessions,
                recoveryEnabled: true,
                recoveryHandler: AcquisitionSuccessfulRecoveryHandler(heldSessions: heldSessions)
            )

            await assertAsyncThrowsError { try await executor.execute() }

            XCTAssertEqual(heldSessions.releasedSessions, ["issued-session"])
            XCTAssertEqual(client.events.filter { $0 == "executePlan" }.count, beforeDispatch ? 1 : 2)
        }
    }

    private var recoverableFailure: MCPToolResponse {
        MCPToolResponse(
            text: #"{"success":false,"executedSteps":0,"totalSteps":1,"sessionHeld":true,"failedStep":{"stepIndex":0,"tool":"observe","error":"retry","device":"configured-device"}}"#
        )
    }

    func testDaemonErrorsPreserveTextAtEveryToolBoundary() async throws {
        let message = "Session ABC is not an active daemon session (not found). Acquire a device first."
        for tool in ["getApple", "getAndroid", "setToolEnabled", "executePlan"] {
            for isError in [false, true] {
                let client = AcquisitionMCPClient()
                client.replies[tool] = [MCPToolResponse(text: message, isError: isError)]
                let executor = makeExecutor(client: client, platform: tool == "getAndroid" ? "android" : "ios")
                do {
                    _ = try await executor.execute()
                    XCTFail("expected daemon error for \(tool)")
                } catch let AutoMobilePlanExecutor.ExecutorError.daemonError(failedTool, text) {
                    XCTAssertEqual(failedTool, tool)
                    XCTAssertEqual(text, message)
                    XCTAssertTrue(AutoMobilePlanExecutor.ExecutorError.daemonError(
                        tool: failedTool, message: text
                    ).localizedDescription.contains(message))
                }
                XCTAssertEqual(client.calls.last?.name, tool, "a failed tool must stop the attempt")
            }
        }
    }

    func testErrorFlagPreservesAnUntypedJsonError() async throws {
        let client = AcquisitionMCPClient()
        let text = #"{"message":"daemon transport refused this call"}"#
        client.replies["executePlan"] = [MCPToolResponse(text: text, isError: true)]
        do {
            _ = try await makeExecutor(client: client).execute()
            XCTFail("expected daemon error")
        } catch let AutoMobilePlanExecutor.ExecutorError.daemonError(tool, message) {
            XCTAssertEqual(tool, "executePlan")
            XCTAssertEqual(message, text)
        }
    }

    func testMalformedJsonStillReportsADecodeFailure() async throws {
        for tool in ["getApple", "executePlan"] {
            let client = AcquisitionMCPClient()
            client.replies[tool] = [MCPToolResponse(text: "{broken")]
            do {
                _ = try await makeExecutor(client: client).execute()
                XCTFail("expected invalid JSON for \(tool)")
            } catch let AutoMobilePlanExecutor.ExecutorError.invalidResponse(message) {
                XCTAssertTrue(message.contains("Failed to decode \(tool)"), message)
            }
        }
    }

    func testMissingAcquiredSessionNeverEnablesOrExecutesThePlan() async throws {
        let client = AcquisitionMCPClient()
        client.replies["getApple"] = [MCPToolResponse(text: #"{"runtime":{"session":null}}"#)]
        do {
            _ = try await makeExecutor(client: client).execute()
            XCTFail("expected missing session error")
        } catch is AutoMobilePlanExecutor.ExecutorError {
            XCTAssertEqual(client.events, ["initialize", "getApple"])
        }
    }

    func testAcquisitionRefusalUsesDeviceWaitWithoutSpendingARetry() async throws {
        let client = AcquisitionMCPClient()
        client.replies["getApple"] = try [
            MCPToolResponse(
                text: #"{"success":false,"error":"device busy","code":"device_owned_by_other_session","retryAfterMs":500}"#,
                isError: true
            ),
            capturedAppleResponse(),
        ]
        let scheduler = VirtualDeadlineScheduler()
        let executor = makeExecutor(client: client, scheduler: scheduler)
        let task = Task { try await executor.execute() }
        try await scheduler.registered.wait(for: 1)
        XCTAssertEqual(client.events, ["initialize", "getApple"])
        scheduler.advance(by: 0.5)
        let result = try await task.value
        XCTAssertTrue(result.success)
        XCTAssertEqual(
            client.events,
            ["initialize", "getApple", "initialize", "getApple", "setToolEnabled", "executePlan"]
        )
        XCTAssertEqual(client.calls.last?.arguments["sessionUuid"] as? String, capturedSession)
        XCTAssertEqual(scheduler.requestedDelays, [0.5])
    }

    func testAcquisitionAmbiguityRetainsDaemonRefusalAndStopsBeforeEnable() async throws {
        let client = AcquisitionMCPClient()
        client.replies["getApple"] = [MCPToolResponse(
            text: #"{"success":false,"error":"Choose simulator A or B","code":"ambiguous_device_target","retryable":false}"#,
            isError: true
        )]
        do {
            _ = try await makeExecutor(client: client).execute()
            XCTFail("expected ambiguity refusal")
        } catch let AutoMobilePlanExecutor.ExecutorError.refused(tool, refusal) {
            XCTAssertEqual(tool, "getApple")
            XCTAssertEqual(refusal.code, "ambiguous_device_target")
            XCTAssertEqual(refusal.message, "Choose simulator A or B")
        }
        XCTAssertEqual(client.events, ["initialize", "getApple"])
        XCTAssertEqual(client.calls[0].arguments["udid"] as? String, "configured-device")
    }

    func testTestCaseDeviceEnvironmentPrecedenceAndConfiguration() async throws {
        for (values, expected): ([String: String], String?) in [
            (["AUTOMOBILE_DEVICE_ID": "serial", "AUTOMOBILE_DEVICE_UDID": "udid"], "serial"),
            (["AUTOMOBILE_DEVICE_ID": "", "AUTOMOBILE_DEVICE_UDID": "udid"], "udid"),
            ([:], nil),
        ] {
            let testCase = AcquisitionTestCase(selector: #selector(AcquisitionTestCase.planBody))
            testCase.environment = AutoMobileEnvironment(values: values)
            XCTAssertEqual(testCase.deviceId, expected)
            let client = AcquisitionMCPClient()
            testCase.executorFactory = { configuration in
                XCTAssertEqual(configuration.deviceId, expected)
                return AutoMobilePlanExecutor(
                    configuration: configuration,
                    planLoader: AcquisitionPlanLoader(platform: "ios"),
                    mcpClient: client,
                    timer: FakeTimer(),
                    logger: AcquisitionLogger(),
                    recoveryModelConfig: nil,
                    daemonEnsurer: HermeticDaemonEnsurer(),
                    deadlineScheduler: VirtualDeadlineScheduler(),
                    heldSessionController: RecordingHeldSessionController()
                )
            }
            // The custom socket avoids a daemon preflight; all tool calls use the fake.
            try testCase.setUpWithError()
            defer { try? testCase.tearDownWithError() }
            if expected != nil {
                _ = try await testCase.executePlan()
                XCTAssertEqual(client.calls.first?.name, "getApple")
                XCTAssertEqual(client.calls.first?.arguments["udid"] as? String, expected)
            }
        }
    }

    private func capturedAppleResponse() throws -> MCPToolResponse {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "getApple-capture", withExtension: "json"))
        let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        return try MCPToolResponse(text: MCPJSONRPCHelpers.extractTextContent(from: envelope))
    }

    private func makeExecutor(
        client: AcquisitionMCPClient,
        platform: String = "ios",
        deviceId: String? = "configured-device",
        scheduler: any DeadlineScheduler = VirtualDeadlineScheduler(),
        heldSessionController: HeldSessionControlling = RecordingHeldSessionController(),
        recoveryEnabled: Bool = false,
        recoveryHandler: PlanRecoveryHandler? = nil
    )
        -> AutoMobilePlanExecutor
    {
        AutoMobilePlanExecutor(
            configuration: .init(
                transport: .daemonUnixSocket(path: "/unused/acquisition.sock"),
                planPath: "unused",
                deviceId: deviceId,
                aiAssistance: recoveryEnabled
            ),
            planLoader: AcquisitionPlanLoader(platform: platform),
            mcpClient: client,
            timer: FakeTimer(),
            logger: AcquisitionLogger(),
            recoveryHandler: recoveryHandler ?? (recoveryEnabled ? AcquisitionRecoveryHandler() : nil),
            recoveryConfigProvider: StaticRecoveryConfigProvider(enabled: recoveryEnabled),
            recoveryModelConfig: nil,
            daemonEnsurer: HermeticDaemonEnsurer(),
            deadlineScheduler: scheduler,
            heldSessionController: heldSessionController
        )
    }
}

private final class AcquisitionTestCase: AutoMobileTestCase, @unchecked Sendable {
    override var planPath: String { "unused" }
    override var daemonSocketPath: String { "/unused/acquisition-test-case.sock" }

    @objc
    func planBody() {}
}

private struct AcquisitionPlanLoader: AutoMobilePlanLoading {
    let platform: String
    func loadPlan(at _: String, bundle _: Bundle?) throws -> String {
        "name: Acquisition\nplatform: \(platform)\nsteps:\n  - tool: observe"
    }
}

private struct AcquisitionLogger: AutoMobileLogger {
    func info(_: String) {}
    func warn(_: String) {}
    func error(_: String) {}
}

private struct AcquisitionRecoveryHandler: PlanRecoveryHandler {
    func attemptRecovery(_: FailedStepContext) async -> RecoveryOutcome {
        XCTFail("a transport/decode error or a result without a failed step must not reach recovery")
        return RecoveryOutcome(success: false)
    }
}

private struct AcquisitionSuccessfulRecoveryHandler: PlanRecoveryHandler {
    let heldSessions: RecordingHeldSessionController

    func attemptRecovery(_ context: FailedStepContext) async -> RecoveryOutcome {
        XCTAssertEqual(context.sessionUuid, "issued-session")
        XCTAssertEqual(heldSessions.liveHeartbeats, ["issued-session"])
        XCTAssertEqual(heldSessions.releasedSessions, [], "the session stays acquired throughout recovery")
        return RecoveryOutcome(success: true)
    }
}

/// Models cancellation-sensitive release I/O while keeping the shared recorder's exact release list.
private struct CancellationCheckingHeldSessionController: HeldSessionControlling {
    let recording: RecordingHeldSessionController

    func startHeartbeating(sessionId: String) -> any HeldSessionHeartbeat {
        recording.startHeartbeating(sessionId: sessionId)
    }

    func release(sessionId: String) async {
        guard !Task.isCancelled else { return }
        await recording.release(sessionId: sessionId)
    }
}

/// A sequential script, configured before execution and inspected after awaiting it (or a scheduler event).
private final class AcquisitionMCPClient: AutoMobileMCPClient, @unchecked Sendable {
    struct Call {
        let name: String
        let arguments: [String: Any]
    }

    var replies: [String: [MCPToolResponse]] = [:]
    var errors: [String: MCPClientError] = [:]
    var cancelOnCall: String?
    private(set) var events: [String] = []
    private(set) var calls: [Call] = []

    func initialize(timeout _: TimeInterval) async throws { events.append("initialize") }
    func callTool(name: String, arguments: [String: Any], timeout _: TimeInterval) async throws -> MCPToolResponse {
        events.append(name)
        calls.append(Call(name: name, arguments: arguments))
        if cancelOnCall == name {
            withUnsafeCurrentTask { $0?.cancel() }
        }
        if let error = errors[name] { throw error }
        if let next = replies[name]?.first {
            replies[name]?.removeFirst()
            return next
        }
        switch name {
        case "getApple", "getAndroid":
            return MCPToolResponse(text: #"{"runtime":{"session":{"sessionUuid":"issued-session"}}}"#)
        case "setToolEnabled":
            return MCPToolResponse(text: #"{"enabled":true}"#)
        case "executePlan":
            return MCPToolResponse(text: #"{"success":true,"executedSteps":1,"totalSteps":1}"#)
        default:
            throw MCPClientError.invalidResponse("Unexpected tool: \(name)")
        }
    }

    func readResource(uri _: String, timeout _: TimeInterval) async throws -> MCPResourceResponse {
        throw MCPClientError.invalidResponse("Unexpected resource read")
    }

    func resetSession() {}
}
