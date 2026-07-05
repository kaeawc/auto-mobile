import XCTest
@testable import XCTestRunner

class RemindersIntegrationBase: AutoMobileTestCase {
    var defaultRetryCount: Int {
        return 1
    }

    override var retryCount: Int {
        let environment = AutoMobileEnvironment()
        if let explicit = environment.intValue(["AUTOMOBILE_TEST_RETRY_COUNT", "RETRY_COUNT"]) {
            return explicit
        }
        return defaultRetryCount
    }

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

final class RemindersLaunchPlanTests: RemindersIntegrationBase {
    override var planPath: String {
        return ProcessInfo.processInfo.environment["AUTOMOBILE_TEST_PLAN"]
            ?? ProcessInfo.processInfo.environment["PLAN_PATH"]
            ?? "launch-reminders-app.yaml"
    }

    // #2998: inherits the shared one-retry default to absorb transient cold Reminders bring-up
    // observe timeouts; tracked for removal once #2910/#2926/#2952 fix the underlying flake.

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

    // #2811: inherits the shared one-retry default to absorb residual cross-iOS Reminders UI flakes;
    // tracked for removal once the add-flow guards are proven sufficient in #2855.

    func testAddReminderPlan() throws {
        PerfTimer.log("testAddReminderPlan START - planPath: \(planPath)")
        let result = try executePlan()
        PerfTimer.log("testAddReminderPlan END - result: \(result)")
    }
}
