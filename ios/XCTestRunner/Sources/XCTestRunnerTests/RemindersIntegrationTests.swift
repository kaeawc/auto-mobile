import XCTest
@testable import XCTestRunner

class RemindersIntegrationBase: AutoMobileTestCase {
    private let executorTimeoutConsumersPerAttempt = 2
    private let workflowStepReservedOverheadSeconds: TimeInterval = 60
    private let workflowStepTimeoutSeconds: TimeInterval = 600

    override var planBundle: Bundle? {
        return Bundle.module
    }

    override var timeoutSeconds: TimeInterval {
        let attempts = retryCount + 1
        guard attempts > 1 else {
            return super.timeoutSeconds
        }

        let retryDelayBudget = TimeInterval(attempts - 1) * retryDelaySeconds
        let remainingStepBudget = workflowStepTimeoutSeconds - workflowStepReservedOverheadSeconds - retryDelayBudget
        let timeoutConsumers = attempts * executorTimeoutConsumersPerAttempt
        let maximumPerAttemptTimeout = max(1, floor(remainingStepBudget / TimeInterval(timeoutConsumers)))
        return min(super.timeoutSeconds, maximumPerAttemptTimeout)
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

final class RemindersLaunchPlanTests: RemindersIntegrationBase {
    override var planPath: String {
        return ProcessInfo.processInfo.environment["AUTOMOBILE_TEST_PLAN"]
            ?? ProcessInfo.processInfo.environment["PLAN_PATH"]
            ?? "launch-reminders-app.yaml"
    }

    func testLaunchRemindersPlan() throws {
        PerfTimer.log("testLaunchRemindersPlan START - planPath: \(planPath)")
        let result = try executePlan()
        PerfTimer.log("testLaunchRemindersPlan END - result: \(result)")
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
            "REMINDER_TITLE": "AutoMobile XCTest demo \(UUID().uuidString)"
        ]
    }

    func testAddReminderPlan() throws {
        if ProcessInfo.processInfo.environment["AUTOMOBILE_REMINDERS_LAUNCH_ONLY"] == "1" {
            throw XCTSkip("Skipping add-reminder plan during launch-only fallback run.")
        }
        PerfTimer.log("testAddReminderPlan START - planPath: \(planPath)")
        let result = try executePlan()
        PerfTimer.log("testAddReminderPlan END - result: \(result)")
    }
}
