import XCTest
import Tachikoma
@testable import XCTestRunner

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
    ) -> AutoMobilePlanExecutor {
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
    ) -> TachikomaPlanRecoveryHandler {
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

private final class SpyRecoveryHandler: PlanRecoveryHandler {
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

private final class RecoveryMCPClient: AutoMobileMCPClient {
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
private final class StubModelResponder: ModelResponding {
    private var scripted: [ModelResponse]
    private let repeated: ModelResponse?

    init(_ scripted: [ModelResponse]) {
        self.scripted = scripted
        self.repeated = nil
    }

    init(alwaysReturn response: ModelResponse) {
        self.scripted = []
        self.repeated = response
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
            content: [.toolCall(ToolCallItem(id: "call-\(name)", function: FunctionCall(name: name, arguments: arguments)))]
        )
    }

    static func final() -> ModelResponse {
        ModelResponse(id: "resp", content: [.outputText("recovery complete")])
    }
}

private func planJSON(
    success: Bool,
    executedSteps: Int,
    totalSteps: Int,
    failedStep: [String: Any]? = nil
) -> String {
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
