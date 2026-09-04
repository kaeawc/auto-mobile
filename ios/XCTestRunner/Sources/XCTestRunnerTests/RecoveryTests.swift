import Tachikoma
import XCTest
@testable import XCTestRunner
import XCTestRunnerTestSupport

// Unit tests for AI-assisted failure recovery. All tests are hermetic: the model is faked
// (`StubModelResponder`) so nothing here touches the network or needs an API key.

final class RecoveryExecutorTests: XCTestCase {
    private let fourStepPlan = """
    name: Recovery Plan
    steps:
      - tool: observe
      - tool: launchApp
      - tool: tapOn
      - tool: inputText
    """

    func testRecoverySucceedsAndResumesFromNextStep() throws {
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 2, totalSteps: 4,
            failedStep: ["stepIndex": 2, "tool": "tapOn", "error": "no element", "device": "sim-1"]
        ))
        client.queueExecutePlan(planJSON(success: true, executedSteps: 4, totalSteps: 4))

        let handler = SpyRecoveryHandler(outcome: RecoveryOutcome(success: true))
        let executor = makeExecutor(client: client, handler: handler, recoveryEnabled: true)

        let result = try executor.execute(testMetadata: nil)

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
        XCTAssertEqual(executePlanCalls[1].arguments["startStep"] as? Int, 3)
        XCTAssertEqual(executePlanCalls[1].arguments["deviceId"] as? String, "sim-1")
    }

    func testRecoveryFailureThrowsOriginalAndDoesNotResume() throws {
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 3,
            failedStep: ["stepIndex": 1, "tool": "tapOn", "error": "boom"]
        ))

        let handler = SpyRecoveryHandler(outcome: RecoveryOutcome(success: false))
        let executor = makeExecutor(client: client, handler: handler, recoveryEnabled: true)

        XCTAssertThrowsError(try executor.execute(testMetadata: nil)) { error in
            let description = String(describing: error)
            XCTAssertTrue(description.contains("boom"), "should retain the original failure message")
            XCTAssertTrue(description.contains("AI recovery attempted"), "should note the failed recovery")
        }
        XCTAssertEqual(handler.receivedContexts.count, 1)
        XCTAssertEqual(client.executePlanCalls.count, 1, "must not resume when recovery failed")
    }

    func testRecoverySkippedWhenFlagDisabled() throws {
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 3,
            failedStep: ["stepIndex": 1, "tool": "tapOn", "error": "nope"]
        ))

        let handler = SpyRecoveryHandler(outcome: RecoveryOutcome(success: true))
        let executor = makeExecutor(client: client, handler: handler, recoveryEnabled: false)

        XCTAssertThrowsError(try executor.execute(testMetadata: nil))
        XCTAssertTrue(handler.receivedContexts.isEmpty, "flag off must not call the handler")
        XCTAssertEqual(client.executePlanCalls.count, 1)
    }

    func testRecoverySkippedInCiMode() throws {
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 3,
            failedStep: ["stepIndex": 1, "tool": "tapOn", "error": "nope"]
        ))

        let handler = SpyRecoveryHandler(outcome: RecoveryOutcome(success: true))
        let executor = makeExecutor(client: client, handler: handler, recoveryEnabled: true)

        let metadata = AutoMobilePlanExecutor.TestMetadata(testClass: "T", testMethod: "m", isCi: true)
        XCTAssertThrowsError(try executor.execute(testMetadata: metadata))
        XCTAssertTrue(handler.receivedContexts.isEmpty, "CI mode must skip recovery")
    }

    func testRecoverySkippedWhenAiAssistanceDisabled() throws {
        let client = RecoveryMCPClient()
        client.queueExecutePlan(planJSON(
            success: false, executedSteps: 1, totalSteps: 3,
            failedStep: ["stepIndex": 1, "tool": "tapOn", "error": "nope"]
        ))

        let handler = SpyRecoveryHandler(outcome: RecoveryOutcome(success: true))
        let executor = makeExecutor(client: client, handler: handler, recoveryEnabled: true, aiAssistance: false)

        XCTAssertThrowsError(try executor.execute(testMetadata: nil))
        XCTAssertTrue(handler.receivedContexts.isEmpty, "aiAssistance=false must skip recovery")
    }

    func testRecoveryAttemptedAtMostOncePerTest() throws {
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

        XCTAssertThrowsError(try executor.execute(testMetadata: nil))
        XCTAssertEqual(handler.receivedContexts.count, 1, "recovery is allowed at most once per test")
        XCTAssertEqual(client.executePlanCalls.count, 2, "initial attempt + one resume")
        XCTAssertEqual(client.executePlanCalls[1].arguments["startStep"] as? Int, 2)
    }

    // MARK: - Helpers

    private func makeExecutor(
        client: RecoveryMCPClient,
        handler: PlanRecoveryHandler,
        recoveryEnabled: Bool,
        aiAssistance: Bool = true
    )
        -> AutoMobilePlanExecutor
    {
        let config = AutoMobilePlanExecutor.Configuration(
            transport: .daemonUnixSocket(path: "/tmp/xctestrunner-recovery-test.sock"),
            planPath: "recovery-plan.yaml",
            retryCount: 0,
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
            recoveryConfigProvider: StaticRecoveryConfigProvider(enabled: recoveryEnabled, maxToolCalls: 5)
        )
    }
}

final class RecoveryConfigAndModelTests: XCTestCase {
    func testDaemonRecoveryConfigReadsFlagFromResource() {
        let client = RecoveryMCPClient()
        client.flagResourceText = jsonString(["enabled": false, "config": ["maxToolCalls": 9]])
        let provider = DaemonRecoveryConfigProvider(clientProvider: { client }, logger: SilentLogger())
        XCTAssertFalse(provider.isRecoveryEnabled())
        XCTAssertEqual(provider.maxRecoveryToolCalls(), 9)
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

    func testHandlerRunsToolLoopThenVerifiesWithObserve() {
        let client = RecoveryMCPClient()
        let responder = StubModelResponder([
            StubModelResponder.toolCall(name: "observe"),
            StubModelResponder.toolCall(name: "tapOn", arguments: "{\"selector\":{\"text\":\"OK\"}}"),
            StubModelResponder.final(),
        ])
        let handler = makeHandler(client: client, responder: responder, maxToolCalls: 5)

        let outcome = handler.attemptRecovery(makeContext())

        XCTAssertTrue(outcome.success, "a non-nil post-recovery observe means success")
        XCTAssertEqual(client.calls.map { $0.name }, ["observe", "tapOn", "observe"])

        let tapCall = client.calls.first { $0.name == "tapOn" }
        XCTAssertEqual(tapCall?.arguments["platform"] as? String, "ios")
        XCTAssertEqual(tapCall?.arguments["sessionUuid"] as? String, "sess-1")
        XCTAssertEqual(tapCall?.arguments["device"] as? String, "dev-1")
        XCTAssertEqual(tapCall?.arguments["action"] as? String, "tap", "tapOn action is injected when omitted")
        XCTAssertNotNil(tapCall?.arguments["selector"], "model-provided selector is preserved")
    }

    func testHandlerNoOpsWithoutModelConfig() {
        let client = RecoveryMCPClient()
        let handler = TachikomaPlanRecoveryHandler(
            mcpClient: client,
            configProvider: StaticRecoveryConfigProvider(enabled: true, maxToolCalls: 5),
            modelConfig: nil,
            timer: FakeTimer(),
            logger: SilentLogger(),
            responderFactory: { _ in StubModelResponder([]) }
        )

        let outcome = handler.attemptRecovery(makeContext())

        XCTAssertFalse(outcome.success)
        XCTAssertTrue(client.calls.isEmpty, "no model config means no device interaction")
    }

    func testHandlerRespectsMaxToolCallBudget() {
        let client = RecoveryMCPClient()
        // The model keeps asking to tap forever; the budget of 2 must cap real device tool calls.
        let responder = StubModelResponder(alwaysReturn: StubModelResponder.toolCall(name: "tapOn"))
        let handler = makeHandler(client: client, responder: responder, maxToolCalls: 2)

        _ = handler.attemptRecovery(makeContext())

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
            responderFactory: { _ in responder }
        )
    }
}

/// Issue #6029 (CWE-200): a secret plan parameter must never reach the third-party LLM provider
/// during AI-assisted recovery. These tests drive the FULL executor → recovery handler → model call
/// path with a real `TachikomaPlanRecoveryHandler` and a capturing `ModelResponding` so the assertion
/// is against the actual `ModelRequest` that would go over the wire, not a helper's rendering of it.
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

    func testSecretIsRedactedFromModelRequestWhileNonSecretIsPreserved() throws {
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
            responderFactory: { _ in captor }
        )
        let executor = makeExecutor(client: client, handler: handler)

        _ = try executor.execute(testMetadata: nil)

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

    func testSecretDeclaredOnlyViaConfigurationIsRedacted() throws {
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
            responderFactory: { _ in captor }
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

        _ = try executor.execute(testMetadata: nil)

        let request = try XCTUnwrap(captor.captured.first)
        XCTAssertFalse(requestText(request).contains(secret), "config-declared secret must also be redacted")
    }

    func testSecretRedactedWhenSecretParametersIsFlushZeroIndentBlockSequence() throws {
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
            responderFactory: { _ in captor }
        )
        let executor = makeExecutor(client: client, handler: handler, planText: flushPlan)

        _ = try executor.execute(testMetadata: nil)

        let request = try XCTUnwrap(captor.captured.first)
        XCTAssertFalse(
            requestText(request).contains(secret),
            "a flush-form secretParameters declaration must still redact on iOS"
        )
    }

    func testSecretRedactedWhenSecretParametersIsMultilineFlowSequence() throws {
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
            responderFactory: { _ in captor }
        )
        let executor = makeExecutor(client: client, handler: handler, planText: multilinePlan)

        _ = try executor.execute(testMetadata: nil)

        let request = try XCTUnwrap(captor.captured.first)
        XCTAssertFalse(
            requestText(request).contains(secret),
            "a multiline-flow secretParameters declaration must still redact on iOS"
        )
    }

    func testSecretsRedactedWhenMultilineFlowKeyContainsQuotedHash() throws {
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

        _ = try executor.execute(testMetadata: nil)

        let request = try XCTUnwrap(captor.captured.first)
        let text = requestText(request)
        XCTAssertFalse(text.contains(secretA), "the quoted-# key's value must be redacted")
        XCTAssertFalse(text.contains(secretB), "the following key must not be dropped, so its value redacts")
    }

    func testSecretsRedactedWhenMultilineFlowKeyContainsEscapedQuoteBeforeBracket() throws {
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

        _ = try executor.execute(testMetadata: nil)

        let request = try XCTUnwrap(captor.captured.first)
        let text = requestText(request)
        XCTAssertFalse(text.contains(secretA), "the escaped-quote key's value must be redacted")
        XCTAssertFalse(text.contains(secretB), "the following key must not be dropped, so its value redacts")
    }

    func testSecretSubstitutedIntoToolNameIsRedacted() throws {
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
            responderFactory: { _ in captor }
        )
        let executor = makeExecutor(client: client, handler: handler)

        _ = try executor.execute(testMetadata: nil)

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
    func testScrubsExactlyWhatTheExecutorSubstitutionProduced() throws {
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

        _ = try executor.execute(testMetadata: nil)

        let request = try XCTUnwrap(captor.captured.first)
        let text = requestText(request)
        XCTAssertFalse(text.contains("sec-"), "the actual substituted secret must be scrubbed")
        // Positive assertions so the test can't pass on an empty/malformed request.
        XCTAssertTrue(text.contains(SecretRedaction.placeholder), "the secret must be replaced by the placeholder")
        XCTAssertTrue(text.contains("observe"), "non-secret plan structure must be preserved")
    }

    /// #6029 review (701): a self-referential secret must not blow up (no fixpoint expansion) and must
    /// still be redacted. The executor's single pass turns `${TOKEN}` into `marker-${TOKEN}` once.
    func testSelfReferentialSecretTerminatesAndIsRedacted() throws {
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

        _ = try executor.execute(testMetadata: nil)

        let request = try XCTUnwrap(captor.captured.first)
        let text = requestText(request)
        XCTAssertFalse(text.contains("marker-"), "the self-referential secret must be redacted")
        XCTAssertTrue(text.contains(SecretRedaction.placeholder), "the secret must be replaced by the placeholder")
        XCTAssertTrue(text.contains("observe"), "non-secret plan structure must be preserved")
    }

    /// #6029 review: a plan may parameterize the declared key name (`secretParameters: [${SECRET_KEY}]`)
    /// — parsed from the raw plan, then the key name resolved against parameters.
    func testParameterizedSecretKeyNameIsRedacted() throws {
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

        _ = try executor.execute(testMetadata: nil)

        let request = try XCTUnwrap(captor.captured.first)
        let text = requestText(request)
        XCTAssertFalse(text.contains(secret), "a parameterized secret key name must resolve and redact")
        XCTAssertTrue(text.contains(SecretRedaction.placeholder), "the secret must be replaced by the placeholder")
        XCTAssertTrue(text.contains("observe"), "non-secret plan structure must be preserved")
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
            responderFactory: { _ in captor }
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
            recoveryConfigProvider: StaticRecoveryConfigProvider(enabled: true, maxToolCalls: 5)
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

/// Direct tests of `PlanMetadataParser`'s `secretParameters:` parsing (#6029). Parity note: these
/// forms must all parse the same set of keys snakeyaml gives the Android runner.
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
}

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

    // A hung model call must fail the recovery attempt (success == false) instead of blocking the
    // XCTest runner forever. Uses a fake bridge so the handler's timeout handling is deterministic —
    // no wall-clock wait, no leaked Task.
    func testHungModelCallFailsRecoveryInsteadOfHanging() {
        let client = RecoveryMCPClient()
        let handler = TachikomaPlanRecoveryHandler(
            mcpClient: client,
            configProvider: StaticRecoveryConfigProvider(enabled: true, maxToolCalls: 5),
            modelConfig: RecoveryModelConfig(provider: .anthropic, modelName: "claude-sonnet-4-20250514"),
            timeoutSeconds: 120,
            timer: FakeTimer(),
            logger: SilentLogger(),
            responderFactory: { _ in NeverReturningModelResponder() },
            asyncBridge: TimeoutAsyncCallBridge(timeoutSeconds: 0.05)
        )

        let outcome = handler.attemptRecovery(makeContext())

        XCTAssertFalse(outcome.success, "a timed-out model call must yield a failed recovery outcome")
        XCTAssertTrue(client.calls.isEmpty, "no device tool calls when the model call times out before returning")
    }

    // The production bridge must actually bound the wait: a hung operation resolves via timeout, not
    // by blocking forever. The op sleeps far longer (5s) than the timeout (0.05s), so the timeout
    // path is deterministic with a huge margin — not flaky.
    func testSemaphoreBridgeTimesOutOnHungOperation() {
        let bridge = SemaphoreAsyncCallBridge()
        let start = Date()
        XCTAssertThrowsError(
            try bridge.run(timeout: 0.05) { () async throws -> Int in
                try await Task.sleep(nanoseconds: 5_000_000_000)
                return 1
            }
        ) { error in
            XCTAssertTrue(error is RecoveryTimeoutError, "expected RecoveryTimeoutError, got \(error)")
        }
        XCTAssertLessThan(Date().timeIntervalSince(start), 2.0, "timeout must return promptly, not block on the op")
    }

    // On timeout the bridge must cancel the spawned task so a cancellation-aware operation unwinds
    // promptly instead of running to completion and retaining its resources.
    func testSemaphoreBridgeCancelsHungTaskOnTimeout() {
        let cancelled = DispatchSemaphore(value: 0)
        let bridge = SemaphoreAsyncCallBridge()
        XCTAssertThrowsError(
            try bridge.run(timeout: 0.05) { () async throws -> Int in
                do {
                    try await Task.sleep(nanoseconds: 5_000_000_000)
                } catch {
                    // `Task.sleep` throws `CancellationError` when the task is cancelled.
                    cancelled.signal()
                    throw error
                }
                return 1
            }
        )
        XCTAssertEqual(
            cancelled.wait(timeout: .now() + 2.0),
            .success,
            "timed-out task must be cancelled so a cancellation-aware operation unwinds promptly"
        )
    }

    func testSemaphoreBridgePassesThroughSuccess() throws {
        let bridge = SemaphoreAsyncCallBridge()
        let value = try bridge.run(timeout: 5) { () async throws -> Int in 42 }
        XCTAssertEqual(value, 42)
    }

    func testSemaphoreBridgeRethrowsOperationError() {
        struct Boom: Error {}
        let bridge = SemaphoreAsyncCallBridge()
        XCTAssertThrowsError(try bridge.run(timeout: 5) { () async throws -> Int in throw Boom() }) { error in
            XCTAssertTrue(error is Boom, "operation errors must propagate, not be swallowed")
        }
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

private final class SpyRecoveryHandler: PlanRecoveryHandler, @unchecked Sendable {
    private let outcome: RecoveryOutcome
    private(set) var receivedContexts: [FailedStepContext] = []

    init(outcome: RecoveryOutcome) {
        self.outcome = outcome
    }

    func attemptRecovery(_ context: FailedStepContext) -> RecoveryOutcome {
        receivedContexts.append(context)
        return outcome
    }
}

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

    func initialize(timeout _: TimeInterval) throws {}

    func callTool(name: String, arguments: [String: Any], timeout _: TimeInterval) throws -> MCPToolResponse {
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

    func readResource(uri _: String, timeout _: TimeInterval) throws -> MCPResourceResponse {
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

/// Fake `ModelResponding` that never returns — models a hung provider call. Paired with a fake
/// bridge in tests so the handler's timeout path is exercised without any real wait.
private final class NeverReturningModelResponder: ModelResponding, @unchecked Sendable {
    func respond(_: ModelRequest) async throws -> ModelResponse {
        // Suspend forever without spinning; the fake bridge times out before this can complete.
        await withCheckedContinuation { (_: CheckedContinuation<Void, Never>) in }
        return StubModelResponder.final()
    }
}

/// Fake `AsyncCallBridging` that always reports a timeout, deterministically and instantly.
private struct TimeoutAsyncCallBridge: AsyncCallBridging {
    let timeoutSeconds: TimeInterval
    func run<T: Sendable>(timeout _: TimeInterval, _: @escaping @Sendable () async throws -> T) throws -> T {
        throw RecoveryTimeoutError(timeoutSeconds: timeoutSeconds)
    }
}

private func planJSON(
    success: Bool,
    executedSteps: Int,
    totalSteps: Int,
    failedStep: [String: Any]? = nil
)
    -> String
{
    var payload: [String: Any] = [
        "success": success,
        "executedSteps": executedSteps,
        "totalSteps": totalSteps,
    ]
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
