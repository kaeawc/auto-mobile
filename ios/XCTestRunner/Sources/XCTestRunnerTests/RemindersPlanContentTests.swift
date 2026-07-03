import XCTest
@testable import XCTestRunner

/// Structural (no-simulator) guards for the bundled `add-reminder.yaml` plan.
///
/// `RemindersAddPlanTests.testAddReminderPlan` was flaky because plan step 5 was a bare
/// `tapOn text: "Done"` fired immediately after `inputText`; on a slow simulator the "Done"
/// control isn't present yet and the tap fails with "Element not found" (issue #2811). These tests
/// encode the determinism invariant — the save tap must be guarded by a preceding `observe`
/// `waitFor` on the same control — so the plan can't silently regress back to a racy bare tap.
///
/// They parse the real bundled resource (not a fixture) and need no booted simulator or daemon,
/// so they run in the plain `swift test` macOS suite.
final class RemindersPlanContentTests: XCTestCase {
    private func loadAddReminderPlan() throws -> String {
        return try DefaultPlanLoader().loadPlan(at: "add-reminder.yaml", bundle: Bundle.module)
    }

    /// The save tap must be immediately preceded by an `observe`/`waitFor` guard on "Done", so the
    /// executor polls for the control (and its `awaitTimeout` path fails fast on genuine absence)
    /// instead of racing a bare tap.
    func testAddReminderPlanWaitsForDoneBeforeTappingIt() throws {
        let steps = PlanStepSequence.parse(try loadAddReminderPlan())

        guard let saveTapIndex = steps.firstIndex(where: { $0.tool == "tapOn" && $0.mentionsDone }) else {
            XCTFail("Plan is missing the tapOn \"Done\" save step")
            return
        }

        XCTAssertGreaterThan(
            saveTapIndex,
            0,
            "The tapOn \"Done\" step cannot be the first step; it must follow a wait guard"
        )

        let guardStep = steps[saveTapIndex - 1]
        XCTAssertEqual(
            guardStep.tool,
            "observe",
            "The step before tapOn \"Done\" must be an observe guard, was \(guardStep.tool)"
        )
        XCTAssertTrue(
            guardStep.hasWaitFor,
            "The observe step guarding the \"Done\" tap must use waitFor"
        )
        XCTAssertTrue(
            guardStep.mentionsDone,
            "The waitFor guard before the \"Done\" tap must target \"Done\""
        )
    }

    /// The guard must be bounded so a genuinely-absent control fails fast instead of hanging for the
    /// whole plan timeout.
    func testDoneWaitGuardHasBoundedTimeout() throws {
        let steps = PlanStepSequence.parse(try loadAddReminderPlan())

        guard let saveTapIndex = steps.firstIndex(where: { $0.tool == "tapOn" && $0.mentionsDone }),
              saveTapIndex > 0
        else {
            XCTFail("Plan is missing a guarded tapOn \"Done\" step")
            return
        }

        let guardStep = steps[saveTapIndex - 1]
        guard let timeout = guardStep.waitForTimeoutMs else {
            XCTFail("The waitFor guard before the \"Done\" tap must declare a timeout")
            return
        }
        XCTAssertGreaterThan(timeout, 0, "waitFor timeout must be positive")
        XCTAssertLessThanOrEqual(
            timeout,
            30000,
            "waitFor timeout should stay bounded so genuine failures don't hang the plan"
        )
    }

    /// The add-flow test retry-wraps itself (#2811) so the residual cross-iOS-version flake doesn't
    /// red-flag otherwise-green PRs, while a genuine break still fails on every attempt.
    func testAddReminderPlanDefaultsToOneRetry() {
        // An explicit env override legitimately wins, so only assert the default when unset.
        let env = ProcessInfo.processInfo.environment
        if env["AUTOMOBILE_TEST_RETRY_COUNT"] != nil || env["RETRY_COUNT"] != nil {
            return
        }
        XCTAssertEqual(RemindersAddPlanTests().retryCount, 1)
    }

    /// An explicit retry override wins — including 0 to disable retries for CI/local repro runs.
    func testExplicitZeroRetryOverrideIsHonored() {
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

        XCTAssertEqual(RemindersAddPlanTests().retryCount, 0)
    }

    /// The intermittent "Enable iCloud Syncing?" alert must be dismissed best-effort before the
    /// create step, and the create tap must itself be guarded by a wait. The dismissal has to be
    /// `optional` so runs where the alert never appears don't fail.
    func testDismissesICloudAlertBestEffortBeforeCreating() throws {
        let steps = PlanStepSequence.parse(try loadAddReminderPlan())

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
        for index in 0..<dismissIndex where steps[index].tool == "observe" && steps[index].mentions("Not Now") {
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
        let saveIndex = steps.firstIndex { $0.tool == "tapOn" && $0.mentionsDone }

        XCTAssertNotNil(createIndex, "Plan must still focus a new reminder")
        XCTAssertNotNil(typeIndex, "Plan must still type the reminder title")
        XCTAssertNotNil(saveIndex, "Plan must still save via the \"Done\" control")
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

    var body: String { bodyLines.joined(separator: "\n") }

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

    var mentionsDone: Bool { mentions("Done") }

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
