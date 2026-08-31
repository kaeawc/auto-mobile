import Foundation
import Tachikoma
import XCTest
// Only the rewrite is imported here (so protocol names are unambiguous); the fakes conform to the
// rewrite's Sendable seams. @testable reaches the internal designated init + AsyncCallBridging.
@testable import XCTestRunnerRewrite

final class Phase4RecoveryBehaviorTests: XCTestCase {
    func testRecoveryUnavailableWithoutModelConfig() {
        let client = RecordingMCPClient()
        let handler = TachikomaPlanRecoveryHandler(
            mcpClient: client,
            configProvider: StaticRecoveryConfigProvider(),
            modelConfig: nil,
            timeoutSeconds: 5,
            timer: SystemTimer(),
            logger: SilentLogger()
        )
        let outcome = handler.attemptRecovery(makeContext())
        XCTAssertFalse(outcome.success)
        XCTAssertTrue(client.calls.isEmpty, "no model config → no model call, no tools")
    }

    func testRecoveryHappyPathExecutesToolsWithInjectedRoutingAndVerifies() {
        let client = RecordingMCPClient()
        let responder = StubModelResponder([
            StubModelResponder.toolCall(name: "observe"),
            StubModelResponder.toolCall(name: "tapOn", arguments: "{\"selector\":{\"text\":\"OK\"}}"),
            StubModelResponder.final(),
        ])
        let handler = TachikomaPlanRecoveryHandler(
            mcpClient: client,
            configProvider: StaticRecoveryConfigProvider(enabled: true, maxToolCalls: 5),
            modelConfig: RecoveryModelConfig(provider: .anthropic, modelName: "m"),
            timeoutSeconds: 5,
            timer: SystemTimer(),
            logger: SilentLogger(),
            responderFactory: { _ in responder }
        )

        let outcome = handler.attemptRecovery(makeContext(platform: "ios", sessionUuid: "s1"))

        XCTAssertTrue(outcome.success)
        XCTAssertNotNil(outcome.observeResultAfterRecovery, "post-recovery observe verifies device state")
        let tapOn = client.calls.first { $0.name == "tapOn" }
        XCTAssertEqual(tapOn?.arguments["platform"] as? String, "ios", "routing platform injected, not trusted from model")
        XCTAssertEqual(tapOn?.arguments["sessionUuid"] as? String, "s1")
        XCTAssertEqual(tapOn?.arguments["action"] as? String, "tap", "tapOn default action injected")
    }

    func testRecoveryTimeoutReturnsFailure() {
        let handler = TachikomaPlanRecoveryHandler(
            mcpClient: RecordingMCPClient(),
            configProvider: StaticRecoveryConfigProvider(),
            modelConfig: RecoveryModelConfig(provider: .anthropic, modelName: "m"),
            timeoutSeconds: 5,
            timer: SystemTimer(),
            logger: SilentLogger(),
            responderFactory: { _ in StubModelResponder([]) },
            asyncBridge: TimeoutAsyncCallBridge(timeoutSeconds: 5)
        )
        let outcome = handler.attemptRecovery(makeContext())
        XCTAssertFalse(outcome.success, "a hung/timed-out model call fails the recovery attempt")
    }

    func testConfigProviderMemoizesSingleRead() {
        let client = RecordingMCPClient()
        let provider = DaemonRecoveryConfigProvider(
            clientProvider: { client },
            timeoutSeconds: 5,
            logger: SilentLogger()
        )
        XCTAssertTrue(provider.isRecoveryEnabled())
        XCTAssertEqual(provider.maxRecoveryToolCalls(), 5)
        _ = provider.isRecoveryEnabled()
        XCTAssertEqual(client.readResourceCallCount, 1, "flag read is memoized (race #4 fix)")
        XCTAssertEqual(client.initializeCallCount, 1)
    }

    // MARK: - Helpers

    private func makeContext(platform: String = "ios", sessionUuid: String? = "s1") -> FailedStepContext {
        FailedStepContext(
            failedStepIndex: 1,
            failedTool: "tapOn",
            error: "element not found",
            succeededSteps: [SucceededStepSummary(stepIndex: 0, tool: "launchApp")],
            planContent: "steps:\n  - tool: launchApp\n  - tool: tapOn\n",
            platform: platform,
            sessionUuid: sessionUuid,
            deviceId: nil,
            failureObservation: nil
        )
    }
}

// MARK: - Recovery-specific fakes (shared fakes live in RewriteFakes.swift)

/// Fake `ModelResponding` replaying a fixed script (from the reference RecoveryTests).
private final class StubModelResponder: ModelResponding, @unchecked Sendable {
    private var scripted: [ModelResponse]

    init(_ scripted: [ModelResponse]) {
        self.scripted = scripted
    }

    func respond(_: ModelRequest) async throws -> ModelResponse {
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

/// Fake `AsyncCallBridging` that reports a timeout instantly (matches the rewrite's `.v6` signature:
/// `T: Sendable`, `@escaping @Sendable`).
private struct TimeoutAsyncCallBridge: AsyncCallBridging {
    let timeoutSeconds: TimeInterval
    func run<T: Sendable>(timeout _: TimeInterval, _: @escaping @Sendable () async throws -> T) throws -> T {
        throw RecoveryTimeoutError(timeoutSeconds: timeoutSeconds)
    }
}
