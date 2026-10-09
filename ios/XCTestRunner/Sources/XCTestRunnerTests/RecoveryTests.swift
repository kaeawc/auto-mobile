import Tachikoma
import XCTest
@testable import XCTestRunner
import XCTestRunnerTestSupport

// Unit tests for AI-assisted failure recovery. All tests are hermetic: the model is faked
// (`StubModelResponder`) so nothing here touches the network or needs an API key.

@MainActor
final class RecoveryExecutorTests: XCTestCase {
    private let fourStepPlan = """
    name: Recovery Plan
    steps:
      - tool: observe
      - tool: launchApp
      - tool: tapOn
      - tool: inputText
    """

    func testRecoverySucceedsAndResumesByReRunningTheFailedStep() async throws {
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 2, totalSteps: 4,
            failedStep: ["stepIndex": 2, "tool": "tapOn", "error": "no element", "device": "sim-1"]
        ))
        client.queueExecutePlan(planJSON(success: true, executedSteps: 4, totalSteps: 4))

        let handler = SpyRecoveryHandler(outcome: RecoveryOutcome(success: true))
        let executor = makeExecutor(client: client, handler: handler, recoveryEnabled: true)

        let result = try await executor.execute(testMetadata: nil)

        XCTAssertTrue(result.success)
        XCTAssertTrue(result.aiRecoveryAttempted)
        XCTAssertTrue(result.aiRecoverySuccessful)

        XCTAssertEqual(handler.receivedContexts.count, 1)
        let context = try XCTUnwrap(handler.receivedContexts.first)
        XCTAssertEqual(context.failedStepIndex, 2)
        XCTAssertEqual(context.failedTool, "tapOn")
        XCTAssertEqual(context.platform, "ios")
        XCTAssertEqual(context.deviceId, "sim-1")
        XCTAssertEqual(context.succeededSteps.map { $0.stepIndex }, [0, 1])
        XCTAssertEqual(context.succeededSteps.map { $0.tool }, ["observe", "launchApp"])

        let executePlanCalls = client.executePlanCalls
        XCTAssertEqual(executePlanCalls.count, 2)
        XCTAssertEqual(executePlanCalls[0].arguments["startStep"] as? Int, 0)
        // The failed step itself is re-run (parity with Android #4394); recovery only cleared its blocker.
        XCTAssertEqual(executePlanCalls[1].arguments["startStep"] as? Int, 2)
        XCTAssertEqual(executePlanCalls[1].arguments["deviceId"] as? String, "sim-1")
    }

    func testRecoveryFailureThrowsOriginalAndDoesNotResume() async throws {
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 3,
            failedStep: ["stepIndex": 1, "tool": "tapOn", "error": "boom"]
        ))

        let handler = SpyRecoveryHandler(outcome: RecoveryOutcome(success: false))
        let executor = makeExecutor(client: client, handler: handler, recoveryEnabled: true)

        await assertAsyncThrowsError({ try await executor.execute(testMetadata: nil) }, verify: { error in
            let description = String(describing: error)
            XCTAssertTrue(description.contains("boom"), "should retain the original failure message")
            XCTAssertTrue(description.contains("AI recovery attempted"), "should note the failed recovery")
        })
        XCTAssertEqual(handler.receivedContexts.count, 1)
        XCTAssertEqual(client.executePlanCalls.count, 1, "must not resume when recovery failed")
    }

    func testRecoverySkippedWhenFlagDisabled() async throws {
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 3,
            failedStep: ["stepIndex": 1, "tool": "tapOn", "error": "nope"]
        ))

        let handler = SpyRecoveryHandler(outcome: RecoveryOutcome(success: true))
        let executor = makeExecutor(client: client, handler: handler, recoveryEnabled: false)

        await assertAsyncThrowsError { try await executor.execute(testMetadata: nil) }
        XCTAssertTrue(handler.receivedContexts.isEmpty, "flag off must not call the handler")
        XCTAssertEqual(client.executePlanCalls.count, 1)
    }

    func testRecoverySkippedInCiMode() async throws {
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 3,
            failedStep: ["stepIndex": 1, "tool": "tapOn", "error": "nope"]
        ))

        let handler = SpyRecoveryHandler(outcome: RecoveryOutcome(success: true))
        let executor = makeExecutor(client: client, handler: handler, recoveryEnabled: true)

        let metadata = AutoMobilePlanExecutor.TestMetadata(testClass: "T", testMethod: "m", isCi: true)
        await assertAsyncThrowsError { try await executor.execute(testMetadata: metadata) }
        XCTAssertTrue(handler.receivedContexts.isEmpty, "CI mode must skip recovery")
    }

    func testRecoverySkippedWhenAiAssistanceDisabled() async throws {
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 3,
            failedStep: ["stepIndex": 1, "tool": "tapOn", "error": "nope"]
        ))

        let handler = SpyRecoveryHandler(outcome: RecoveryOutcome(success: true))
        let executor = makeExecutor(client: client, handler: handler, recoveryEnabled: true, aiAssistance: false)

        await assertAsyncThrowsError { try await executor.execute(testMetadata: nil) }
        XCTAssertTrue(handler.receivedContexts.isEmpty, "aiAssistance=false must skip recovery")
    }

    func testRecoveryAttemptedAtMostOncePerTest() async throws {
        let client = RecoveryMCPClient()
        // Initial failure, then the resumed run also fails: recovery must NOT fire a second time.
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 3,
            failedStep: ["stepIndex": 1, "tool": "tapOn", "error": "first"]
        ))
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 2, totalSteps: 3,
            failedStep: ["stepIndex": 2, "tool": "inputText", "error": "second"]
        ))

        let handler = SpyRecoveryHandler(outcome: RecoveryOutcome(success: true))
        let executor = makeExecutor(client: client, handler: handler, recoveryEnabled: true)

        await assertAsyncThrowsError { try await executor.execute(testMetadata: nil) }
        XCTAssertEqual(handler.receivedContexts.count, 1, "recovery is allowed at most once per test")
        XCTAssertEqual(client.executePlanCalls.count, 2, "initial attempt + one resume")
        XCTAssertEqual(client.executePlanCalls[1].arguments["startStep"] as? Int, 1)
    }

    // MARK: - Held session for recovery (#10834 / #11072)

    func testAttemptThatRecoveryMayFollowAsksTheDaemonToHoldItsSessionAndTheResumeTakesItOver() async throws {
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 2, totalSteps: 4,
            failedStep: ["stepIndex": 2, "tool": "tapOn", "error": "no element", "device": "sim-1"]
        ))
        client.queueExecutePlan(planJSON(success: true, executedSteps: 4, totalSteps: 4))
        let heldSessions = RecordingHeldSessionController()
        let handler = HeartbeatProbingRecoveryHandler(
            heldSessions: heldSessions,
            outcome: RecoveryOutcome(success: true)
        )
        let executor = makeExecutor(client: client, handler: handler, recoveryEnabled: true, heldSessions: heldSessions)

        let result = try await executor.execute(testMetadata: nil, sessionUuid: "held-session")

        XCTAssertTrue(result.success)
        let calls = client.executePlanCalls
        XCTAssertEqual(calls.count, 2)
        XCTAssertEqual(calls[0].arguments["holdSessionOnFailure"] as? Bool, true)
        XCTAssertNil(calls[1].arguments["holdSessionOnFailure"], "the resume may not be recovered again")
        XCTAssertEqual(calls[1].arguments["sessionUuid"] as? String, "held-session")
        XCTAssertEqual(handler.heartbeatsDuringRecovery, [["held-session"]], "heartbeated while recovery ran")
        XCTAssertEqual(
            heldSessions.events,
            [.heartbeatStarted("held-session"), .heartbeatStopped("held-session")],
            "the resumed plan takes the session over; the runner releases nothing"
        )
    }

    func testFailedRecoveryReleasesTheHeldSession() async throws {
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 3,
            failedStep: ["stepIndex": 1, "tool": "tapOn", "error": "boom"]
        ))
        let heldSessions = RecordingHeldSessionController()
        let handler = SpyRecoveryHandler(outcome: RecoveryOutcome(success: false))
        let executor = makeExecutor(client: client, handler: handler, recoveryEnabled: true, heldSessions: heldSessions)

        await assertAsyncThrowsError { try await executor.execute(testMetadata: nil, sessionUuid: "held-session") }

        XCTAssertEqual(heldSessions.releasedSessions, ["held-session"])
        XCTAssertEqual(heldSessions.liveHeartbeats, [], "the heartbeat stops with recovery")
    }

    func testSessionLostDuringRecoveryFailsFastWithoutResumingOrReleasing() async throws {
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 3,
            failedStep: ["stepIndex": 1, "tool": "tapOn", "error": "boom"]
        ))
        client.queueExecutePlan(planJSON(success: true, executedSteps: 3, totalSteps: 3))
        let heldSessions = RecordingHeldSessionController()
        heldSessions.lossReason = "the daemon released session held-session (idle)"
        let handler = SpyRecoveryHandler(outcome: RecoveryOutcome(success: true))
        let executor = makeExecutor(client: client, handler: handler, recoveryEnabled: true, heldSessions: heldSessions)

        do {
            _ = try await executor.execute(testMetadata: nil, sessionUuid: "held-session")
            XCTFail("a lost held session must not resume the plan")
        } catch {
            XCTAssertTrue("\(error)".contains("the daemon released session held-session (idle)"), "\(error)")
        }

        XCTAssertEqual(client.executePlanCalls.count, 1, "no resume on a session the daemon released")
        XCTAssertEqual(heldSessions.releasedSessions, [], "nothing left to release")
    }

    func testFailureRecoveryCannotHandleReleasesTheHeldSession() async throws {
        // A failure without a usable failed step never reaches recovery: the hold must not outlive it.
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(success: false, executedSteps: 0, totalSteps: 3))
        let heldSessions = RecordingHeldSessionController()
        let handler = SpyRecoveryHandler(outcome: RecoveryOutcome(success: true))
        let executor = makeExecutor(client: client, handler: handler, recoveryEnabled: true, heldSessions: heldSessions)

        await assertAsyncThrowsError { try await executor.execute(testMetadata: nil, sessionUuid: "held-session") }

        XCTAssertEqual(client.executePlanCalls[0].arguments["holdSessionOnFailure"] as? Bool, true)
        XCTAssertTrue(handler.receivedContexts.isEmpty)
        XCTAssertEqual(heldSessions.releasedSessions, ["held-session"])
    }

    func testNoHoldIsRequestedWhenRecoveryCannotFollow() async throws {
        for (enabled, aiAssistance, isCi) in [(false, true, false), (true, false, false), (true, true, true)] {
            let client = RecoveryMCPClient()
            client.queueExecutePlan(planJSON(
                success: false, executedSteps: 1, totalSteps: 3,
                failedStep: ["stepIndex": 1, "tool": "tapOn", "error": "nope"]
            ))
            let heldSessions = RecordingHeldSessionController()
            let executor = makeExecutor(
                client: client,
                handler: SpyRecoveryHandler(outcome: RecoveryOutcome(success: true)),
                recoveryEnabled: enabled,
                aiAssistance: aiAssistance,
                heldSessions: heldSessions
            )
            let metadata = AutoMobilePlanExecutor.TestMetadata(testClass: "T", testMethod: "m", isCi: isCi)

            await assertAsyncThrowsError { try await executor.execute(testMetadata: metadata) }

            XCTAssertNil(client.executePlanCalls[0].arguments["holdSessionOnFailure"])
            XCTAssertEqual(heldSessions.events, [], "nothing held, nothing to heartbeat or release")
        }
    }

    func testDaemonReportingTheSessionWasNotHeldSkipsRecoveryAndReleasesNothing() async throws {
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 3,
            failedStep: ["stepIndex": 1, "tool": "tapOn", "error": "boom"],
            sessionHeld: false
        ))
        let heldSessions = RecordingHeldSessionController()
        let handler = SpyRecoveryHandler(outcome: RecoveryOutcome(success: true))
        let executor = makeExecutor(client: client, handler: handler, recoveryEnabled: true, heldSessions: heldSessions)

        do {
            _ = try await executor.execute(testMetadata: nil, sessionUuid: "released-session")
            XCTFail("expected the failed plan to throw")
        } catch {
            XCTAssertTrue(String(describing: error).contains("sessionHeld: false"), "\(error)")
        }

        XCTAssertEqual(client.executePlanCalls.count, 1, "no resume on a released session")
        XCTAssertTrue(handler.receivedContexts.isEmpty, "recovery never ran on a released device")
        XCTAssertEqual(heldSessions.events, [], "the daemon already released it; nothing to heartbeat or release")
    }

    func testDaemonReportingTheSessionWasHeldGoesOnToRecovery() async throws {
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 2, totalSteps: 4,
            failedStep: ["stepIndex": 2, "tool": "tapOn", "error": "no element", "device": "sim-1"],
            sessionHeld: true
        ))
        client.queueExecutePlan(planJSON(success: true, executedSteps: 4, totalSteps: 4))
        let handler = SpyRecoveryHandler(outcome: RecoveryOutcome(success: true))
        let executor = makeExecutor(client: client, handler: handler, recoveryEnabled: true)

        let result = try await executor.execute(testMetadata: nil, sessionUuid: "held-session")

        XCTAssertTrue(result.success)
        XCTAssertTrue(result.aiRecoveryAttempted)
        XCTAssertEqual(handler.receivedContexts.count, 1)
    }

    func testTransientRetryRunsUnderAFreshSessionAfterReleasingTheHeldOne() async throws {
        let client = RecoveryMCPClient()
        // A failure with no failed step is not recoverable; the retry loop runs it again.
        client.queueExecutePlan(planJSON(success: false, executedSteps: 0, totalSteps: 3))
        client.queueExecutePlan(planJSON(success: true, executedSteps: 3, totalSteps: 3))
        let heldSessions = RecordingHeldSessionController()
        let executor = makeExecutor(
            client: client,
            handler: SpyRecoveryHandler(outcome: RecoveryOutcome(success: true)),
            recoveryEnabled: true,
            heldSessions: heldSessions,
            retryCount: 1
        )

        let result = try await executor.execute(testMetadata: nil, sessionUuid: "first-session")

        XCTAssertTrue(result.success)
        let sessions = client.executePlanCalls.map { $0.arguments["sessionUuid"] as? String }
        XCTAssertEqual(sessions.count, 2)
        XCTAssertEqual(sessions[0], "first-session")
        XCTAssertNotEqual(sessions[1], "first-session", "a released UUID is terminal on the daemon")
        XCTAssertEqual(heldSessions.releasedSessions, ["first-session"])
    }

    // MARK: - Helpers

    private func makeExecutor(
        client: RecoveryMCPClient,
        handler: PlanRecoveryHandler,
        recoveryEnabled: Bool,
        aiAssistance: Bool = true,
        heldSessions: RecordingHeldSessionController = RecordingHeldSessionController(),
        retryCount: Int = 0
    )
        -> AutoMobilePlanExecutor
    {
        let config = AutoMobilePlanExecutor.Configuration(
            transport: .daemonUnixSocket(path: "/tmp/xctestrunner-recovery-test.sock"),
            planPath: "recovery-plan.yaml",
            retryCount: retryCount,
            timeoutSeconds: 5,
            retryDelaySeconds: 0,
            startStep: 0,
            aiAssistance: aiAssistance
        )
        return AutoMobilePlanExecutor(
            configuration: config,
            planLoader: StubPlanLoader(content: fourStepPlan),
            mcpClient: client,
            timer: FakeTimer(),
            logger: SilentLogger(),
            recoveryHandler: handler,
            recoveryConfigProvider: StaticRecoveryConfigProvider(enabled: recoveryEnabled, maxToolCalls: 5),
            recoveryModelConfig: nil,
            daemonEnsurer: HermeticDaemonEnsurer(),
            deadlineScheduler: VirtualDeadlineScheduler(),
            heldSessionController: heldSessions
        )
    }
}

@MainActor
final class RecoveryConfigAndModelTests: XCTestCase {
    func testDaemonRecoveryConfigReadsFlagFromResource() async {
        let client = RecoveryMCPClient()
        client.flagResourceText = jsonString(["enabled": false, "config": ["maxToolCalls": 9]])
        let provider = DaemonRecoveryConfigProvider(clientProvider: { client }, logger: SilentLogger())
        let enabled = await provider.isRecoveryEnabled()
        let maxCalls = await provider.maxRecoveryToolCalls()
        XCTAssertFalse(enabled)
        XCTAssertEqual(maxCalls, 9)
    }

    func testDaemonRecoveryConfigParseDefaultsOnGarbage() {
        let parsed = DaemonRecoveryConfigProvider.parse("this is not json")
        XCTAssertTrue(parsed.enabled)
        XCTAssertEqual(parsed.maxToolCalls, 5)
    }

    func testModelConfigDefaultsToAnthropicWhenKeyPresent() {
        let config = RecoveryModelConfig.resolve(environment: ["ANTHROPIC_API_KEY": "sk-test"])
        XCTAssertEqual(config?.provider, .anthropic)
        XCTAssertEqual(config?.modelName, "claude-sonnet-4-20250514")
    }

    func testModelConfigReturnsNilWithoutKey() {
        XCTAssertNil(RecoveryModelConfig.resolve(environment: [:]))
    }

    func testModelConfigHonorsProviderAndModelOverride() {
        let config = RecoveryModelConfig.resolve(environment: [
            "AUTOMOBILE_AI_PROVIDER": "openai",
            "OPENAI_API_KEY": "k",
            "AUTOMOBILE_AI_MODEL": "gpt-4o",
        ])
        XCTAssertEqual(config?.provider, .openai)
        XCTAssertEqual(config?.modelName, "gpt-4o")
    }

    func testModelConfigNilWhenSelectedProviderKeyMissing() {
        // Provider is openai but only an Anthropic key is present — recovery is unavailable.
        XCTAssertNil(RecoveryModelConfig.resolve(environment: [
            "AUTOMOBILE_AI_PROVIDER": "openai",
            "ANTHROPIC_API_KEY": "k",
        ]))
    }

    func testPlanStepToolParserExtractsInlineToolNames() {
        let yaml = """
        name: P
        steps:
          - tool: observe
          - tool: tapOn
            selector:
              text: Foo
          - tool: inputText
        """
        XCTAssertEqual(PlanStepToolParser.toolNames(from: yaml), ["observe", "tapOn", "inputText"])
    }

    func testPlanStepToolParserFindsToolOnLaterLine() {
        let yaml = """
        steps:
          - selector:
              text: X
            tool: tapOn
        """
        XCTAssertEqual(PlanStepToolParser.toolNames(from: yaml), ["tapOn"])
    }

    /// A nested block sequence inside a step (e.g. `textAny:` / `matchers:`) must not be counted as
    /// its own step. Pre-fix, each nested `-` item appended a spurious "step" name and misaligned the
    /// returned array against the plan's real steps.
    func testPlanStepToolParserIgnoresNestedSequences() {
        let yaml = """
        steps:
          - tool: observe
            waitFor:
              textAny:
                - "Not Now"
                - "Close"
          - tool: tapOn
        """
        XCTAssertEqual(PlanStepToolParser.toolNames(from: yaml), ["observe", "tapOn"])
    }
}

@MainActor
final class TachikomaPlanRecoveryHandlerTests: XCTestCase {
    private func makeContext() -> FailedStepContext {
        FailedStepContext(
            failedStepIndex: 2,
            failedTool: "tapOn",
            error: "element not found",
            succeededSteps: [SucceededStepSummary(stepIndex: 0, tool: "observe")],
            planContent: "name: P\nsteps:\n  - tool: observe",
            platform: "ios",
            sessionUuid: "sess-1",
            deviceId: "dev-1",
            failureObservation: nil
        )
    }

    /// The executor re-runs the failed step after recovery (#11139, parity with Android #4394), so the
    /// prompt must ask only to clear its blocker and must not point the agent at the step after it.
    func testRecoveryPromptSaysTheFailedStepIsReRun() {
        let prompt = TachikomaPlanRecoveryHandler.buildRecoveryPrompt(context: makeContext(), maxToolCalls: 5)

        XCTAssertTrue(prompt.contains("re-running the failed step 3"), prompt)
        XCTAssertFalse(prompt.contains("resume from step 4"), prompt)
        XCTAssertFalse(prompt.contains("NEXT"), prompt)
        let system = TachikomaPlanRecoveryHandler.systemInstructions
        XCTAssertTrue(system.contains("re-runs the failed step itself"), system)
        XCTAssertFalse(system.contains("next step"), system)
    }

    func testHandlerRunsToolLoopThenVerifiesWithObserve() async {
        let client = RecoveryMCPClient()
        let responder = StubModelResponder([
            StubModelResponder.toolCall(name: "observe"),
            StubModelResponder.toolCall(name: "tapOn", arguments: "{\"selector\":{\"text\":\"OK\"}}"),
            StubModelResponder.final(),
        ])
        let handler = makeHandler(client: client, responder: responder, maxToolCalls: 5)

        let outcome = await handler.attemptRecovery(makeContext())

        XCTAssertTrue(outcome.success, "a non-nil post-recovery observe means success")
        XCTAssertEqual(client.calls.map { $0.name }, ["observe", "tapOn", "observe"])

        let tapCall = client.calls.first { $0.name == "tapOn" }
        XCTAssertEqual(tapCall?.arguments["platform"] as? String, "ios")
        XCTAssertEqual(tapCall?.arguments["sessionUuid"] as? String, "sess-1")
        XCTAssertEqual(tapCall?.arguments["device"] as? String, "dev-1")
        XCTAssertEqual(tapCall?.arguments["action"] as? String, "tap", "tapOn action is injected when omitted")
        XCTAssertNotNil(tapCall?.arguments["selector"], "model-provided selector is preserved")
    }

    func testHandlerNoOpsWithoutModelConfig() async {
        let client = RecoveryMCPClient()
        let handler = TachikomaPlanRecoveryHandler(
            mcpClient: client,
            configProvider: StaticRecoveryConfigProvider(enabled: true, maxToolCalls: 5),
            modelConfig: nil,
            timer: FakeTimer(),
            logger: SilentLogger(),
            responderFactory: { _ in StubModelResponder([]) },
            deadlineScheduler: VirtualDeadlineScheduler()
        )

        let outcome = await handler.attemptRecovery(makeContext())

        XCTAssertFalse(outcome.success)
        XCTAssertTrue(client.calls.isEmpty, "no model config means no device interaction")
    }

    func testHandlerRespectsMaxToolCallBudget() async {
        let client = RecoveryMCPClient()
        // The model keeps asking to tap forever; the budget of 2 must cap real device tool calls.
        let responder = StubModelResponder(alwaysReturn: StubModelResponder.toolCall(name: "tapOn"))
        let handler = makeHandler(client: client, responder: responder, maxToolCalls: 2)

        _ = await handler.attemptRecovery(makeContext())

        XCTAssertEqual(client.calls.filter { $0.name == "tapOn" }.count, 2, "budget caps tool calls")
        XCTAssertEqual(client.calls.filter { $0.name == "observe" }.count, 1, "one final verification observe")
    }

    private func makeHandler(
        client: RecoveryMCPClient,
        responder: ModelResponding,
        maxToolCalls: Int
    )
        -> TachikomaPlanRecoveryHandler
    {
        TachikomaPlanRecoveryHandler(
            mcpClient: client,
            configProvider: StaticRecoveryConfigProvider(enabled: true, maxToolCalls: maxToolCalls),
            modelConfig: RecoveryModelConfig(provider: .anthropic, modelName: "claude-sonnet-4-20250514"),
            timer: FakeTimer(),
            logger: SilentLogger(),
            responderFactory: { _ in responder },
            deadlineScheduler: VirtualDeadlineScheduler()
        )
    }
}

/// Issue #6029 (CWE-200): a secret plan parameter must never reach the third-party LLM provider
/// during AI-assisted recovery. These tests drive the FULL executor → recovery handler → model call
/// path with a real `TachikomaPlanRecoveryHandler` and a capturing `ModelResponding` so the assertion
/// is against the actual `ModelRequest` that would go over the wire, not a helper's rendering of it.
@MainActor
final class PlanRecoverySecretRedactionTests: XCTestCase {
    private let secret = "SECRET-hunter2-TOKEN"
    private let visible = "keepme-visible-env"

    private let plan = """
    name: Redaction Plan
    secretParameters:
      - TOKEN
    steps:
      - tool: observe
      - tool: inputText
        text: "${TOKEN}"
      - tool: tapOn
        text: "${ENVIRONMENT}"
    """

    func testSecretIsRedactedFromModelRequestWhileNonSecretIsPreserved() async throws {
        let client = RecoveryMCPClient()
        // Fail on the inputText step; the secret also surfaces in the error string and on-screen sample.
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 3,
            failedStep: [
                "stepIndex": 1,
                "tool": "inputText",
                "error": "timed out entering \(secret) into field",
                "failureObservation": [
                    "visibleTextsSample": ["Welcome \(visible)", "token: \(secret)"],
                    "resourceIdsSample": ["field/\(secret)"],
                ],
            ]
        ))

        let captor = CapturingModelResponder()
        let handler = TachikomaPlanRecoveryHandler(
            mcpClient: client,
            configProvider: StaticRecoveryConfigProvider(enabled: true, maxToolCalls: 5),
            modelConfig: RecoveryModelConfig(provider: .anthropic, modelName: "claude-sonnet-4-20250514"),
            timer: FakeTimer(),
            logger: SilentLogger(),
            responderFactory: { _ in captor },
            deadlineScheduler: VirtualDeadlineScheduler()
        )
        let executor = makeExecutor(client: client, handler: handler)

        _ = try await executor.execute(testMetadata: nil)

        let request = try XCTUnwrap(captor.captured.first, "recovery must issue a model request")
        let text = requestText(request)

        XCTAssertFalse(text.contains(secret), "secret value must not appear anywhere in the model request")
        XCTAssertTrue(text.contains(SecretRedaction.placeholder), "the secret must be replaced by the placeholder")
        XCTAssertTrue(text.contains(visible), "non-secret on-screen context must be preserved")
        XCTAssertTrue(text.contains("ENVIRONMENT") || text.contains(visible), "non-secret plan context is preserved")

        // The base64 executePlan payload sent to the LOCAL daemon must keep the REAL secret so the
        // plan can actually run — the daemon is not the egress boundary.
        let daemonPlan = try XCTUnwrap(decodedDaemonPlanContent(client.executePlanCalls.first))
        XCTAssertTrue(daemonPlan.contains(secret), "daemon executePlan payload must stay unredacted")
    }

    func testSecretDeclaredOnlyViaConfigurationIsRedacted() async throws {
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 3,
            failedStep: ["stepIndex": 1, "tool": "inputText", "error": "boom \(secret)"]
        ))

        let captor = CapturingModelResponder()
        let handler = TachikomaPlanRecoveryHandler(
            mcpClient: client,
            configProvider: StaticRecoveryConfigProvider(enabled: true, maxToolCalls: 5),
            modelConfig: RecoveryModelConfig(provider: .anthropic, modelName: "claude-sonnet-4-20250514"),
            timer: FakeTimer(),
            logger: SilentLogger(),
            responderFactory: { _ in captor },
            deadlineScheduler: VirtualDeadlineScheduler()
        )
        // Declare the secret ONLY through Configuration.secretParameterKeys — the plan here does NOT
        // list `secretParameters`, isolating the Configuration path.
        let planWithoutSecretDecl = """
        name: Redaction Plan
        steps:
          - tool: observe
          - tool: inputText
            text: "${TOKEN}"
        """
        let executor = makeExecutor(
            client: client,
            handler: handler,
            planText: planWithoutSecretDecl,
            configSecretKeys: ["TOKEN"]
        )

        _ = try await executor.execute(testMetadata: nil)

        let request = try XCTUnwrap(captor.captured.first)
        XCTAssertFalse(requestText(request).contains(secret), "config-declared secret must also be redacted")
    }

    func testSecretRedactedWhenSecretParametersIsFlushZeroIndentBlockSequence() async throws {
        // Flush (zero-indent) block sequence — valid YAML that the iOS line parser previously dropped,
        // silently disabling redaction on iOS while Android (snakeyaml) still redacted (#6029).
        let flushPlan = """
        name: Redaction Plan
        secretParameters:
        - TOKEN
        steps:
          - tool: observe
          - tool: inputText
            text: "${TOKEN}"
        """
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 2,
            failedStep: ["stepIndex": 1, "tool": "inputText", "error": "boom \(secret)"]
        ))

        let captor = CapturingModelResponder()
        let handler = TachikomaPlanRecoveryHandler(
            mcpClient: client,
            configProvider: StaticRecoveryConfigProvider(enabled: true, maxToolCalls: 5),
            modelConfig: RecoveryModelConfig(provider: .anthropic, modelName: "claude-sonnet-4-20250514"),
            timer: FakeTimer(),
            logger: SilentLogger(),
            responderFactory: { _ in captor },
            deadlineScheduler: VirtualDeadlineScheduler()
        )
        let executor = makeExecutor(client: client, handler: handler, planText: flushPlan)

        _ = try await executor.execute(testMetadata: nil)

        let request = try XCTUnwrap(captor.captured.first)
        XCTAssertFalse(
            requestText(request).contains(secret),
            "a flush-form secretParameters declaration must still redact on iOS"
        )
    }

    func testSecretRedactedWhenSecretParametersIsMultilineFlowSequence() async throws {
        // Multiline bracketed flow sequence — valid YAML the iOS line scanner previously dropped,
        // silently disabling redaction and letting the secret reach the LLM recovery context (#6097).
        let multilinePlan = """
        name: Redaction Plan
        secretParameters: [
          TOKEN
        ]
        steps:
          - tool: observe
          - tool: inputText
            text: "${TOKEN}"
        """
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 2,
            failedStep: ["stepIndex": 1, "tool": "inputText", "error": "boom \(secret)"]
        ))

        let captor = CapturingModelResponder()
        let handler = TachikomaPlanRecoveryHandler(
            mcpClient: client,
            configProvider: StaticRecoveryConfigProvider(enabled: true, maxToolCalls: 5),
            modelConfig: RecoveryModelConfig(provider: .anthropic, modelName: "claude-sonnet-4-20250514"),
            timer: FakeTimer(),
            logger: SilentLogger(),
            responderFactory: { _ in captor },
            deadlineScheduler: VirtualDeadlineScheduler()
        )
        let executor = makeExecutor(client: client, handler: handler, planText: multilinePlan)

        _ = try await executor.execute(testMetadata: nil)

        let request = try XCTUnwrap(captor.captured.first)
        XCTAssertFalse(
            requestText(request).contains(secret),
            "a multiline-flow secretParameters declaration must still redact on iOS"
        )
    }

    func testSecretsRedactedWhenMultilineFlowKeyContainsQuotedHash() async throws {
        // Two keys, the first quoting a `#`. A comment strip that runs before quote state truncates
        // the first item, drops the second, and leaks the second secret to the recovery LLM (#6097 P1).
        let secretA = "SECRETA-hash-9f1"
        let secretB = "SECRETB-plain-2a7"
        let plan = """
        name: Redaction Plan
        secretParameters: [
          "API#TOKEN",
          PASSWORD
        ]
        steps:
          - tool: observe
          - tool: inputText
            text: "field"
        """
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 2,
            failedStep: ["stepIndex": 1, "tool": "inputText", "error": "boom \(secretA) and \(secretB)"]
        ))
        let captor = CapturingModelResponder()
        let executor = makeExecutor(
            client: client,
            handler: makeCapturingHandler(client: client, captor: captor),
            planText: plan,
            parameters: ["API#TOKEN": secretA, "PASSWORD": secretB]
        )

        _ = try await executor.execute(testMetadata: nil)

        let request = try XCTUnwrap(captor.captured.first)
        let text = requestText(request)
        XCTAssertFalse(text.contains(secretA), "the quoted-# key's value must be redacted")
        XCTAssertFalse(text.contains(secretB), "the following key must not be dropped, so its value redacts")
    }

    func testSecretsRedactedWhenMultilineFlowKeyContainsEscapedQuoteBeforeBracket() async throws {
        // The first key is a double-quoted scalar with an escaped quote before a `]`. Without escape
        // tracking the sequence terminator is found early, PASSWORD is dropped, and its secret leaks.
        let secretA = "SECRETA-esc-4c2"
        let secretB = "SECRETB-plain-8e5"
        let plan = """
        name: Redaction Plan
        secretParameters: [
          "a\\"]b",
          PASSWORD
        ]
        steps:
          - tool: observe
          - tool: inputText
            text: "field"
        """
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 2,
            failedStep: ["stepIndex": 1, "tool": "inputText", "error": "boom \(secretA) and \(secretB)"]
        ))
        let captor = CapturingModelResponder()
        let executor = makeExecutor(
            client: client,
            handler: makeCapturingHandler(client: client, captor: captor),
            planText: plan,
            parameters: ["a\"]b": secretA, "PASSWORD": secretB]
        )

        _ = try await executor.execute(testMetadata: nil)

        let request = try XCTUnwrap(captor.captured.first)
        let text = requestText(request)
        XCTAssertFalse(text.contains(secretA), "the escaped-quote key's value must be redacted")
        XCTAssertFalse(text.contains(secretB), "the following key must not be dropped, so its value redacts")
    }

    func testSecretValueRedactedWhenKeyUsesHexEscapeViaFailSafe() async throws {
        // The key `"API\x54OKEN"` is now spec-decoded to `APITOKEN` (issue #6141), so it matches the
        // parameter `APITOKEN` by name and its value is redacted directly. Even if decoding had
        // failed, the value-layer fail-safe would over-redact, so the secret still cannot leak
        // (#6097 — the important security assertion, which holds either way).
        let secret = "SECRET-hex-7b3"
        let plan =
            "name: P\nsecretParameters: [\"API\\x54OKEN\"]\nsteps:\n  - tool: observe\n  - tool: inputText\n    text: \"field\""
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 2,
            failedStep: ["stepIndex": 1, "tool": "inputText", "error": "boom \(secret)"]
        ))
        let captor = CapturingModelResponder()
        let executor = makeExecutor(
            client: client,
            handler: makeCapturingHandler(client: client, captor: captor),
            planText: plan,
            parameters: ["APITOKEN": secret]
        )

        _ = try await executor.execute(testMetadata: nil)

        let request = try XCTUnwrap(captor.captured.first)
        XCTAssertFalse(
            requestText(request).contains(secret),
            "a hex-escaped secret key's value must still be redacted via the fail-safe"
        )
    }

    func testSecretValueRedactedDespiteDecoyParameterMatchingUnDecodedHexKey() async throws {
        // Parameters contain BOTH the real `APITOKEN` (what the scanner now decodes `"API\x54OKEN"`
        // to — issue #6141) and a decoy `APIx54OKEN` matching the OLD un-decoded spelling. Decoding
        // resolves the key to `APITOKEN`, so the real secret is redacted by exact match and the decoy
        // is never trusted; the secret cannot leak (#6097 — decoy).
        let real = "REAL-hex-secret-1a2"
        let plan =
            "name: P\nsecretParameters: [\"API\\x54OKEN\"]\nsteps:\n  - tool: observe\n  - tool: inputText\n    text: \"field\""
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 2,
            failedStep: ["stepIndex": 1, "tool": "inputText", "error": "boom \(real)"]
        ))
        let captor = CapturingModelResponder()
        let executor = makeExecutor(
            client: client,
            handler: makeCapturingHandler(client: client, captor: captor),
            planText: plan,
            parameters: ["APITOKEN": real, "APIx54OKEN": "DECOY-not-the-secret"]
        )

        _ = try await executor.execute(testMetadata: nil)

        let request = try XCTUnwrap(captor.captured.first)
        XCTAssertFalse(
            requestText(request).contains(real),
            "the real secret must be redacted despite the decoy exact-match"
        )
    }

    func testSecretSubstitutedIntoToolNameIsRedacted() async throws {
        let client = RecoveryMCPClient()
        // The daemon reports the failed step's tool as the substituted secret value.
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 3,
            failedStep: ["stepIndex": 1, "tool": secret, "error": "step failed"]
        ))

        let captor = CapturingModelResponder()
        let handler = TachikomaPlanRecoveryHandler(
            mcpClient: client,
            configProvider: StaticRecoveryConfigProvider(enabled: true, maxToolCalls: 5),
            modelConfig: RecoveryModelConfig(provider: .anthropic, modelName: "claude-sonnet-4-20250514"),
            timer: FakeTimer(),
            logger: SilentLogger(),
            responderFactory: { _ in captor },
            deadlineScheduler: VirtualDeadlineScheduler()
        )
        let executor = makeExecutor(client: client, handler: handler)

        _ = try await executor.execute(testMetadata: nil)

        let request = try XCTUnwrap(captor.captured.first)
        XCTAssertFalse(
            requestText(request).contains(secret),
            "a secret substituted into a tool name must be redacted from the recovery prompt"
        )
    }

    /// #6029 review (695): the scrubbed value must equal what the executor's single ordered pass
    /// actually produced. With sorted-key substitution, `${TOKEN}` -> `sec-${AA}-zeta` (AA resolved
    /// before TOKEN inserts it, ZZ after) — neither the raw value nor a fully-resolved fixpoint. Using
    /// the executor's own substitution as the source of truth scrubs exactly that.
    func testScrubsExactlyWhatTheExecutorSubstitutionProduced() async throws {
        let plan = """
        name: P
        secretParameters:
          - TOKEN
        steps:
          - tool: observe
          - tool: inputText
            text: "${TOKEN}"
        """
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 2,
            failedStep: ["stepIndex": 1, "tool": "inputText", "error": "boom"]
        ))
        let captor = CapturingModelResponder()
        let executor = makeExecutor(
            client: client,
            handler: makeCapturingHandler(client: client, captor: captor),
            planText: plan,
            parameters: ["TOKEN": "sec-${AA}-${ZZ}", "AA": "alpha", "ZZ": "zeta"]
        )

        _ = try await executor.execute(testMetadata: nil)

        let request = try XCTUnwrap(captor.captured.first)
        let text = requestText(request)
        XCTAssertFalse(text.contains("sec-"), "the actual substituted secret must be scrubbed")
        // Positive assertions so the test can't pass on an empty/malformed request.
        XCTAssertTrue(text.contains(SecretRedaction.placeholder), "the secret must be replaced by the placeholder")
        XCTAssertTrue(text.contains("observe"), "non-secret plan structure must be preserved")
    }

    /// #6029 review (701): a self-referential secret must not blow up (no fixpoint expansion) and must
    /// still be redacted. The executor's single pass turns `${TOKEN}` into `marker-${TOKEN}` once.
    func testSelfReferentialSecretTerminatesAndIsRedacted() async throws {
        let plan = """
        name: P
        secretParameters:
          - TOKEN
        steps:
          - tool: observe
          - tool: inputText
            text: "${TOKEN}"
        """
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 2,
            failedStep: ["stepIndex": 1, "tool": "inputText", "error": "boom"]
        ))
        let captor = CapturingModelResponder()
        let executor = makeExecutor(
            client: client,
            handler: makeCapturingHandler(client: client, captor: captor),
            planText: plan,
            parameters: ["TOKEN": "marker-${TOKEN}"]
        )

        _ = try await executor.execute(testMetadata: nil)

        let request = try XCTUnwrap(captor.captured.first)
        let text = requestText(request)
        XCTAssertFalse(text.contains("marker-"), "the self-referential secret must be redacted")
        XCTAssertTrue(text.contains(SecretRedaction.placeholder), "the secret must be replaced by the placeholder")
        XCTAssertTrue(text.contains("observe"), "non-secret plan structure must be preserved")
    }

    /// #6029 review: a plan may parameterize the declared key name (`secretParameters: [${SECRET_KEY}]`)
    /// — parsed from the raw plan, then the key name resolved against parameters.
    func testParameterizedSecretKeyNameIsRedacted() async throws {
        let plan = """
        name: P
        secretParameters:
          - ${SECRET_KEY}
        steps:
          - tool: observe
          - tool: inputText
            text: "${apiToken}"
        """
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 2,
            failedStep: ["stepIndex": 1, "tool": "inputText", "error": "boom"]
        ))
        let captor = CapturingModelResponder()
        let executor = makeExecutor(
            client: client,
            handler: makeCapturingHandler(client: client, captor: captor),
            planText: plan,
            parameters: ["SECRET_KEY": "apiToken", "apiToken": secret]
        )

        _ = try await executor.execute(testMetadata: nil)

        let request = try XCTUnwrap(captor.captured.first)
        let text = requestText(request)
        XCTAssertFalse(text.contains(secret), "a parameterized secret key name must resolve and redact")
        XCTAssertTrue(text.contains(SecretRedaction.placeholder), "the secret must be replaced by the placeholder")
        XCTAssertTrue(text.contains("observe"), "non-secret plan structure must be preserved")
    }

    /// Issue #6094 (CWE-200, second-order channel): after the initial (redacted) recovery prompt,
    /// the agent loop calls `observe`/tools and re-sends those RESULTS in the next `ModelRequest`. A
    /// secret still visible on-screen at recovery time (echoed into a field, in the view hierarchy)
    /// therefore reaches the LLM provider through the loop's own tool results unless they are
    /// scrubbed. This drives the FULL loop with a responder that records EVERY request and asserts
    /// the secret is absent from ALL of them — including the post-initial tool-result turns — while
    /// non-secret context survives. The secret is placed ONLY in the tool results here (the failure
    /// error/observation are clean), isolating this loop channel from #6092's initial-prompt fix.
    func testSecretInToolResultIsRedactedFromEveryModelRequestInTheLoop() async throws {
        let client = RecoveryMCPClient()
        // The live observe/tool results carry the on-screen secret plus non-secret context.
        client.observeText = "{\"elements\":{\"field\":\"token \(secret)\"},\"env\":\"\(visible)\"}"
        client.toolResponseText = "{\"status\":\"typed \(secret)\"}"
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 3,
            failedStep: ["stepIndex": 1, "tool": "inputText", "error": "step failed"]
        ))
        client.queueExecutePlan(planJSON(success: true, executedSteps: 3, totalSteps: 3))

        // observe -> tapOn -> finish: the 2nd and 3rd requests carry the prior tool results.
        let captor = ScriptedCapturingModelResponder([
            StubModelResponder.toolCall(name: "observe"),
            StubModelResponder.toolCall(name: "tapOn", arguments: "{\"selector\":{\"text\":\"OK\"}}"),
            StubModelResponder.final(),
        ])
        let handler = TachikomaPlanRecoveryHandler(
            mcpClient: client,
            configProvider: StaticRecoveryConfigProvider(enabled: true, maxToolCalls: 5),
            modelConfig: RecoveryModelConfig(provider: .anthropic, modelName: "claude-sonnet-4-20250514"),
            timer: FakeTimer(),
            logger: SilentLogger(),
            responderFactory: { _ in captor },
            deadlineScheduler: VirtualDeadlineScheduler()
        )
        let executor = makeExecutor(client: client, handler: handler)

        _ = try await executor.execute(testMetadata: nil)

        XCTAssertGreaterThanOrEqual(
            captor.captured.count, 2,
            "the loop must issue follow-up requests carrying tool results"
        )
        for (offset, request) in captor.captured.enumerated() {
            XCTAssertFalse(
                requestText(request).contains(secret),
                "secret leaked into ModelRequest #\(offset) via a re-sent tool/observe result"
            )
        }
        let allText = captor.captured.map { requestText($0) }.joined(separator: "\n")
        XCTAssertTrue(
            allText.contains(SecretRedaction.placeholder),
            "the tool-result secret must be replaced by the placeholder"
        )
        XCTAssertTrue(allText.contains(visible), "non-secret tool-result context must be preserved")

        // The tool still EXECUTED on-device with real routing args (only the RESULT text that enters
        // the transcript is scrubbed), and the daemon executePlan payload keeps the real secret.
        XCTAssertTrue(client.calls.contains { $0.name == "observe" }, "the loop must have executed observe on-device")
        let daemonPlan = try XCTUnwrap(decodedDaemonPlanContent(client.executePlanCalls.first))
        XCTAssertTrue(daemonPlan.contains(secret), "daemon executePlan payload must stay unredacted")
    }

    /// Issue #6094 public-boundary hardening: a DIRECT caller of the handler may build a
    /// `FailedStepContext` with RAW (unredacted) fields and RAW concrete `secretValues`. The handler
    /// must normalize the values and scrub the static context fields itself, so the very first
    /// ModelRequest (the prompt) does not leak — not only the executor path (which pre-redacts).
    func testDirectCallerRawContextIsRedactedFromTheInitialPrompt() async throws {
        let client = RecoveryMCPClient()
        let captor = ScriptedCapturingModelResponder([])
        let handler = TachikomaPlanRecoveryHandler(
            mcpClient: client,
            configProvider: StaticRecoveryConfigProvider(enabled: true, maxToolCalls: 5),
            modelConfig: RecoveryModelConfig(provider: .anthropic, modelName: "claude-sonnet-4-20250514"),
            timer: FakeTimer(),
            logger: SilentLogger(),
            responderFactory: { _ in captor },
            deadlineScheduler: VirtualDeadlineScheduler()
        )
        let context = FailedStepContext(
            failedStepIndex: 1,
            failedTool: "inputText",
            error: "timed out entering \(secret) into field",
            succeededSteps: [SucceededStepSummary(stepIndex: 0, tool: "observe")],
            planContent: "name: P\nsteps:\n  - tool: inputText\n    text: \"\(secret)\"",
            platform: "ios",
            sessionUuid: "sess-1",
            deviceId: "dev-1",
            failureObservation: nil,
            secretValues: [secret] // RAW concrete value, not pre-expanded
        )

        _ = await handler.attemptRecovery(context)

        let request = try XCTUnwrap(captor.captured.first, "the handler must issue the initial prompt request")
        let text = requestText(request)
        XCTAssertFalse(text.contains(secret), "a direct caller's raw context must not leak into the initial prompt")
        XCTAssertTrue(text.contains(SecretRedaction.placeholder), "the secret must be replaced by the placeholder")
    }

    // MARK: - Helpers

    private func makeCapturingHandler(
        client: RecoveryMCPClient,
        captor: CapturingModelResponder
    )
        -> TachikomaPlanRecoveryHandler
    {
        TachikomaPlanRecoveryHandler(
            mcpClient: client,
            configProvider: StaticRecoveryConfigProvider(enabled: true, maxToolCalls: 5),
            modelConfig: RecoveryModelConfig(provider: .anthropic, modelName: "claude-sonnet-4-20250514"),
            timer: FakeTimer(),
            logger: SilentLogger(),
            responderFactory: { _ in captor },
            deadlineScheduler: VirtualDeadlineScheduler()
        )
    }

    private func makeExecutor(
        client: RecoveryMCPClient,
        handler: PlanRecoveryHandler,
        planText: String? = nil,
        parameters: [String: String]? = nil,
        configSecretKeys: Set<String> = []
    )
        -> AutoMobilePlanExecutor
    {
        // The default plan text declares `secretParameters:` itself; configSecretKeys exercises the
        // Configuration path, and planText/parameters let a test swap in a different scenario.
        let config = AutoMobilePlanExecutor.Configuration(
            transport: .daemonUnixSocket(path: "/tmp/xctestrunner-redaction-test.sock"),
            planPath: "redaction-plan.yaml",
            retryCount: 0,
            timeoutSeconds: 5,
            retryDelaySeconds: 0,
            startStep: 0,
            parameters: parameters ?? ["TOKEN": secret, "ENVIRONMENT": visible],
            secretParameterKeys: configSecretKeys,
            aiAssistance: true
        )
        return AutoMobilePlanExecutor(
            configuration: config,
            planLoader: StubPlanLoader(content: planText ?? plan),
            mcpClient: client,
            timer: FakeTimer(),
            logger: SilentLogger(),
            recoveryHandler: handler,
            recoveryConfigProvider: StaticRecoveryConfigProvider(enabled: true, maxToolCalls: 5),
            recoveryModelConfig: nil,
            daemonEnsurer: HermeticDaemonEnsurer(),
            deadlineScheduler: VirtualDeadlineScheduler(),
            heldSessionController: RecordingHeldSessionController()
        )
    }

    private func requestText(_ request: ModelRequest) -> String {
        var parts: [String] = []
        if let system = request.systemInstructions {
            parts.append(system)
        }
        for message in request.messages {
            switch message {
            case let .user(_, content):
                if case let .text(value) = content {
                    parts.append(value)
                }
            case let .assistant(_, content, _):
                for item in content {
                    if case let .outputText(value) = item {
                        parts.append(value)
                    }
                }
            case let .tool(_, _, content):
                // Tool-result messages re-enter the next ModelRequest (issue #6094's loop channel),
                // so they must be inspected for leaked secrets, not skipped.
                parts.append(content)
            case let .system(_, content):
                parts.append(content)
            default:
                break
            }
        }
        return parts.joined(separator: "\n")
    }

    private func decodedDaemonPlanContent(_ call: RecoveryMCPClient.Call?) -> String? {
        guard let raw = call?.arguments["planContent"] as? String else {
            return nil
        }
        let base64 = raw.hasPrefix("base64:") ? String(raw.dropFirst("base64:".count)) : raw
        guard let data = Data(base64Encoded: base64) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }
}

/// Fake `ModelResponding` that records every `ModelRequest` it is asked to answer, then ends the
/// recovery loop with a final (no-tool-call) response so nothing touches the device.
private final class CapturingModelResponder: ModelResponding, @unchecked Sendable {
    private(set) var captured: [ModelRequest] = []

    func respond(_ request: ModelRequest) async throws -> ModelResponse {
        captured.append(request)
        return ModelResponse(id: "resp", content: [.outputText("done")])
    }
}

/// Fake `ModelResponding` that replays a scripted sequence of responses AND records EVERY
/// `ModelRequest` across the whole agent loop — not just the first (issue #6094). The follow-up
/// requests carry the tool-call results from the prior turn, which is the second-order channel this
/// suite pins: a secret visible on-screen at recovery time must not reach the provider through those
/// re-sent tool results.
private final class ScriptedCapturingModelResponder: ModelResponding, @unchecked Sendable {
    private(set) var captured: [ModelRequest] = []
    private var scripted: [ModelResponse]

    init(_ scripted: [ModelResponse]) {
        self.scripted = scripted
    }

    func respond(_ request: ModelRequest) async throws -> ModelResponse {
        captured.append(request)
        if scripted.isEmpty {
            return ModelResponse(id: "resp", content: [.outputText("recovery complete")])
        }
        return scripted.removeFirst()
    }
}

/// Direct tests of `PlanMetadataParser`'s `secretParameters:` parsing (#6029). Parity note: these
/// forms parse the same keys snakeyaml gives the Android runner for the common and escaped forms
/// (issue #6141 added full double-quoted escape decoding here). The one deliberate divergence is a
/// PLAIN scalar spanning lines (`[API⏎TOKEN]`): iOS's scanner over-captures token-per-line
/// (`["API","TOKEN"]`) while snakeyaml folds it to `"API TOKEN"` — both fail safe toward
/// over-redaction, neither leaks.
/// Tests of `PlanMetadataParser.parseSecretParameterKeys` — the RAW, placeholder-tolerant scanner
/// that replaces the previous substituted-content / YAML-load parsing (#6029 convergence).
final class PlanMetadataSecretParametersParsingTests: XCTestCase {
    func testFlushZeroIndentBlockSequenceIsParsed() {
        let yaml = """
        name: P
        secretParameters:
        - TOKEN
        - PASSWORD
        steps:
          - tool: observe
        """
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["TOKEN", "PASSWORD"])
    }

    func testIndentedBlockSequenceIsParsed() {
        let yaml = """
        name: P
        secretParameters:
          - TOKEN
        steps:
          - tool: observe
        """
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["TOKEN"])
    }

    func testInlineFlowListIsParsed() {
        let yaml = "name: P\nsecretParameters: [TOKEN, \"PASSWORD\"]\nsteps:\n  - tool: observe"
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["TOKEN", "PASSWORD"])
    }

    func testInlineFlowListDoesNotSplitOnCommaInsideQuotes() {
        let yaml = "name: P\nsecretParameters: [\"API,TOKEN\", plain]\nsteps:\n  - tool: observe"
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["API,TOKEN", "plain"])
    }

    // MARK: - Multiline flow sequence (#6097)

    func testMultilineFlowListWithClosingBracketOnOwnLineIsParsed() {
        // The bracketed flow value spans multiple lines with `]` alone on the last line — the form the
        // line scanner previously dropped, silently disabling redaction (#6097 fail-open gap).
        let yaml = """
        name: P
        secretParameters: [
          TOKEN,
          PASSWORD
        ]
        steps:
          - tool: observe
        """
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["TOKEN", "PASSWORD"])
    }

    func testMultilineFlowListWithTrailingCommaAndClosingBracketTrailingItemIsParsed() {
        // Trailing comma after the last item, and `]` trailing the final item rather than on its own line.
        let yaml = """
        name: P
        secretParameters: [
          TOKEN,
          PASSWORD,
          API ]
        steps:
          - tool: observe
        """
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["TOKEN", "PASSWORD", "API"])
    }

    func testMultilineFlowListToleratesQuotedCommaAndPlaceholderKeys() {
        // Quoted comma is not a separator, and `${...}` key names stay literal (resolved later) — the
        // multiline path must respect the same rules as the single-line inline path.
        let yaml = """
        name: P
        secretParameters: [
          "API,TOKEN",
          ${SECRET_KEY}
        ]
        steps:
          - tool: observe
        """
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["API,TOKEN", "${SECRET_KEY}"])
    }

    func testEmptyMultilineFlowListYieldsEmptySet() {
        let yaml = """
        name: P
        secretParameters: [
        ]
        steps:
          - tool: observe
        """
        XCTAssertTrue(PlanMetadataParser.parseSecretParameterKeys(from: yaml).isEmpty)
    }

    func testMultilineFlowQuotedHashKeyDoesNotDropFollowingKey() {
        // A `#` inside a quoted item is literal YAML, not a comment. If comments are stripped
        // line-by-line before quote state is known, `"API#TOKEN"` is truncated to `"API`, the now
        // unterminated quote swallows the rest of the declaration, and PASSWORD is dropped — its
        // secret would reach the LLM unredacted (#6097 Codex P1, fail-open).
        let yaml = """
        name: P
        secretParameters: [
          "API#TOKEN",
          PASSWORD
        ]
        steps:
          - tool: observe
        """
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["API#TOKEN", "PASSWORD"])
    }

    func testMultilineFlowEscapedQuoteBeforeBracketDoesNotDropFollowingKey() {
        // A double-quoted scalar may contain an escaped quote (`\"`); the `]` that follows it is still
        // inside the scalar, not the sequence terminator. Without escape tracking the terminator finder
        // stops early and PASSWORD is dropped — fail-open (#6097 Codex P2).
        let yaml = """
        name: P
        secretParameters: [
          "a\\"]b",
          PASSWORD
        ]
        steps:
          - tool: observe
        """
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["a\"]b", "PASSWORD"])
    }

    func testFlowTrailingCommentAfterClosingBracketIsIgnored() {
        // A comment after the closing `]` (with or without a leading space) must be ignored, and TOKEN
        // still parsed. Dropping it would leak TOKEN's value (#6097 Codex — comment after `]`).
        let spaced = "name: P\nsecretParameters: [TOKEN] # trailing comment\nsteps:\n  - tool: observe"
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: spaced), ["TOKEN"])
        let unspaced = "name: P\nsecretParameters: [TOKEN]#c\nsteps:\n  - tool: observe"
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: unspaced), ["TOKEN"])
    }

    func testMultilineFlowClosingBracketFollowedByCommentIsIgnored() {
        let yaml = """
        name: P
        secretParameters: [
          TOKEN,
          PASSWORD
        ]  # both declared
        steps:
          - tool: observe
        """
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["TOKEN", "PASSWORD"])
    }

    func testUnrecognizedTokenIsStillCapturedAsSecretKeyFailSafe() {
        // Fail-safe: an unusual/unrecognized token in the block must still be treated as a secret key
        // (over-capture) rather than dropped — dropping would fail open (#6097).
        let yaml = "name: P\nsecretParameters: [TOKEN, @@weird@@]\nsteps:\n  - tool: observe"
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["TOKEN", "@@weird@@"])
    }

    func testUnterminatedFlowSequenceFailsSafeByCapturingTokens() {
        // A flow sequence with no closing `]` (e.g. substitution truncation) must still yield its
        // tokens (over-capture), never silently drop them (#6097 fail-safe).
        let yaml = "name: P\nsecretParameters: [\n  TOKEN,\n  PASSWORD"
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["TOKEN", "PASSWORD"])
    }

    func testDoubleQuotedLineContinuationKeyIsCaptured() {
        // A double-quoted key using YAML line continuation (`"API\`⏎`TOKEN"` decodes to `APITOKEN`)
        // must be captured so its value is redacted (#6097 Codex — line continuation).
        let yaml = "name: P\nsecretParameters: [\n  \"API\\\n  TOKEN\"\n]\nsteps:\n  - tool: observe"
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["APITOKEN"])
    }

    func testCRLFAuthoredQuotedMultilineKeyHasNoCarriageReturn() {
        // A CRLF-authored quoted multiline key must not embed `\r` (#6097 Codex — CRLF). The quoted
        // scalar folds to `API TOKEN`.
        let yaml = "name: P\r\nsecretParameters: [\r\n  \"API\r\n  TOKEN\"\r\n]\r\nsteps:\r\n  - tool: observe"
        let keys = PlanMetadataParser.parseSecretParameterKeys(from: yaml)
        XCTAssertEqual(keys, ["API TOKEN"])
        XCTAssertFalse(keys.contains { $0.contains("\r") }, "no key may contain a carriage return")
    }

    func testPlainMultilineFlowScalarCapturesEachLinesTokenFailSafe() {
        // A plain (unquoted) scalar spanning lines is captured token-per-line so both are redacted,
        // rather than blended into one mis-named key (#6097 Codex — plain-scalar folding).
        let yaml = "name: P\nsecretParameters: [\n  API\n  TOKEN\n]\nsteps:\n  - tool: observe"
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["API", "TOKEN"])
    }

    func testQuotedWhitespaceOnlyKeyIsNotDropped() {
        // Stripping the quotes before the trim would discard `" "`; a single space is a valid quoted
        // key and must be kept so its parameter value is redacted (#6097 Codex — quoted whitespace).
        let yaml = "name: P\nsecretParameters: [\" \"]\nsteps:\n  - tool: observe"
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), [" "])
    }

    func testDoubleQuotedHexEscapeIsDecodedToSpecCorrectKey() {
        // Issue #6141: `\x54` decodes to `T`, so `"API\x54OKEN"` yields the key `APITOKEN` — matching
        // what snakeyaml gives the Android runner.
        let yaml = "name: P\nsecretParameters: [\"API\\x54OKEN\"]\nsteps:\n  - tool: observe"
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["APITOKEN"])
    }

    func testDoubleQuotedUnicodeEscapesAreDecoded() {
        // `A` -> A, `\U00000042` -> B (issue #6141).
        let yaml = "name: P\nsecretParameters: [\"\\u0041\\U00000042\"]\nsteps:\n  - tool: observe"
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["AB"])
    }

    func testDoubleQuotedControlEscapesAreDecoded() {
        // `\t` -> TAB, `\n` -> LF (issue #6141).
        let yaml = "name: P\nsecretParameters: [\"A\\tB\\nC\"]\nsteps:\n  - tool: observe"
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["A\tB\nC"])
    }

    func testBlockSequenceDoubleQuotedHexEscapeIsDecoded() {
        // The block-sequence form decodes escapes the same way as the flow form (issue #6141).
        let yaml = "name: P\nsecretParameters:\n  - \"API\\x54OKEN\"\nsteps:\n  - tool: observe"
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["APITOKEN"])
    }

    func testMalformedHexEscapeIsKeptLiteralFailSafe() {
        // A `\x` with too few hex digits cannot decode; keep it literal (fail-safe over-capture) so
        // the token is still treated as a secret key rather than dropped (issue #6141).
        let yaml = "name: P\nsecretParameters: [\"API\\xZZ\"]\nsteps:\n  - tool: observe"
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["APIxZZ"])
    }

    func testSingleQuotedBlockScalarUnescapesDoubledQuote() {
        // A single-quoted scalar is literal except `''` -> `'` (issue #6141).
        let yaml = "name: P\nsecretParameters:\n  - 'API''TOKEN'\nsteps:\n  - tool: observe"
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["API'TOKEN"])
    }

    func testFlushBlockStopsAtNextTopLevelKey() {
        let yaml = """
        name: P
        secretParameters:
        - TOKEN
        platform: ios
        steps:
          - tool: observe
        """
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["TOKEN"])
    }

    func testNoSecretParametersYieldsEmptySet() {
        XCTAssertTrue(PlanMetadataParser.parseSecretParameterKeys(from: "name: P\nsteps:\n  - tool: observe").isEmpty)
    }

    func testToleratesPlaceholderKeyAndUnrelatedPlaceholderLists() {
        // A parameterized key name is kept literal here (resolved later); an unrelated flow list with
        // placeholders (which a full YAML load would choke on) must not affect the scan (#6029 review).
        let yaml = """
        name: P
        secretParameters:
          - ${SECRET_KEY}
        steps:
          - tool: observe
            waitFor:
              textAny: [${LABEL}, OK]
          - tool: inputText
            text: "${SECRET_KEY}"
        """
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["${SECRET_KEY}"])
    }

    func testScansRawPlanSoInjectedContentInAValueCannotAddKeys() {
        // Parsing runs on the RAW plan: a `${EVIL}` value that would expand to a fake secretParameters
        // block cannot inject keys, because the scanner never sees substituted values (#6029 review).
        let yaml = """
        name: P
        secretParameters:
          - REAL
        steps:
          - tool: inputText
            text: "${EVIL}"
        """
        XCTAssertEqual(PlanMetadataParser.parseSecretParameterKeys(from: yaml), ["REAL"])
    }
}

/// Direct redaction tests for `SecretRedaction` — the type now only expands Unicode forms and scrubs;
/// resolution/substitution is the executor's job (tested end-to-end below). (#6029 convergence)
final class SecretRedactionTests: XCTestCase {
    func testSecretParameterValuesMatchesExactlyAndDoesNotOverRedact() {
        let values = SecretRedaction.secretParameterValues(
            declaredKeys: ["TOKEN"], parameters: ["TOKEN": "S", "VIS": "v"]
        )
        XCTAssertEqual(values, ["S"])
    }

    func testSecretParameterValuesMatchesLenientlyAcrossWhitespaceAndCase() {
        // A folded/whitespaced key still resolves to the parameter by normalized identity (#6097).
        let values = SecretRedaction.secretParameterValues(
            declaredKeys: ["API TOKEN"], parameters: ["apitoken": "S"]
        )
        XCTAssertEqual(values, ["S"])
    }

    func testSecretParameterValuesKeepsAQuotedWhitespaceKeysValue() {
        let values = SecretRedaction.secretParameterValues(
            declaredKeys: [" "], parameters: [" ": "SECRET"]
        )
        XCTAssertEqual(values, ["SECRET"])
    }

    func testSecretParameterValuesOverRedactsBackslashKeyDespiteDecoyExactMatch() {
        // The un-decoded hex key `API\x54OKEN` exact-matches a DECOY parameter of the same raw
        // spelling, while the REAL value lives under the YAML-decoded `APITOKEN`. A backslash key must
        // not trust that coincidental match — it over-redacts so REAL is scrubbed too (#6097).
        let values = SecretRedaction.secretParameterValues(
            declaredKeys: ["API\\x54OKEN"], parameters: ["APITOKEN": "REAL", "APIx54OKEN": "DECOY"]
        )
        XCTAssertTrue(values.contains("REAL"), "the real (decoded-name) secret value must be scrubbed")
    }

    func testSecretParameterValuesOverRedactsWhenAKeyCannotBeResolvedFailSafe() {
        // A hex-escaped key parsed as `APIx54OKEN` matches no parameter by name or normalization, so
        // every parameter value is scrubbed — the secret cannot leak (#6097 fail-safe).
        let values = SecretRedaction.secretParameterValues(
            declaredKeys: ["APIx54OKEN"], parameters: ["APITOKEN": "SECRETV", "VIS": "visible"]
        )
        XCTAssertTrue(values.contains("SECRETV"), "the real secret value must be scrubbed")
    }

    func testRedactsSecretRegardlessOfUnicodeNormalization() {
        let composedValue = "caf\u{00E9}-token" // NFC form
        let values = SecretRedaction.secretValues([composedValue])
        // The same secret occurs in the target text in its decomposed (NFD) form.
        let decomposedOccurrence = composedValue.decomposedStringWithCanonicalMapping
        let result = SecretRedaction.redact("error: " + decomposedOccurrence + " seen", secretValues: values)
        XCTAssertTrue(result.contains(SecretRedaction.placeholder))
        XCTAssertFalse(
            result.unicodeScalars.contains("\u{0301}"),
            "the decomposed secret's combining mark must be gone"
        )
    }

    func testShorterSecretSubstringOfLongerIsFullyRedactedWithoutResidue() {
        // "ab" is a substring of "abcdef"; longest-first replacement must mask the whole "abcdef"
        // rather than leaving a "cdef" residue (which shortest-first would).
        let values = SecretRedaction.secretValues(["ab", "abcdef"])
        let result = SecretRedaction.redact("x abcdef y", secretValues: values)
        XCTAssertEqual(result, "x \(SecretRedaction.placeholder) y")
        XCTAssertFalse(result.contains("cdef"), "no substring residue may remain")
    }

    func testEmptyValuesAreIgnored() {
        XCTAssertEqual(
            SecretRedaction.redact("unchanged", secretValues: SecretRedaction.secretValues([""])),
            "unchanged"
        )
    }

    func testRedactsJsonEscapedSecretInAToolResult() {
        // The recovery loop's tool/observe results are JSON (issue #6094). A secret with a
        // JSON-special character appears there only in its escaped form, which the literal raw value
        // would not match. secretValues must emit the JSON-escaped variant so it is still scrubbed.
        let secret = "pa\"ss\\word\nline"
        let values = SecretRedaction.secretValues([secret])
        // The JSON-serialized tool result carries the secret in escaped form (as JSON.stringify /
        // JSONSerialization would produce), NOT the raw value.
        let toolResultJSON = "{\"field\":\"token pa\\\"ss\\\\word\\nline\"}"
        XCTAssertFalse(toolResultJSON.contains(secret), "precondition: the raw secret is not literally present")
        let result = SecretRedaction.redact(toolResultJSON, secretValues: values)
        XCTAssertTrue(result.contains(SecretRedaction.placeholder), "the JSON-escaped secret must be redacted")
        XCTAssertFalse(result.contains("pa\\\"ss"), "no escaped-secret fragment may survive")

        // A DOUBLE-encoded occurrence (a JSON string nested inside another JSON string, as a
        // re-serialized MCP envelope produces) must also be scrubbed (#6094).
        let doubleEncoded = SecretRedaction.jsonEscaped(SecretRedaction.jsonEscaped(secret))
        let nested = "{\"text\":\"" + doubleEncoded + "\"}"
        XCTAssertFalse(
            nested.contains(secret),
            "precondition: the raw secret is not present in the double-encoded text"
        )
        let nestedResult = SecretRedaction.redact(nested, secretValues: values)
        XCTAssertTrue(nestedResult.contains(SecretRedaction.placeholder), "the double-encoded secret must be redacted")
        XCTAssertFalse(nestedResult.contains("word"), "no double-escaped secret fragment may survive")
    }

    func testSecretCollidingWithTheRedactionMarkerDoesNotSurvive() {
        // A secret whose VALUE is the marker (or a substring of it) must not be reintroduced by the
        // replacement — e.g. replacing "REDACTED" with "***REDACTED***" would leave "REDACTED" (#6094).
        for secret in ["REDACTED", "***REDACTED***", "***"] {
            let values = SecretRedaction.secretValues([secret])
            let result = SecretRedaction.redact("token " + secret + " here", secretValues: values)
            XCTAssertFalse(
                result.contains(secret),
                "the marker-colliding secret \"\(secret)\" must not survive redaction"
            )
            XCTAssertTrue(result.contains("token "), "non-secret context is preserved")
        }
    }

    func testShorterSecretReplacementCannotSynthesizeLongerSecretContainingTheMarker() {
        // Reverse marker collision (#6146): declared `abc` and `X***REDACTED***Y`, text `XabcY`.
        // Longest-first finds the longer secret nowhere, replaces `abc` with the marker, and the
        // result IS the longer secret — fully present after its only removal opportunity passed.
        let longer = "X" + SecretRedaction.placeholder + "Y"
        let values = SecretRedaction.secretValues(["abc", longer])
        let result = SecretRedaction.redact("XabcY", secretValues: values)
        XCTAssertFalse(result.contains(longer), "the marker-containing secret must not be synthesized")
        XCTAssertFalse(result.contains("abc"), "the shorter secret must be redacted")
        XCTAssertEqual(result, SecretRedaction.placeholder)
    }

    func testMarkerSubstringSecretIsNotReintroducedByAnotherSecretsReplacement() {
        // `REDACTED` is itself a declared secret, so substituting `***REDACTED***` for `abc` would
        // put that declared value in the output verbatim (#6146).
        let values = SecretRedaction.secretValues(["REDACTED", "abc"])
        let result = SecretRedaction.redact("token abc here", secretValues: values)
        XCTAssertFalse(result.contains("REDACTED"), "the marker-substring secret must not survive")
        XCTAssertFalse(result.contains("abc"), "the ordinary secret must be redacted")
        XCTAssertTrue(result.hasPrefix("token ") && result.hasSuffix(" here"), "context is preserved")
    }

    func testSecretEqualToTheMarkerIsNotReintroducedByAnotherSecretsReplacement() {
        let values = SecretRedaction.secretValues([SecretRedaction.placeholder, "abc"])
        let result = SecretRedaction.redact("token abc here", secretValues: values)
        XCTAssertFalse(result.contains(SecretRedaction.placeholder), "the marker secret must not survive")
        XCTAssertFalse(result.contains("abc"), "the ordinary secret must be redacted")
    }

    func testOrdinaryTextIsUnchangedAndAnOrdinarySecretKeepsItsContext() {
        let values = SecretRedaction.secretValues(["s3cr3t"])
        XCTAssertEqual(SecretRedaction.redact("nothing to see", secretValues: values), "nothing to see")
        XCTAssertEqual(
            SecretRedaction.redact("token s3cr3t here", secretValues: values),
            "token " + SecretRedaction.placeholder + " here"
        )
    }

    func testReplacementChainThatDoesNotConvergeOverRedactsTheWholeText() {
        // Each pass of `X***REDACTED***` -> marker consumes one leading `X`, so a run of `X`s longer
        // than the pass budget cannot converge in time. The fail-safe is the marker alone —
        // over-redact, never leak (#6146). The surrounding `pre`/`post` context distinguishes the
        // fail-safe (whole text -> marker) from a converged result (`pre ***REDACTED*** post`).
        let chained = "X" + SecretRedaction.placeholder
        let values = SecretRedaction.secretValues(["abc", chained])
        let result = SecretRedaction.redact("pre XXXXXXXXabc post", secretValues: values)
        XCTAssertEqual(result, SecretRedaction.placeholder)
    }

    func testChainThatConvergesOnTheFinalPermittedPassKeepsItsContext() {
        // Secret `*X` alone allows two passes: `prefix *XX suffix` -> `prefix ***REDACTED***X suffix`
        // (still contains `*X`) -> `prefix ***REDACTED*****REDACTED*** suffix`, which is clean. That
        // final result must be kept, not discarded for the whole-text fallback (#6146 Codex review).
        let values = SecretRedaction.secretValues(["*X"])
        let result = SecretRedaction.redact("prefix *XX suffix", secretValues: values)
        XCTAssertNil(result.range(of: "*X", options: [.literal]), "the secret must not survive")
        XCTAssertTrue(result.hasPrefix("prefix ") && result.hasSuffix(" suffix"), "context is preserved")
    }

    func testNoDeclaredValueSurvivesRedactionForATableOfAdversarialInputs() {
        let marker = SecretRedaction.placeholder
        let cases: [(secrets: [String], text: String)] = [
            (["abc", "X" + marker + "Y"], "XabcY"),
            (["REDACTED", "abc"], "abc"),
            ([marker, "abc"], "token abc"),
            (["ab", "abcdef"], "x abcdef y"),
            (["***", "a"], "a*a*a"),
            (["X" + marker, "abc"], "XXXabc XabcX"),
            ([marker + marker, "q"], "qq q"),
            (["*", "R"], "R*R"),
            (["\u{00E9}", "cafe\u{0301}"], "caf\u{00E9} cafe\u{0301}"),
            (["pa\"ss", "\\\""], "{\"v\":\"pa\\\"ss\"}"),
            (["s3cr3t"], "nothing to see"),
        ]
        for testCase in cases {
            let values = SecretRedaction.secretValues(testCase.secrets)
            let result = SecretRedaction.redact(testCase.text, secretValues: values)
            for value in values {
                XCTAssertNil(
                    result.range(of: value, options: [.literal]),
                    "declared value \"\(value)\" survived as \"\(result)\" for input \"\(testCase.text)\""
                )
            }
        }
    }
}

@MainActor
final class RunBlockingBoundTests: XCTestCase {
    private func makeContext() -> FailedStepContext {
        FailedStepContext(
            failedStepIndex: 0,
            failedTool: "tapOn",
            error: "element not found",
            succeededSteps: [],
            planContent: "name: P\nsteps:\n  - tool: observe",
            platform: "ios",
            sessionUuid: "sess-1",
            deviceId: "dev-1",
            failureObservation: nil
        )
    }

    func testHungModelCallFailsRecoveryInsteadOfHanging() async throws {
        let client = RecoveryMCPClient()
        let scheduler = VirtualDeadlineScheduler()
        let responder = LateModelResponder()
        let handler = TachikomaPlanRecoveryHandler(
            mcpClient: client,
            configProvider: StaticRecoveryConfigProvider(enabled: true, maxToolCalls: 5),
            modelConfig: RecoveryModelConfig(provider: .anthropic, modelName: "claude-sonnet-4-20250514"),
            timeoutSeconds: 120,
            timer: FakeTimer(),
            logger: SilentLogger(),
            responderFactory: { _ in responder },
            deadlineScheduler: scheduler
        )
        let context = makeContext()
        let task = Task { await handler.attemptRecovery(context) }
        try await responder.started.wait(for: 1)
        try await scheduler.registered.wait(for: 1)
        scheduler.advance(by: 120)
        let outcome = await task.value
        XCTAssertFalse(outcome.success, "a timed-out model call must yield a failed recovery outcome")
        XCTAssertEqual(scheduler.currentTime, 120)
        XCTAssertEqual(responder.finished.count, 0, "deadline returns before the uncooperative call finishes")
        XCTAssertTrue(client.calls.isEmpty, "no tools when the model times out")
        try await responder.cancelled.wait(for: 1)
        // A late tool call must never reach the device. The deadline already returned above.
        XCTAssertTrue(responder.result.resume(returning: StubModelResponder.toolCall(name: "tapOn")))
        try await responder.finished.wait(for: 1)
        XCTAssertFalse(responder.result.resume(returning: StubModelResponder.final()))
        XCTAssertTrue(client.calls.isEmpty, "late model results must not execute tools or observe")
    }

    func testCancellationIgnoresLateModelResult() async throws {
        let client = RecoveryMCPClient()
        let scheduler = VirtualDeadlineScheduler()
        let responder = LateModelResponder()
        let handler = TachikomaPlanRecoveryHandler(
            mcpClient: client,
            configProvider: StaticRecoveryConfigProvider(),
            modelConfig: RecoveryModelConfig(provider: .anthropic, modelName: "fake-model"),
            timer: FakeTimer(),
            logger: SilentLogger(),
            responderFactory: { _ in responder },
            deadlineScheduler: scheduler
        )
        let context = makeContext()
        let task = Task { await handler.attemptRecovery(context) }
        try await responder.started.wait(for: 1)
        try await scheduler.registered.wait(for: 1)
        task.cancel()
        let outcome = await task.value
        XCTAssertFalse(outcome.success)
        XCTAssertEqual(responder.finished.count, 0, "cancellation must not join the abandoned model call")
        XCTAssertEqual(scheduler.pendingCount, 0)
        try await responder.cancelled.wait(for: 1)
        responder.result.resume(returning: StubModelResponder.toolCall(name: "tapOn"))
        try await responder.finished.wait(for: 1)
        XCTAssertTrue(client.calls.isEmpty, "late recovery responses must not execute tools")
    }

    func testDeadlineTimesOutOnHungOperation() async throws {
        let scheduler = VirtualDeadlineScheduler()
        let pending = SingleResumeCell<Int>()
        let started = TransportEvents()
        let task = Task {
            try await withDeadline(
                seconds: 5,
                scheduler: scheduler,
                timeoutError: RecoveryTimeoutError(timeoutSeconds: 5)
            ) {
                started.signal()
                return try await pending.wait()
            }
        }
        try await started.wait(for: 1)
        try await scheduler.registered.wait(for: 1)
        scheduler.advance(by: 5)
        await assertAsyncThrowsError({ try await task.value }, verify: { error in
            XCTAssertEqual(error as? RecoveryTimeoutError, RecoveryTimeoutError(timeoutSeconds: 5))
            XCTAssertEqual(String(describing: error), "Recovery model call timed out after 5.0s")
        })
    }

    func testDeadlineCancelsHungTaskOnTimeout() async throws {
        let scheduler = VirtualDeadlineScheduler()
        let pending = SingleResumeCell<Int>()
        let cancelled = TransportEvents()
        let started = TransportEvents()
        let task = Task {
            try await withDeadline(
                seconds: 5,
                scheduler: scheduler,
                timeoutError: RecoveryTimeoutError(timeoutSeconds: 5)
            ) {
                try await withTaskCancellationHandler {
                    started.signal()
                    return try await pending.wait()
                } onCancel: {
                    cancelled.signal()
                }
            }
        }
        try await started.wait(for: 1)
        try await scheduler.registered.wait(for: 1)
        scheduler.advance(by: 5)
        await assertAsyncThrowsError { try await task.value }
        try await cancelled.wait(for: 1)
        XCTAssertFalse(pending.resume(returning: 1), "cancelled operation unwinds and rejects late results")
    }

    func testDeadlinePassesThroughSuccess() async throws {
        let value = try await withDeadline(
            seconds: 5,
            scheduler: VirtualDeadlineScheduler(),
            timeoutError: RecoveryTimeoutError(timeoutSeconds: 5)
        ) { 42 }
        XCTAssertEqual(value, 42)
    }

    func testDeadlineRethrowsOperationError() async {
        struct Boom: Error {}
        await assertAsyncThrowsError({
            try await withDeadline(
                seconds: 5,
                scheduler: VirtualDeadlineScheduler(),
                timeoutError: RecoveryTimeoutError(timeoutSeconds: 5)
            ) { () async throws -> Int in
                throw Boom()
            }
        }, verify: { error in
            XCTAssertTrue(error is Boom, "operation errors must propagate")
        })
    }
}

// MARK: - Shared fakes

private struct StubPlanLoader: AutoMobilePlanLoading {
    let content: String
    func loadPlan(at _: String, bundle _: Bundle?) throws -> String { content }
}

private struct SilentLogger: AutoMobileLogger {
    func info(_: String) {}
    func warn(_: String) {}
    func error(_: String) {}
}

/// Sequential fake: the executor invokes it serially; tests inspect only after awaiting execution.
private final class SpyRecoveryHandler: PlanRecoveryHandler, @unchecked Sendable {
    private let outcome: RecoveryOutcome
    private(set) var receivedContexts: [FailedStepContext] = []

    init(outcome: RecoveryOutcome) {
        self.outcome = outcome
    }

    func attemptRecovery(_ context: FailedStepContext) async -> RecoveryOutcome {
        receivedContexts.append(context)
        return outcome
    }
}

/// Records which held sessions were being heartbeated at the moment recovery ran (#11072).
private final class HeartbeatProbingRecoveryHandler: PlanRecoveryHandler, @unchecked Sendable {
    private let heldSessions: RecordingHeldSessionController
    private let outcome: RecoveryOutcome
    private(set) var heartbeatsDuringRecovery: [[String]] = []

    init(heldSessions: RecordingHeldSessionController, outcome: RecoveryOutcome) {
        self.heldSessions = heldSessions
        self.outcome = outcome
    }

    func attemptRecovery(_: FailedStepContext) async -> RecoveryOutcome {
        heartbeatsDuringRecovery.append(heldSessions.liveHeartbeats)
        return outcome
    }
}

/// Sequential fake: setup precedes execution; inspection follows the awaited completion. No late model
/// operation can access this client. The dynamic argument dictionary is intentionally retained locally.
private final class RecoveryMCPClient: AutoMobileMCPClient, @unchecked Sendable {
    struct Call {
        let name: String
        let arguments: [String: Any]
    }

    private(set) var calls: [Call] = []
    private var executePlanResponses: [MCPToolResponse] = []
    var flagResourceText = "{\"key\":\"ai-recovery\",\"enabled\":true,\"config\":{\"maxToolCalls\":5}}"
    var toolResponseText = "{\"ok\":true}"
    var observeText = "{\"elements\":{}}"

    var executePlanCalls: [Call] { calls.filter { $0.name == "executePlan" } }

    func queueExecutePlan(_ text: String) {
        executePlanResponses.append(MCPToolResponse(text: text))
    }

    func initialize(timeout _: TimeInterval) async throws {}

    func callTool(
        name: String,
        arguments: [String: Any],
        timeout _: TimeInterval
    )
        async throws -> MCPToolResponse
    {
        calls.append(Call(name: name, arguments: arguments))
        if name == "setToolEnabled" {
            return MCPToolResponse(text: "{\"enabled\":true}")
        }
        if name == "executePlan" {
            guard !executePlanResponses.isEmpty else {
                return MCPToolResponse(text: "{\"success\":true,\"executedSteps\":0,\"totalSteps\":0}")
            }
            return executePlanResponses.removeFirst()
        }
        if name == "observe" {
            return MCPToolResponse(text: observeText)
        }
        return MCPToolResponse(text: toolResponseText)
    }

    func readResource(uri _: String, timeout _: TimeInterval) async throws -> MCPResourceResponse {
        MCPResourceResponse(text: flagResourceText)
    }

    func resetSession() {}
}

/// Fake `ModelResponding` that replays a fixed script of responses (or repeats one forever).
private final class StubModelResponder: ModelResponding, @unchecked Sendable {
    private var scripted: [ModelResponse]
    private let repeated: ModelResponse?

    init(_ scripted: [ModelResponse]) {
        self.scripted = scripted
        repeated = nil
    }

    init(alwaysReturn response: ModelResponse) {
        scripted = []
        repeated = response
    }

    func respond(_: ModelRequest) async throws -> ModelResponse {
        if let repeated = repeated {
            return repeated
        }
        if scripted.isEmpty {
            return StubModelResponder.final()
        }
        return scripted.removeFirst()
    }

    static func toolCall(name: String, arguments: String = "{}") -> ModelResponse {
        ModelResponse(
            id: "resp",
            content: [.toolCall(ToolCallItem(
                id: "call-\(name)",
                function: FunctionCall(name: name, arguments: arguments)
            ))]
        )
    }

    static func final() -> ModelResponse {
        ModelResponse(id: "resp", content: [.outputText("recovery complete")])
    }
}

/// Ignores cancellation until the test explicitly releases it. No leaked continuation or real sleep.
private final class LateModelResponder: ModelResponding {
    let started = TransportEvents()
    let cancelled = TransportEvents()
    let finished = TransportEvents()
    let result = SingleResumeCell<ModelResponse>()

    func respond(_: ModelRequest) async throws -> ModelResponse {
        try await withTaskCancellationHandler {
            started.signal()
            let response = try await result.wait(cancellable: false)
            finished.signal()
            return response
        } onCancel: {
            self.cancelled.signal()
        }
    }
}

private func planJSON(
    success: Bool,
    executedSteps: Int,
    totalSteps: Int,
    failedStep: [String: Any]? = nil,
    sessionHeld: Bool? = nil
)
    -> String
{
    var payload: [String: Any] = [
        "success": success,
        "executedSteps": executedSteps,
        "totalSteps": totalSteps,
    ]
    if let sessionHeld = sessionHeld {
        payload["sessionHeld"] = sessionHeld
    }
    if let failedStep = failedStep {
        payload["failedStep"] = failedStep
        if let error = failedStep["error"] {
            payload["error"] = error
        }
    }
    return jsonString(payload)
}

private func jsonString(_ payload: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8)
    else {
        return "{}"
    }
    return text
}
