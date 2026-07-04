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

    // #2998: cold Reminders bring-up on a CI simulator intermittently pushes the plan's
    // `observe waitFor "Reminders"` past its 20s bound, timing out during app launch rather than in
    // any code under test. The observe timeout surfaces as a retryable `.executionFailed`, so a single
    // retry re-runs the whole launch→observe→terminate plan and absorbs the transient flake, while a
    // genuine observe regression times out on every attempt and still fails (the launch plan keeps its
    // bounded waitFor — see RemindersPlanContentTests). Mirrors the sibling add-flow retry (#2811). An
    // explicit AUTOMOBILE_TEST_RETRY_COUNT always wins; the retry is tracked for removal once the
    // iOS-observe bring-up flake is fixed (#2910/#2926/#2952).
    override var retryCount: Int {
        // Honor an explicit override — including 0 to disable retries — and default to 1 only when
        // no override is set. (super.retryCount can't distinguish an explicit 0 from the unset
        // default, so read the env directly.)
        let environment = AutoMobileEnvironment()
        if let explicit = environment.intValue(["AUTOMOBILE_TEST_RETRY_COUNT", "RETRY_COUNT"]) {
            return explicit
        }
        return 1
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
    // The retry is tracked for removal once the guards are proven sufficient — see issue #2855.
    override var retryCount: Int {
        // Honor an explicit override — including 0 to disable retries — and default to 1 only when
        // no override is set. (super.retryCount can't distinguish an explicit 0 from the unset
        // default, so read the env directly.)
        let environment = AutoMobileEnvironment()
        if let explicit = environment.intValue(["AUTOMOBILE_TEST_RETRY_COUNT", "RETRY_COUNT"]) {
            return explicit
        }
        return 1
    }

    func testAddReminderPlan() throws {
        PerfTimer.log("testAddReminderPlan START - planPath: \(planPath)")
        let result = try executePlan()
        PerfTimer.log("testAddReminderPlan END - result: \(result)")
    }
}
