import XCTest
@testable import XCTestRunner

private final class LaunchPlanContractMCPClient: AutoMobileMCPClient {
    struct ToolCall {
        let name: String
        let arguments: [String: Any]
        let timeout: TimeInterval
    }

    private(set) var initializeTimeouts: [TimeInterval] = []
    private(set) var toolCalls: [ToolCall] = []

    func initialize(timeout: TimeInterval) throws {
        initializeTimeouts.append(timeout)
    }

    func callTool(name: String, arguments: [String: Any], timeout: TimeInterval) throws -> MCPToolResponse {
        toolCalls.append(ToolCall(name: name, arguments: arguments, timeout: timeout))

        switch name {
        case "setToolCapability":
            return MCPToolResponse(text: #"{"success":true}"#)
        case "executePlan":
            return MCPToolResponse(
                text: #"{"success":true,"executedSteps":3,"totalSteps":3,"platform":"ios"}"#
            )
        default:
            throw MCPClientError.invalidResponse("Unexpected tool call: \(name)")
        }
    }

    func readResource(uri _: String, timeout _: TimeInterval) throws -> MCPResourceResponse {
        throw MCPClientError.invalidResponse("Unexpected resource read")
    }

    func resetSession() {}
}

private struct LaunchPlanContractLogger: AutoMobileLogger {
    func info(_: String) {}
    func warn(_: String) {}
    func error(_: String) {}
}

class RemindersIntegrationBase: AutoMobileTestCase {
    override var planBundle: Bundle? {
        return Bundle.module
    }

    override func setUpAutoMobile() throws {
        PerfTimer.log("setUpAutoMobile START")

        // Skip if no simulator is booted - this is a fast check
        let hasBooted = PerfTimer.measure("SimulatorDetection.hasBootedSimulator") {
            SimulatorDetection.hasBootedSimulator()
        }
        guard hasBooted else {
            throw XCTSkip("No booted simulator found. Boot a simulator first.")
        }

        let daemonResult = PerfTimer.measure("DaemonManager.ensureDaemonRunning") {
            DaemonManager.ensureDaemonRunningResult()
        }
        guard daemonResult.isReady else {
            throw XCTSkip(daemonResult.diagnosticMessage)
        }

        let refreshResult = PerfTimer.measure("DaemonManager.refreshDevicePool") {
            DaemonManager.refreshDevicePool()
        }
        PerfTimer
            .log(
                "refreshDevicePool result: success=\(refreshResult.success), availableDevices=\(refreshResult.availableDevices)"
            )
        guard refreshResult.success, refreshResult.availableDevices > 0 else {
            throw XCTSkip("No devices available in pool after refresh. Boot a simulator first.")
        }

        PerfTimer.log("setUpAutoMobile END")
    }
}

final class RemindersLaunchPlanTests: XCTestCase {
    func testLaunchRemindersPlan() throws {
        let client = LaunchPlanContractMCPClient()
        let executor = try AutoMobilePlanExecutor(
            configuration: AutoMobilePlanExecutor.Configuration(
                transport: .streamableHttp(url: XCTUnwrap(URL(string: "http://localhost/unused"))),
                planPath: "launch-reminders-app.yaml",
                timeoutSeconds: 1,
                planBundle: .module,
                aiAssistance: false
            ),
            mcpClient: client,
            timer: FakeTimer(),
            logger: LaunchPlanContractLogger(),
            sessionIdProvider: { "launch-plan-contract-session" },
            recoveryModelConfig: nil
        )
        let result = try executor.execute(
            testMetadata: AutoMobilePlanExecutor.TestMetadata(
                testClass: "RemindersLaunchPlanTests",
                testMethod: "testLaunchRemindersPlan",
                isCi: true
            )
        )

        XCTAssertTrue(result.success)
        XCTAssertEqual(result.executedSteps, 3)
        XCTAssertEqual(result.totalSteps, 3)
        XCTAssertEqual(result.platform, "ios")
        XCTAssertEqual(client.initializeTimeouts, [1])
        XCTAssertEqual(client.toolCalls.map(\.name), ["setToolCapability", "executePlan"])
        XCTAssertEqual(client.toolCalls.map(\.timeout), [1, 1])

        let executePlanArguments = try XCTUnwrap(client.toolCalls.last?.arguments)
        XCTAssertEqual(executePlanArguments["platform"] as? String, "ios")
        XCTAssertEqual(executePlanArguments["startStep"] as? Int, 0)
        XCTAssertEqual(executePlanArguments["sessionUuid"] as? String, "launch-plan-contract-session")

        let metadata = try XCTUnwrap(executePlanArguments["testMetadata"] as? [String: Any])
        XCTAssertEqual(metadata["testClass"] as? String, "RemindersLaunchPlanTests")
        XCTAssertEqual(metadata["testMethod"] as? String, "testLaunchRemindersPlan")
        XCTAssertEqual(metadata["isCi"] as? Bool, true)

        let sentPlan = try XCTUnwrap(executePlanArguments["planContent"] as? String)
        let bundledPlan = try DefaultPlanLoader().loadPlan(
            at: "launch-reminders-app.yaml",
            bundle: .module
        )
        XCTAssertEqual(sentPlan, "base64:\(Data(bundledPlan.utf8).base64EncodedString())")
    }
}

final class RemindersAddPlanTests: RemindersIntegrationBase {
    override var planPath: String {
        return ProcessInfo.processInfo.environment["AUTOMOBILE_TEST_PLAN"]
            ?? ProcessInfo.processInfo.environment["PLAN_PATH"]
            ?? "add-reminder.yaml"
    }

    override var planParameters: [String: String] {
        return [
            "REMINDER_TITLE": "AutoMobile XCTest demo \(UUID().uuidString)",
        ]
    }

    func testAddReminderPlan() throws {
        PerfTimer.log("testAddReminderPlan START - planPath: \(planPath)")
        let result = try executePlan()
        PerfTimer.log("testAddReminderPlan END - result: \(result)")
    }
}
