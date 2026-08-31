import Foundation
import XCTest
@testable import XCTestRunnerRewrite

/// Phase-5: the executor composition root. Drives it end-to-end against a recording fake to lock the
/// frozen executePlan/setToolEnabled argument wire (contract 1c), plus parameter substitution, failure
/// propagation, mixed-platform rejection, the plan-metadata parser, and session identity.
final class Phase5ExecutorBehaviorTests: XCTestCase {
    private func makeExecutor(
        client: RecordingMCPClient,
        plan: String,
        parameters: [String: String] = [:],
        session: String = "fixed-session"
    ) -> AutoMobilePlanExecutor {
        // A custom (non-managed) socket path so the executor's daemon preflight is skipped.
        let config = AutoMobilePlanExecutor.Configuration(
            transport: .daemonUnixSocket(path: "/tmp/custom-not-managed.sock"),
            planPath: "plan.yaml",
            parameters: parameters
        )
        return AutoMobilePlanExecutor(
            configuration: config,
            planLoader: StubPlanLoader(content: plan),
            mcpClient: client,
            timer: SystemTimer(),
            logger: SilentLogger(),
            sessionIdProvider: { session },
            recoveryHandler: nil,
            recoveryConfigProvider: StaticRecoveryConfigProvider(),
            recoveryModelConfig: nil,
            daemonEnsurer: NoopDaemonEnsurer()
        )
    }

    func testExecutePlanArgumentWireContract() throws {
        let client = RecordingMCPClient()
        let plan = "platform: ios\nsteps:\n  - tool: observe\n"
        let executor = makeExecutor(client: client, plan: plan)

        let result = try executor.execute(
            testMetadata: AutoMobilePlanExecutor.TestMetadata(testClass: "MyTests", testMethod: "testFoo")
        )
        XCTAssertTrue(result.success)

        let setTool = client.call(named: "setToolEnabled")
        XCTAssertEqual(setTool?.arguments["toolName"] as? String, "executePlan")
        XCTAssertEqual(setTool?.arguments["sessionUuid"] as? String, "fixed-session")

        let exec = try XCTUnwrap(client.call(named: "executePlan"))
        let planContent = try XCTUnwrap(exec.arguments["planContent"] as? String)
        XCTAssertTrue(planContent.hasPrefix("base64:"))
        let base64 = String(planContent.dropFirst("base64:".count))
        let decoded = String(data: try XCTUnwrap(Data(base64Encoded: base64)), encoding: .utf8)
        XCTAssertEqual(decoded, plan, "planContent is base64 of the exact UTF-8 plan")
        XCTAssertEqual(exec.arguments["platform"] as? String, "ios")
        XCTAssertEqual(exec.arguments["startStep"] as? Int, 0)
        XCTAssertEqual(exec.arguments["sessionUuid"] as? String, "fixed-session")
        let metadata = try XCTUnwrap(exec.arguments["testMetadata"] as? [String: Any])
        XCTAssertEqual(metadata["testClass"] as? String, "MyTests")
        XCTAssertEqual(metadata["testMethod"] as? String, "testFoo")
    }

    func testParameterSubstitutionAppliedBeforeEncoding() throws {
        let client = RecordingMCPClient()
        let plan = "platform: ios\nsteps:\n  - tool: inputText\n    text: ${REMINDER_TITLE}\n"
        let executor = makeExecutor(client: client, plan: plan, parameters: ["REMINDER_TITLE": "Buy milk"])
        _ = try executor.execute()

        let exec = try XCTUnwrap(client.call(named: "executePlan"))
        let base64 = String(try XCTUnwrap(exec.arguments["planContent"] as? String).dropFirst("base64:".count))
        let decoded = String(data: try XCTUnwrap(Data(base64Encoded: base64)), encoding: .utf8) ?? ""
        XCTAssertTrue(decoded.contains("Buy milk"))
        XCTAssertFalse(decoded.contains("${REMINDER_TITLE}"))
    }

    func testFailedStepWithoutRecoveryThrowsExecutionFailed() {
        let client = RecordingMCPClient()
        client.queueExecutePlan(
            "{\"success\":false,\"executedSteps\":1,\"totalSteps\":3,\"failedStep\":{\"stepIndex\":1,\"tool\":\"tapOn\",\"error\":\"element not found\"}}"
        )
        let executor = makeExecutor(client: client, plan: "platform: ios\nsteps:\n  - tool: observe\n")
        XCTAssertThrowsError(try executor.execute()) { error in
            guard let executorError = error as? AutoMobilePlanExecutor.ExecutorError else {
                return XCTFail("expected ExecutorError, got \(error)")
            }
            XCTAssertTrue(executorError.description.contains("tapOn"))
            XCTAssertTrue(executorError.description.contains("step 2"))
        }
    }

    func testMixedPlatformPlanRejected() {
        let plan = """
        devices:
          - label: a
            platform: ios
          - label: b
            platform: android
        steps:
          - tool: observe
        """
        let executor = makeExecutor(client: RecordingMCPClient(), plan: plan)
        XCTAssertThrowsError(try executor.execute()) { error in
            guard let executorError = error as? AutoMobilePlanExecutor.ExecutorError else {
                return XCTFail("expected ExecutorError, got \(error)")
            }
            XCTAssertTrue(executorError.description.contains("mixed platforms"))
        }
    }

    func testPlanMetadataParserExtractsPlatformAndDevices() throws {
        let single = try PlanMetadataParser.parse(from: "platform: ios\nsteps:\n  - tool: observe\n")
        XCTAssertEqual(single.platform, .ios)
        XCTAssertFalse(single.hasDevices)

        let multi = try PlanMetadataParser.parse(from: """
        devices:
          - label: phone
            platform: ios
        steps:
          - tool: observe
        """)
        XCTAssertTrue(multi.hasDevices)
        XCTAssertEqual(multi.deviceLabels, ["phone"])
        XCTAssertEqual(multi.devicePlatforms["phone"], .ios)
    }

    func testAutoMobileSessionOverrideAndRead() {
        AutoMobileSession.setCurrentSessionUuid("session-xyz")
        XCTAssertEqual(AutoMobileSession.currentSessionUuid(), "session-xyz")
    }
}
