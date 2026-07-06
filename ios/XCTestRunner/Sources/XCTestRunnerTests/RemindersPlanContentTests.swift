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

    /// The Reminders tests must run as single-attempt plans by default. CI warms the target app before
    /// the timed plan step, so retrying here would hide the root-cause fix regressing.
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

        assertRemindersTimeoutFitsWorkflowStepCap(RemindersLaunchPlanTests(), expectedTimeoutSeconds: 149)
        assertRemindersTimeoutFitsWorkflowStepCap(RemindersAddPlanTests(), expectedTimeoutSeconds: 149)
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

    /// Retry is no longer the stabilization mechanism for Reminders. The integration base should only
    /// own simulator/daemon readiness; retry behavior comes from `AutoMobileTestCase`.
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

        assertWorkflowWarmsTargetAppBeforeRemindersRun(
            workflow,
            warmupStepName: "Warm up Reminders target app (Xcode 26.2)",
            runStepName: "Run Reminders integration tests (Xcode 26.2)"
        )
        assertWorkflowWarmsTargetAppBeforeRemindersRun(
            workflow,
            warmupStepName: "Warm up Reminders target app (Xcode 26.3)",
            runStepName: "Run Reminders integration tests (Xcode 26.3)"
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
            warmupStepName: "Warm up Reminders target app (Xcode 26.3)",
            runStepName: "Run Reminders integration tests (Xcode 26.3)"
        )
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

        // A best-effort dismissal of the "Not Now" alert button precedes the create tap.
        let dismissIndex = steps.firstIndex { $0.tool == "tapOn" && $0.mentions("Not Now") }
        guard let dismissIndex = dismissIndex else {
            XCTFail("Plan must dismiss the iCloud alert via a tapOn \"Not Now\" step")
            return
        }
        XCTAssertLessThan(dismissIndex, createTapIndex, "The alert dismissal must precede creating a reminder")
        XCTAssertTrue(
            steps[dismissIndex].isOptional,
            "The \"Not Now\" dismissal must be optional so alert-absent runs don't fail"
        )

        // Any waitFor guarding the (intermittent) alert must also be optional for the same reason.
        for index in 0 ..< dismissIndex where steps[index].tool == "observe" && steps[index].mentions("Not Now") {
            XCTAssertTrue(
                steps[index].isOptional,
                "A waitFor guarding the intermittent alert must be optional"
            )
        }

        // The create tap is guarded by a preceding observe waitFor on the same control.
        XCTAssertGreaterThan(createTapIndex, 0)
        let createGuard = steps[createTapIndex - 1]
        XCTAssertEqual(createGuard.tool, "observe", "The tapOn \"New Reminder\" must follow an observe guard")
        XCTAssertTrue(createGuard.hasWaitFor && createGuard.mentions("New Reminder"))
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
    let totalAttemptBudget = Int(testCase.timeoutSeconds.rounded(.up)) * attempts * executorTimeoutConsumersPerAttempt +
        retryDelayBudget

    XCTAssertLessThan(
        totalAttemptBudget,
        600,
        "Reminders retries must fit inside the 10-minute workflow step cap",
        file: file,
        line: line
    )
    XCTAssertEqual(testCase.timeoutSeconds, expectedTimeoutSeconds, file: file, line: line)
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
