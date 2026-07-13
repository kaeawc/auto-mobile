import XCTest
@testable import XCTestRunner

/// Structural (no-simulator) guards for the bundled `add-reminder.yaml` plan.
///
/// `RemindersAddPlanTests.testAddReminderPlan` was flaky because the plan typed/saved immediately
/// after tapping `New Reminder`; on a slow simulator the quick-entry sheet or save control may not be
/// ready yet (issue #2811/#3028). These tests encode the determinism invariant — the title field and
/// save tap must be guarded by preceding `observe`/`waitFor` steps — so the plan can't silently
/// regress back to racy bare actions.
///
/// They parse the real bundled resource (not a fixture) and need no booted simulator or daemon,
/// so they run in the plain `swift test` macOS suite.
final class RemindersPlanContentTests: XCTestCase {
    private func loadAddReminderPlan() throws -> String {
        return try DefaultPlanLoader().loadPlan(at: "add-reminder.yaml", bundle: Bundle.module)
    }

    private func loadLaunchRemindersPlan() throws -> String {
        return try DefaultPlanLoader().loadPlan(at: "launch-reminders-app.yaml", bundle: Bundle.module)
    }

    /// The save tap must be immediately preceded by an `observe`/`waitFor` guard on "Add", so the
    /// executor polls for the control (and its `awaitTimeout` path fails fast on genuine absence)
    /// instead of racing a bare tap.
    func testAddReminderPlanWaitsForAddBeforeTappingIt() throws {
        let steps = try PlanStepSequence.parse(loadAddReminderPlan())

        guard let saveTapIndex = steps.firstIndex(where: { $0.tool == "tapOn" && $0.mentions("Add") }) else {
            XCTFail("Plan is missing the tapOn \"Add\" save step")
            return
        }

        XCTAssertGreaterThan(
            saveTapIndex,
            0,
            "The tapOn \"Add\" step cannot be the first step; it must follow a wait guard"
        )

        let guardStep = steps[saveTapIndex - 1]
        XCTAssertEqual(
            guardStep.tool,
            "observe",
            "The step before tapOn \"Add\" must be an observe guard, was \(guardStep.tool)"
        )
        XCTAssertTrue(
            guardStep.hasWaitFor,
            "The observe step guarding the \"Add\" tap must use waitFor"
        )
        XCTAssertTrue(
            guardStep.mentions("Add"),
            "The waitFor guard before the \"Add\" tap must target \"Add\""
        )
    }

    /// The save flow must tolerate Reminders' observed iOS-version label variants. iOS 18.6 showed
    /// "Add", while CI's original iOS 26 image showed "Done"; the plan should wait for and tap whichever
    /// save control is actually present rather than pinning itself to one label.
    func testAddReminderPlanWaitsForAndTapsAddOrDoneSaveControl() throws {
        let steps = try PlanStepSequence.parse(loadAddReminderPlan())

        guard let saveTapIndex = steps.firstIndex(where: { $0.tool == "tapOn" && $0.mentionsAll(["Add", "Done"]) }) else {
            XCTFail("Plan is missing a tapOn save step that accepts both \"Add\" and \"Done\"")
            return
        }

        XCTAssertGreaterThan(saveTapIndex, 0)
        let guardStep = steps[saveTapIndex - 1]
        XCTAssertEqual(guardStep.tool, "observe", "The variant save tap must follow an observe guard")
        XCTAssertTrue(guardStep.hasWaitFor, "The variant save guard must use waitFor")
        XCTAssertTrue(
            guardStep.mentionsAll(["Add", "Done"]),
            "The save waitFor guard must accept both \"Add\" and \"Done\" labels"
        )
    }

    /// A successful save needs an observable signal after the tap. The title must be unique per test run
    /// so a stale reminder from a previous attempt cannot satisfy the post-save verification.
    func testAddReminderPlanUsesUniqueTitleAndVerifiesSavedReminder() throws {
        let steps = try PlanStepSequence.parse(loadAddReminderPlan())
        let content = try loadAddReminderPlan()
        let integrationSource = try loadRemindersIntegrationTestSource()

        XCTAssertTrue(
            content.contains("${REMINDER_TITLE}"),
            "The plan must type a substituted reminder title so post-save verification cannot pass on stale data"
        )
        XCTAssertTrue(
            classBody(named: "RemindersAddPlanTests", in: integrationSource).contains("\"REMINDER_TITLE\""),
            "RemindersAddPlanTests must provide the title parameter used by add-reminder.yaml"
        )

        guard let inputIndex = steps.firstIndex(where: { $0.tool == "inputText" && $0.mentions("${REMINDER_TITLE}") }) else {
            XCTFail("Plan must type ${REMINDER_TITLE}")
            return
        }
        guard let saveIndex = steps.firstIndex(where: { $0.tool == "tapOn" && $0.mentionsAll(["Add", "Done"]) }) else {
            XCTFail("Plan must save the reminder after typing ${REMINDER_TITLE}")
            return
        }
        guard let verificationIndex = steps.firstIndex(where: {
            $0.tool == "observe" && $0.hasWaitFor && $0.mentions("${REMINDER_TITLE}")
        }) else {
            XCTFail("Plan must verify the saved reminder by observing ${REMINDER_TITLE}")
            return
        }

        XCTAssertGreaterThan(
            saveIndex,
            inputIndex,
            "The save step must run after typing the title"
        )
        XCTAssertGreaterThan(
            verificationIndex,
            saveIndex,
            "Saved-reminder verification must run after saving the title"
        )
    }

    /// The guard must be bounded so a genuinely-absent control fails fast instead of hanging for the
    /// whole plan timeout.
    func testAddWaitGuardHasBoundedTimeout() throws {
        let steps = try PlanStepSequence.parse(loadAddReminderPlan())

        guard let saveTapIndex = steps.firstIndex(where: { $0.tool == "tapOn" && $0.mentions("Add") }),
              saveTapIndex > 0
        else {
            XCTFail("Plan is missing a guarded tapOn \"Add\" step")
            return
        }

        let guardStep = steps[saveTapIndex - 1]
        guard let timeout = guardStep.waitForTimeoutMs else {
            XCTFail("The waitFor guard before the \"Add\" tap must declare a timeout")
            return
        }
        XCTAssertGreaterThan(timeout, 0, "waitFor timeout must be positive")
        XCTAssertLessThanOrEqual(
            timeout,
            30000,
            "waitFor timeout should stay bounded so genuine failures don't hang the plan"
        )
    }

    /// The title field must be visible/focused before `inputText`; otherwise text entry can run while
    /// the quick-entry sheet is still animating and leave no save control to wait for.
    func testAddReminderPlanWaitsForTitleFieldBeforeTyping() throws {
        let steps = try PlanStepSequence.parse(loadAddReminderPlan())

        guard let inputIndex = steps.firstIndex(where: { $0.tool == "inputText" }) else {
            XCTFail("Plan is missing the inputText title step")
            return
        }
        XCTAssertGreaterThan(inputIndex, 0)
        let guardStep = steps[inputIndex - 1]
        XCTAssertEqual(guardStep.tool, "observe", "The title input must follow an observe guard")
        XCTAssertTrue(guardStep.hasWaitFor, "The title input guard must use waitFor")
        XCTAssertTrue(guardStep.mentions("Title"), "The title input guard must target the Title field")
    }

    /// Reminders tests default to single-attempt plans for local runs, but CI can opt into a bounded
    /// retry for known cold-runner flakes through `AUTOMOBILE_TEST_RETRY_COUNT`.
    func testRemindersPlansDefaultToZeroRetries() {
        // An explicit env override legitimately wins, so only assert the default when unset.
        let env = ProcessInfo.processInfo.environment
        if env["AUTOMOBILE_TEST_RETRY_COUNT"] != nil || env["RETRY_COUNT"] != nil {
            return
        }
        XCTAssertEqual(RemindersLaunchPlanTests().retryCount, 0)
        XCTAssertEqual(RemindersAddPlanTests().retryCount, 0)
    }

    /// An explicit retry override wins — including 0 to disable retries for CI/local repro runs.
    func testExplicitRetryOverrideIsStillHonored() {
        let key = "AUTOMOBILE_TEST_RETRY_COUNT"
        let original = ProcessInfo.processInfo.environment[key]
        setenv(key, "0", 1)
        defer {
            if let original = original {
                setenv(key, original, 1)
            } else {
                unsetenv(key)
            }
        }

        XCTAssertEqual(RemindersLaunchPlanTests().retryCount, 0)
        XCTAssertEqual(RemindersAddPlanTests().retryCount, 0)

        setenv(key, "3", 1)
        XCTAssertEqual(RemindersLaunchPlanTests().retryCount, 3)
        XCTAssertEqual(RemindersAddPlanTests().retryCount, 3)
    }

    /// If Reminders retries are explicitly re-enabled, each attempt must be capped so the whole
    /// attempt budget still fits under the 10-minute GitHub Actions step.
    func testExplicitRemindersRetryTimeoutFitsWorkflowStepCap() {
        let retryKey = "AUTOMOBILE_TEST_RETRY_COUNT"
        let timeoutKey = "AUTOMOBILE_TEST_TIMEOUT_SECONDS"
        let originalRetry = ProcessInfo.processInfo.environment[retryKey]
        let originalTimeout = ProcessInfo.processInfo.environment[timeoutKey]
        setenv(retryKey, "1", 1)
        setenv(timeoutKey, "300", 1)
        defer {
            restoreEnvironmentValue(originalRetry, for: retryKey)
            restoreEnvironmentValue(originalTimeout, for: timeoutKey)
        }

        assertRemindersTimeoutFitsWorkflowStepCap(RemindersLaunchPlanTests(), expectedTimeoutSeconds: 134)
        assertRemindersTimeoutFitsWorkflowStepCap(RemindersAddPlanTests(), expectedTimeoutSeconds: 134)
    }

    func testExplicitLowerRemindersTimeoutIsPreserved() {
        let retryKey = "AUTOMOBILE_TEST_RETRY_COUNT"
        let timeoutKey = "AUTOMOBILE_TEST_TIMEOUT_SECONDS"
        let originalRetry = ProcessInfo.processInfo.environment[retryKey]
        let originalTimeout = ProcessInfo.processInfo.environment[timeoutKey]
        setenv(retryKey, "1", 1)
        setenv(timeoutKey, "120", 1)
        defer {
            restoreEnvironmentValue(originalRetry, for: retryKey)
            restoreEnvironmentValue(originalTimeout, for: timeoutKey)
        }

        XCTAssertEqual(RemindersLaunchPlanTests().timeoutSeconds, 120)
        XCTAssertEqual(RemindersAddPlanTests().timeoutSeconds, 120)
    }

    /// CI enables Reminders retries through workflow env, not a test-class override. The integration
    /// base should only own simulator/daemon readiness; retry behavior comes from `AutoMobileTestCase`.
    func testRemindersIntegrationBaseDoesNotOverrideRetryCount() throws {
        let source = try loadRemindersIntegrationTestSource()

        XCTAssertFalse(classBody(named: "RemindersIntegrationBase", in: source).contains("override var retryCount"))
        XCTAssertFalse(classBody(named: "RemindersIntegrationBase", in: source).contains("var defaultRetryCount"))
        XCTAssertFalse(
            classBody(named: "RemindersLaunchPlanTests", in: source).contains("override var retryCount"),
            "RemindersLaunchPlanTests should inherit AutoMobileTestCase retry behavior"
        )
        XCTAssertFalse(
            classBody(named: "RemindersAddPlanTests", in: source).contains("override var retryCount"),
            "RemindersAddPlanTests should inherit AutoMobileTestCase retry behavior"
        )
    }

    /// The CI job must warm Reminders itself before the single-attempt timed plan. Warming only
    /// CtrlProxy still leaves the first target-app launch/observe on the clock.
    func testPullRequestWorkflowWarmsTargetAppBeforeRemindersRuns() throws {
        let workflow = try loadRepositoryFile(".github/workflows/pull_request.yml")

        assertWorkflowUsesLocalCtrlProxyBuildForRemindersRun(workflow)
        assertWorkflowWarmsTargetAppBeforeRemindersRun(
            workflow,
            warmupStepName: "Warm up Reminders target app (Xcode 26.2)",
            runStepName: "Run Reminders integration tests (Xcode 26.2)"
        )
        assertWorkflowWarmsTargetAppBeforeRemindersRun(
            workflow,
            warmupStepName: "Warm up Reminders target app (Xcode 26.5)",
            runStepName: "Run Reminders integration tests (Xcode 26.5)"
        )
    }

    func testPullRequestWorkflowRetriesRemindersRunsOnce() throws {
        let workflow = try loadRepositoryFile(".github/workflows/pull_request.yml")

        assertWorkflowRetriesRemindersRunOnce(
            workflow,
            runStepName: "Run Reminders integration tests (Xcode 26.2)"
        )
        assertWorkflowRetriesRemindersRunOnce(
            workflow,
            runStepName: "Run Reminders integration tests (Xcode 26.5)"
        )
        assertWorkflowRunsGuardedRemindersTest(
            workflow,
            runStepName: "Run Reminders integration tests (Xcode 26.2)"
        )
        assertWorkflowRunsGuardedRemindersTest(
            workflow,
            runStepName: "Run Reminders integration tests (Xcode 26.5)"
        )
    }

    func testPullRequestWorkflowRunsSecondRemindersLegAfterFirstLegFailureUnlessCancelled() throws {
        let workflow = try loadRepositoryFile(".github/workflows/pull_request.yml")

        assertWorkflowStepRunsWhenNotCancelled(
            workflow,
            stepName: "Select Xcode 26.5",
            afterStepName: "Run Reminders integration tests (Xcode 26.2)"
        )
        assertWorkflowStepRunsWhenNotCancelled(
            workflow,
            stepName: "Ensure iOS Simulator runtime (Xcode 26.5)",
            afterStepName: "Run Reminders integration tests (Xcode 26.2)"
        )
        assertWorkflowStepRunsWhenNotCancelled(
            workflow,
            stepName: "Boot iOS Simulator (Xcode 26.5)",
            afterStepName: "Run Reminders integration tests (Xcode 26.2)"
        )
        assertWorkflowStepRunsWhenNotCancelled(
            workflow,
            stepName: "Ensure AutoMobile daemon ready (Xcode 26.5)",
            afterStepName: "Run Reminders integration tests (Xcode 26.2)"
        )
        assertWorkflowStepRunsWhenNotCancelled(
            workflow,
            stepName: "Warm up iOS CtrlProxy (Xcode 26.5)",
            afterStepName: "Run Reminders integration tests (Xcode 26.2)"
        )
        assertWorkflowStepRunsWhenNotCancelled(
            workflow,
            stepName: "Warm up Reminders target app (Xcode 26.5)",
            afterStepName: "Run Reminders integration tests (Xcode 26.2)"
        )
        assertWorkflowStepRunsWhenNotCancelled(
            workflow,
            stepName: "Run Reminders integration tests (Xcode 26.5)",
            afterStepName: "Run Reminders integration tests (Xcode 26.2)"
        )
    }

    func testNightlyWorkflowWarmsTargetAppBeforeRemindersRuns() throws {
        let workflow = try loadRepositoryFile(".github/workflows/nightly.yml")

        assertWorkflowWarmsTargetAppBeforeRemindersRun(
            workflow,
            warmupStepName: "Warm up Reminders target app (Xcode 26.2)",
            runStepName: "Run Reminders integration tests (Xcode 26.2)"
        )
        assertWorkflowWarmsTargetAppBeforeRemindersRun(
            workflow,
            warmupStepName: "Warm up Reminders target app (Xcode 26.5)",
            runStepName: "Run Reminders integration tests (Xcode 26.5)"
        )
    }

    func testNightlyWorkflowRetriesRemindersRunsOnce() throws {
        let workflow = try loadRepositoryFile(".github/workflows/nightly.yml")

        assertWorkflowRetriesRemindersRunOnce(
            workflow,
            runStepName: "Run Reminders integration tests (Xcode 26.2)"
        )
        assertWorkflowRetriesRemindersRunOnce(
            workflow,
            runStepName: "Run Reminders integration tests (Xcode 26.5)"
        )
        assertWorkflowRunsGuardedRemindersTest(
            workflow,
            runStepName: "Run Reminders integration tests (Xcode 26.2)"
        )
        assertWorkflowRunsGuardedRemindersTest(
            workflow,
            runStepName: "Run Reminders integration tests (Xcode 26.5)"
        )
    }

    func testNightlyWorkflowRunsSecondRemindersLegAfterFirstLegFailureUnlessCancelled() throws {
        let workflow = try loadRepositoryFile(".github/workflows/nightly.yml")

        assertWorkflowStepRunsWhenNotCancelled(
            workflow,
            stepName: "Select Xcode 26.5",
            afterStepName: "Run Reminders integration tests (Xcode 26.2)"
        )
        assertWorkflowStepRunsWhenNotCancelled(
            workflow,
            stepName: "Ensure iOS Simulator runtime (Xcode 26.5)",
            afterStepName: "Run Reminders integration tests (Xcode 26.2)"
        )
        assertWorkflowStepRunsWhenNotCancelled(
            workflow,
            stepName: "Boot iOS Simulator (Xcode 26.5)",
            afterStepName: "Run Reminders integration tests (Xcode 26.2)"
        )
        assertWorkflowStepRunsWhenNotCancelled(
            workflow,
            stepName: "Ensure AutoMobile daemon ready (Xcode 26.5)",
            afterStepName: "Run Reminders integration tests (Xcode 26.2)"
        )
        assertWorkflowStepRunsWhenNotCancelled(
            workflow,
            stepName: "Warm up iOS CtrlProxy (Xcode 26.5)",
            afterStepName: "Run Reminders integration tests (Xcode 26.2)"
        )
        assertWorkflowStepRunsWhenNotCancelled(
            workflow,
            stepName: "Warm up Reminders target app (Xcode 26.5)",
            afterStepName: "Run Reminders integration tests (Xcode 26.2)"
        )
        assertWorkflowStepRunsWhenNotCancelled(
            workflow,
            stepName: "Run Reminders integration tests (Xcode 26.5)",
            afterStepName: "Run Reminders integration tests (Xcode 26.2)"
        )
    }

    /// PR integration runs build CtrlProxy locally before daemon startup. The daemon must use that
    /// derived-data build instead of attempting a release IPA download for the package version under
    /// test; otherwise source-only PRs can fail when no matching release artifact exists yet.
    func testPullRequestWorkflowUsesLocalCtrlProxyBuildForRemindersRun() throws {
        let workflow = try loadRepositoryFile(".github/workflows/pull_request.yml")

        assertWorkflowUsesLocalCtrlProxyBuildForRemindersRun(workflow)
    }

    /// Regression guard preserving the flake-vs-regression distinction: warm-up handles target-app
    /// bring-up before the plan, but the plan must keep its bounded `observe`/`waitFor` guard so a
    /// genuinely broken observe still fails instead of hanging or silently passing.
    func testLaunchRemindersPlanIsGuardedAndBounded() throws {
        let content = try loadLaunchRemindersPlan()
        let steps = PlanStepSequence.parse(content)

        XCTAssertTrue(content.contains("platform: ios"), "Plan must declare the ios platform")
        XCTAssertEqual(steps.first?.tool, "launchApp", "Plan must launch Reminders first")
        XCTAssertEqual(steps.last?.tool, "terminateApp", "Plan must terminate Reminders last")

        guard let observeIndex = steps.firstIndex(where: { $0.tool == "observe" }) else {
            XCTFail("Plan must gate bring-up on an observe step")
            return
        }
        let observeStep = steps[observeIndex]
        XCTAssertGreaterThan(observeIndex, 0, "The observe guard must follow the launch")
        XCTAssertTrue(observeStep.hasWaitFor, "The observe guard must use waitFor")

        guard let timeout = observeStep.waitForTimeoutMs else {
            XCTFail("The observe waitFor guard must declare a timeout so a real regression fails fast")
            return
        }
        XCTAssertGreaterThan(timeout, 0, "waitFor timeout must be positive")
        XCTAssertLessThanOrEqual(
            timeout,
            30000,
            "waitFor timeout should stay bounded so a genuinely-broken observe fails fast per attempt"
        )
    }

    /// The intermittent "Enable iCloud Syncing?" alert must be dismissed best-effort before the
    /// create step, and the create tap must itself be guarded by a wait. The dismissal has to be
    /// `optional` so runs where the alert never appears don't fail.
    func testDismissesICloudAlertBestEffortBeforeCreating() throws {
        let steps = try PlanStepSequence.parse(loadAddReminderPlan())

        guard let createTapIndex = steps.firstIndex(where: {
            $0.tool == "tapOn" && $0.mentions("New Reminder")
        }) else {
            XCTFail("Plan is missing the tapOn \"New Reminder\" step")
            return
        }

        // A best-effort dismissal of the iCloud alert button precedes the create tap.
        let dismissIndex = steps.firstIndex {
            $0.tool == "tapOn" && $0.mentions("Not Now") && $0.mentions("Close")
        }
        guard let dismissIndex = dismissIndex else {
            XCTFail("Plan must dismiss the iCloud alert via a tapOn textAny step covering \"Not Now\" and \"Close\"")
            return
        }
        XCTAssertLessThan(dismissIndex, createTapIndex, "The alert dismissal must precede creating a reminder")
        XCTAssertTrue(
            steps[dismissIndex].isOptional,
            "The iCloud alert dismissal must be optional so alert-absent runs don't fail"
        )

        // Any waitFor guarding the (intermittent) alert must also be optional for the same reason.
        for index in 0 ..< dismissIndex where steps[index].tool == "observe" && steps[index].mentions("Not Now") {
            XCTAssertTrue(
                steps[index].isOptional,
                "A waitFor guarding the intermittent alert must be optional"
            )
            XCTAssertTrue(
                steps[index].mentions("Close"),
                "The iCloud alert wait must cover the observed \"Close\" variant"
            )
        }

        // The create tap is guarded by a preceding observe waitFor on the same control.
        XCTAssertGreaterThan(createTapIndex, 0)
        let createGuard = steps[createTapIndex - 1]
        XCTAssertEqual(createGuard.tool, "observe", "The tapOn \"New Reminder\" must follow an observe guard")
        XCTAssertTrue(createGuard.hasWaitFor && createGuard.mentions("New Reminder"))
    }

    /// A cold launch can restore inside Today or another list. The plan should optionally back out
    /// before selecting the default Reminders list so local state does not decide the flow.
    func testReturnsToAccountsHomeBeforeOpeningDefaultListWhenRestoredInsideAList() throws {
        let steps = try PlanStepSequence.parse(loadAddReminderPlan())

        guard let openListIndex = steps.firstIndex(where: {
            $0.tool == "tapOn" && $0.mentions("Reminders, 0 reminders")
        }) else {
            XCTFail("Plan must open the default Reminders list")
            return
        }

        guard let backIndex = steps.firstIndex(where: {
            $0.tool == "tapOn" && $0.mentions("Back")
        }) else {
            XCTFail("Plan must optionally return from a restored list before choosing the default list")
            return
        }

        XCTAssertLessThan(backIndex, openListIndex, "The restored-list back step must precede default-list selection")
        XCTAssertTrue(steps[backIndex].isOptional, "The restored-list back step must be optional")

        XCTAssertGreaterThan(backIndex, 0)
        let backGuard = steps[backIndex - 1]
        XCTAssertEqual(backGuard.tool, "observe", "The restored-list back tap must follow an observe guard")
        XCTAssertTrue(backGuard.hasWaitFor && backGuard.mentions("Back"))
        XCTAssertTrue(backGuard.isOptional, "The restored-list back wait must be optional")
    }

    /// Reminders can open on the accounts home screen instead of the default list. In that state,
    /// the "New Reminder" toolbar item is absent until the default Reminders list is opened.
    func testOpensDefaultRemindersListBeforeCreatingWhenOnAccountsHome() throws {
        let steps = try PlanStepSequence.parse(loadAddReminderPlan())

        guard let createTapIndex = steps.firstIndex(where: {
            $0.tool == "tapOn" && $0.mentions("New Reminder")
        }) else {
            XCTFail("Plan is missing the tapOn \"New Reminder\" step")
            return
        }

        guard let openListIndex = steps.firstIndex(where: {
            $0.tool == "tapOn" && $0.mentions("Reminders, 0 reminders") && $0.mentions("Reminders,")
        }) else {
            XCTFail("Plan must open the default Reminders list when Reminders starts on accounts home")
            return
        }

        XCTAssertLessThan(openListIndex, createTapIndex, "The default list hop must precede creating a reminder")
        XCTAssertTrue(
            steps[openListIndex].isOptional,
            "The default list hop must be optional so already-in-list runs don't fail"
        )

        XCTAssertGreaterThan(openListIndex, 0)
        let listGuard = steps[openListIndex - 1]
        XCTAssertEqual(listGuard.tool, "observe", "The default list tap must follow an observe guard")
        XCTAssertTrue(
            listGuard.hasWaitFor && listGuard.mentions("Reminders, 0 reminders") && listGuard.mentions("Reminders,"),
            "The default list tap must be guarded by a waitFor on the same row"
        )
        XCTAssertTrue(
            listGuard.isOptional,
            "The default list wait must be optional so already-in-list runs don't fail"
        )
    }

    /// Location permission prompts can appear after entering the list and cover the create control.
    /// The dismissal must be optional because privacy state differs across simulators.
    func testDismissesLocationAlertBestEffortBeforeCreating() throws {
        let steps = try PlanStepSequence.parse(loadAddReminderPlan())

        guard let createTapIndex = steps.firstIndex(where: {
            $0.tool == "tapOn" && $0.mentions("New Reminder")
        }) else {
            XCTFail("Plan is missing the tapOn \"New Reminder\" step")
            return
        }

        guard let dismissIndex = steps.firstIndex(where: {
            $0.tool == "tapOn" && $0.mentions("Don’t Allow")
        }) else {
            XCTFail("Plan must dismiss the location permission alert via a tapOn \"Don’t Allow\" step")
            return
        }

        XCTAssertLessThan(dismissIndex, createTapIndex, "The location alert dismissal must precede creating a reminder")
        XCTAssertTrue(
            steps[dismissIndex].isOptional,
            "The \"Don’t Allow\" dismissal must be optional so alert-absent runs don't fail"
        )

        XCTAssertGreaterThan(dismissIndex, 0)
        let alertGuard = steps[dismissIndex - 1]
        XCTAssertEqual(alertGuard.tool, "observe", "The location alert tap must follow an observe guard")
        XCTAssertTrue(
            alertGuard.hasWaitFor && alertGuard.mentions("Don’t Allow"),
            "The location alert tap must be guarded by a waitFor on the same control"
        )
        XCTAssertTrue(
            alertGuard.isOptional,
            "The location alert wait must be optional so alert-absent runs don't fail"
        )
    }

    /// Regression guard: the determinism fix must not break the surrounding flow — the plan still
    /// launches Reminders first, terminates it last, and keeps the create/type steps in order.
    func testAddReminderPlanKeepsValidIosFlow() throws {
        let content = try loadAddReminderPlan()
        let steps = PlanStepSequence.parse(content)

        XCTAssertTrue(
            content.contains("platform: ios"),
            "Plan must still declare the ios platform"
        )
        XCTAssertEqual(steps.first?.tool, "launchApp", "Plan must launch Reminders first")
        XCTAssertEqual(steps.last?.tool, "terminateApp", "Plan must terminate Reminders last")

        let toolOrder = steps.map { $0.tool }
        let createIndex = steps.firstIndex { $0.tool == "tapOn" && $0.mentions("New Reminder") }
        let typeIndex = toolOrder.firstIndex(of: "inputText")
        let saveIndex = steps.firstIndex { $0.tool == "tapOn" && $0.mentions("Add") }

        XCTAssertNotNil(createIndex, "Plan must still focus a new reminder")
        XCTAssertNotNil(typeIndex, "Plan must still type the reminder title")
        XCTAssertNotNil(saveIndex, "Plan must still save via the \"Add\" control")
        if let createIndex = createIndex, let typeIndex = typeIndex, let saveIndex = saveIndex {
            XCTAssertLessThan(createIndex, typeIndex, "Reminder must be focused before typing")
            XCTAssertLessThan(typeIndex, saveIndex, "Title must be typed before saving")
        }
    }
}

/// A single parsed plan step: its tool and a flattened view of its property block, enough to assert
/// ordering and the wait-before-tap invariant without pulling in a YAML dependency.
private struct PlanStep {
    let tool: String
    let bodyLines: [String]

    var body: String {
        bodyLines.joined(separator: "\n")
    }

    var hasWaitFor: Bool {
        bodyLines.contains { $0.trimmingCharacters(in: .whitespaces).hasPrefix("waitFor:") }
    }

    /// True when the step declares `optional: true` (best-effort; failure does not abort the plan).
    var isOptional: Bool {
        bodyLines.contains { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("optional:") else {
                return false
            }
            return trimmed.dropFirst("optional:".count).trimmingCharacters(in: .whitespaces) == "true"
        }
    }

    func mentions(_ needle: String) -> Bool {
        body.contains("\"\(needle)\"") || body.contains(needle)
    }

    func mentionsAll(_ needles: [String]) -> Bool {
        needles.allSatisfy { mentions($0) }
    }

    /// The `timeout:` value declared anywhere in the step body (the waitFor block), in milliseconds.
    var waitForTimeoutMs: Int? {
        for line in bodyLines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("timeout:") else {
                continue
            }
            let value = trimmed.dropFirst("timeout:".count).trimmingCharacters(in: .whitespaces)
            if let parsed = Int(value) {
                return parsed
            }
        }
        return nil
    }
}

/// Minimal ordered-step extractor for a single-device plan YAML. Each step begins at a
/// `- tool: <name>` list item; following more-indented lines are its property block.
private enum PlanStepSequence {
    static func parse(_ yaml: String) -> [PlanStep] {
        var steps: [PlanStep] = []
        var currentTool: String?
        var currentBody: [String] = []

        func flush() {
            if let tool = currentTool {
                steps.append(PlanStep(tool: tool, bodyLines: currentBody))
            }
            currentTool = nil
            currentBody = []
        }

        for rawLine in yaml.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let trimmed = rawLine.trimmingCharacters(in: .whitespaces)
            // Skip full-line comments so a comment block preceding a step isn't misattributed to the
            // previous step's body (which would make `mentions(...)` match on comment text).
            if trimmed.hasPrefix("#") {
                continue
            }
            if let tool = toolName(fromListItem: trimmed) {
                flush()
                currentTool = tool
                currentBody = [rawLine]
            } else if currentTool != nil {
                currentBody.append(rawLine)
            }
        }
        flush()
        return steps
    }

    /// Returns the tool name for a `- tool: <name>` list item line, or nil for any other line.
    private static func toolName(fromListItem trimmed: String) -> String? {
        guard trimmed.hasPrefix("- tool:") else {
            return nil
        }
        let value = trimmed.dropFirst("- tool:".count).trimmingCharacters(in: .whitespaces)
        return value.isEmpty ? nil : value
    }
}

private func loadRemindersIntegrationTestSource() throws -> String {
    let currentFile = URL(fileURLWithPath: #filePath)
    let sourceURL = currentFile.deletingLastPathComponent()
        .appendingPathComponent("RemindersIntegrationTests.swift")
    return try String(contentsOf: sourceURL, encoding: .utf8)
}

private func restoreEnvironmentValue(_ value: String?, for key: String) {
    if let value = value {
        setenv(key, value, 1)
    } else {
        unsetenv(key)
    }
}

private func assertRemindersTimeoutFitsWorkflowStepCap(
    _ testCase: RemindersIntegrationBase,
    expectedTimeoutSeconds: TimeInterval,
    file: StaticString = #filePath,
    line: UInt = #line
) {
    let attempts = testCase.retryCount + 1
    let retryDelayBudget = max(0, attempts - 1) * Int(testCase.retryDelaySeconds.rounded(.up))
    let executorTimeoutConsumersPerAttempt = 2
    let workflowStepReservedOverheadSeconds = 60
    let totalAttemptBudget = Int(testCase.timeoutSeconds.rounded(.up)) * attempts * executorTimeoutConsumersPerAttempt +
        retryDelayBudget + workflowStepReservedOverheadSeconds

    XCTAssertLessThan(
        totalAttemptBudget,
        600,
        "Reminders retries must fit inside the 10-minute workflow step cap",
        file: file,
        line: line
    )
    XCTAssertEqual(testCase.timeoutSeconds, expectedTimeoutSeconds, file: file, line: line)
}

private func assertWorkflowUsesLocalCtrlProxyBuildForRemindersRun(
    _ workflow: String,
    file: StaticString = #filePath,
    line: UInt = #line
) {
    guard let jobRange = workflow.range(of: "ios-xctest-runner-simulator-tests:") else {
        XCTFail("Workflow is missing the XCTestRunner simulator job", file: file, line: line)
        return
    }
    guard let runRange = workflow.range(of: #"name: "Run Reminders integration tests (Xcode 26.2)""#) else {
        XCTFail("Workflow is missing the Xcode 26.2 Reminders run step", file: file, line: line)
        return
    }

    let jobBlock = workflow[jobRange.lowerBound ..< runRange.lowerBound]
    XCTAssertTrue(
        jobBlock.contains("AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD: \"true\""),
        "The PR XCTestRunner job must use the locally built CtrlProxy artifacts instead of downloading a release IPA",
        file: file,
        line: line
    )
}

private func loadRepositoryFile(_ path: String) throws -> String {
    let currentFile = URL(fileURLWithPath: #filePath)
    let repositoryRoot = currentFile
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
    return try String(contentsOf: repositoryRoot.appendingPathComponent(path), encoding: .utf8)
}

private func classBody(named className: String, in source: String) -> String {
    guard let declarationRange = source.range(of: "class \(className)")
        ?? source.range(of: "final class \(className)")
    else {
        return ""
    }
    guard let openingBrace = source[declarationRange.upperBound...].firstIndex(of: "{") else {
        return ""
    }

    var depth = 0
    var index = openingBrace
    while index < source.endIndex {
        let character = source[index]
        if character == "{" {
            depth += 1
        } else if character == "}" {
            depth -= 1
            if depth == 0 {
                return String(source[source.index(after: openingBrace) ..< index])
            }
        }
        index = source.index(after: index)
    }
    return ""
}

private func assertWorkflowWarmsTargetAppBeforeRemindersRun(
    _ workflow: String,
    warmupStepName: String,
    runStepName: String,
    file: StaticString = #filePath,
    line: UInt = #line
) {
    guard let warmupRange = workflow.range(of: #"name: "\#(warmupStepName)""#) else {
        XCTFail("Workflow is missing step named \(warmupStepName)", file: file, line: line)
        return
    }
    guard let runRange = workflow.range(of: #"name: "\#(runStepName)""#) else {
        XCTFail("Workflow is missing step named \(runStepName)", file: file, line: line)
        return
    }

    XCTAssertLessThan(
        warmupRange.lowerBound,
        runRange.lowerBound,
        "\(warmupStepName) must run before \(runStepName)",
        file: file,
        line: line
    )

    let warmupBlock = workflow[warmupRange.lowerBound ..< runRange.lowerBound]
    XCTAssertTrue(
        warmupBlock.contains("./scripts/ci/warm-reminders-target-app.sh"),
        "\(warmupStepName) must invoke the target-app warm-up helper",
        file: file,
        line: line
    )

    let nextStepRange = workflow[runRange.upperBound...].range(of: "\n      - name:")
    let runBlockEnd = nextStepRange?.lowerBound ?? workflow.endIndex
    let runBlock = workflow[runRange.lowerBound ..< runBlockEnd]
    XCTAssertTrue(
        runBlock.contains("timeout-minutes: 10"),
        "\(runStepName) must keep the Reminders step cap aligned with the retry timeout guard",
        file: file,
        line: line
    )
}

private func assertWorkflowRetriesRemindersRunOnce(
    _ workflow: String,
    runStepName: String,
    file: StaticString = #filePath,
    line: UInt = #line
) {
    let runBlock = workflowStepBlock(workflow, stepName: runStepName, file: file, line: line)
    XCTAssertTrue(
        stepBlockHasActiveEnvValue(runBlock, key: "AUTOMOBILE_TEST_RETRY_COUNT", value: "\"1\""),
        "\(runStepName) must enable exactly one bounded retry for cold first-leg bring-up flakes",
        file: file,
        line: line
    )
}

private func assertWorkflowRunsGuardedRemindersTest(
    _ workflow: String,
    runStepName: String,
    file: StaticString = #filePath,
    line: UInt = #line
) {
    let runBlock = workflowStepBlock(workflow, stepName: runStepName, file: file, line: line)
    XCTAssertTrue(
        stepBlockHasActiveTopLevelValue(
            runBlock,
            key: "run",
            value: "./scripts/ci/run-reminders-launch-plan-tests.sh"
        ),
        "\(runStepName) must fail when the filtered Reminders test command executes zero XCTest cases",
        file: file,
        line: line
    )
}

private func assertWorkflowStepRunsWhenNotCancelled(
    _ workflow: String,
    stepName: String,
    afterStepName: String? = nil,
    file: StaticString = #filePath,
    line: UInt = #line
) {
    let stepBlock = workflowStepBlock(
        workflow,
        stepName: stepName,
        afterStepName: afterStepName,
        file: file,
        line: line
    )
    XCTAssertTrue(
        stepBlockHasActiveTopLevelValue(stepBlock, key: "if", value: "${{ !cancelled() }}"),
        "\(stepName) must run after an earlier Reminders leg fails, but still respect cancellation",
        file: file,
        line: line
    )
}

private func workflowStepBlock(
    _ workflow: String,
    stepName: String,
    afterStepName: String? = nil,
    file: StaticString = #filePath,
    line: UInt = #line
) -> Substring {
    let searchStart: String.Index
    if let afterStepName {
        guard let afterRange = workflow.range(of: #"name: "\#(afterStepName)""#) else {
            XCTFail("Workflow is missing step named \(afterStepName)", file: file, line: line)
            return ""
        }
        searchStart = afterRange.upperBound
    } else {
        searchStart = workflow.startIndex
    }

    guard let stepRange = workflow[searchStart...].range(of: #"name: "\#(stepName)""#) else {
        XCTFail("Workflow is missing step named \(stepName)", file: file, line: line)
        return ""
    }

    let nextStepRange = workflow[stepRange.upperBound...].range(of: "\n      - name:")
    let stepBlockEnd = nextStepRange?.lowerBound ?? workflow.endIndex
    return workflow[stepRange.lowerBound ..< stepBlockEnd]
}

private func stepBlockHasActiveTopLevelValue(_ stepBlock: Substring, key: String, value: String) -> Bool {
    return stepBlockActiveLines(stepBlock).contains { line in
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return line.hasPrefix("        \(key):") && trimmed == "\(key): \(value)"
    }
}

private func stepBlockHasActiveEnvValue(_ stepBlock: Substring, key: String, value: String) -> Bool {
    var inEnv = false
    for line in stepBlockActiveLines(stepBlock) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if line.hasPrefix("        ") && !line.hasPrefix("          ") {
            inEnv = trimmed == "env:"
            continue
        }
        if inEnv, line.hasPrefix("          "), trimmed == "\(key): \(value)" {
            return true
        }
    }
    return false
}

private func stepBlockActiveLines(_ stepBlock: Substring) -> [String] {
    return stepBlock.split(separator: "\n", omittingEmptySubsequences: false)
        .map(String.init)
        .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("#") }
}
