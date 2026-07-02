import XCTest
@testable import XCTestRunner

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

    // #2811: this exercises the system Reminders app, whose exact control labels and layout timing
    // vary across iOS versions. `add-reminder.yaml`'s waitFor guards remove the common races and its
    // optional "Not Now" step dismisses the intermittent iCloud alert, but a single retry still
    // absorbs the residual "fails once, passes on a plain re-run" flake this issue documents. An
    // explicit AUTOMOBILE_TEST_RETRY_COUNT always wins; a genuine break still fails on every attempt.
    override var retryCount: Int {
        let base = super.retryCount
        return base > 0 ? base : 1
    }

    func testAddReminderPlan() throws {
        PerfTimer.log("testAddReminderPlan START - planPath: \(planPath)")
        let result = try executePlan()
        PerfTimer.log("testAddReminderPlan END - result: \(result)")
    }
}
