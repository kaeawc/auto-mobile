import Darwin
import Foundation
import XCTest

/// Module load logging - this runs when the test module is first loaded
private let _moduleLoadLog: Void = {
    let line = "[XCTestRunner] Module loaded at \(Date())\n"
    fputs(line, stderr)
}()

/// Base XCTestCase for executing AutoMobile YAML automation plans via MCP.
///
/// Concurrency: `nonisolated` — NOT `@MainActor`. `defaultTestSuite` overrides a `nonisolated`
/// XCTestCase member (a `@MainActor` override would be rejected), and the execute path is synchronous
/// and semaphore-blocking (hopping it onto the main actor would risk blocking it). The class holds no
/// global mutable state.
open class AutoMobileTestCase: XCTestCase {
    override open class var defaultTestSuite: XCTestSuite {
        // Ensure module load logging is triggered
        _ = _moduleLoadLog
        PerfTimer.log("defaultTestSuite START for \(self)")
        if self == AutoMobileTestCase.self {
            PerfTimer.log("defaultTestSuite: returning empty suite for base class")
            return XCTestSuite(name: "AutoMobileTestCase")
        }
        PerfTimer.log("defaultTestSuite: registering observer")
        _ = AutoMobileTestObserver.registerIfNeeded()

        let orderingSelection = resolveTimingOrderingSelection()
        let timingAvailable = TestTimingCache.shared.hasTimings()
        logTimingOrdering(selection: orderingSelection, timingAvailable: timingAvailable)

        let timingOrderingActive = orderingSelection.resolved != .none && timingAvailable
        guard timingOrderingActive else {
            PerfTimer.log("defaultTestSuite: timing ordering inactive; returning default suite")
            return super.defaultTestSuite
        }

        PerfTimer.log("defaultTestSuite: calling super.defaultTestSuite")
        let baseSuite = super.defaultTestSuite
        let tests = baseSuite.tests
        PerfTimer.log("defaultTestSuite: found \(tests.count) tests")
        let orderedTests = orderTestsByTiming(tests, strategy: orderingSelection.resolved)
        baseSuite.setValue(orderedTests, forKey: "tests")
        PerfTimer.log("defaultTestSuite END for \(self)")
        return baseSuite
    }

    open var planPath: String {
        if let value = environment.firstNonEmpty(["AUTOMOBILE_TEST_PLAN", "PLAN_PATH"]) {
            return value
        }
        return ""
    }

    open var mcpEndpoint: String {
        return environment.firstNonEmpty([
            "AUTOMOBILE_MCP_URL",
            "AUTOMOBILE_MCP_HTTP_URL",
            "MCP_ENDPOINT",
        ]) ?? "http://localhost:9000/auto-mobile/streamable"
    }

    open var daemonSocketPath: String {
        return environment.firstNonEmpty([
            "AUTOMOBILE_DAEMON_SOCKET_PATH",
            "AUTO_MOBILE_DAEMON_SOCKET_PATH",
        ]) ?? AutoMobileDaemonSocket.defaultPath
    }

    /// The source checkout whose built daemon should own the default shared socket. Override this
    /// for an embedding project, or set `AUTOMOBILE_REPO_ROOT`; without a built entrypoint the
    /// daemon manager safely falls back to the PATH-launched CLI.
    open var daemonRepoRoot: String? {
        if let configuredRoot = environment.firstNonEmpty(["AUTOMOBILE_REPO_ROOT"]) {
            return configuredRoot
        }
        return DaemonManager.findRepoRoot(startingAt: #filePath)
    }

    open var retryCount: Int {
        return environment.intValue(["AUTOMOBILE_TEST_RETRY_COUNT", "RETRY_COUNT"]) ?? 0
    }

    open var timeoutSeconds: TimeInterval {
        return environment.doubleValue(["AUTOMOBILE_TEST_TIMEOUT_SECONDS", "TEST_TIMEOUT"]) ?? 300
    }

    open var retryDelaySeconds: TimeInterval {
        return environment.doubleValue(["AUTOMOBILE_TEST_RETRY_DELAY_SECONDS"]) ?? 1
    }

    open var startStep: Int {
        return 0
    }

    /// Per-test kill switch for AI-assisted failure recovery. When true (the default) and the
    /// `ai-recovery` flag is enabled and a model API key is configured, a failed step triggers one
    /// recovery attempt before the test fails. Set `AUTOMOBILE_AI_ASSISTANCE=false` (or override) to
    /// force the pre-recovery behavior of failing immediately.
    open var aiAssistance: Bool {
        return environment.boolValue(["AUTOMOBILE_AI_ASSISTANCE"]) ?? true
    }

    open var planParameters: [String: String] {
        return [:]
    }

    /// Parameter keys whose substituted values are sensitive (tokens, passwords, PII). Their values
    /// are masked out of any context AI-assisted recovery sends to the LLM provider, while the local
    /// daemon still executes with the real values (issue #6029). A plan can also declare sensitive
    /// keys via its top-level `secretParameters:` list; the two sets are unioned. Override to protect
    /// a `planParameters` value that carries a secret.
    open var secretParameterKeys: Set<String> {
        return []
    }

    open var cleanupOptions: AutoMobilePlanExecutor.CleanupOptions? {
        return nil
    }

    open var planBundle: Bundle? {
        return Bundle(for: type(of: self))
    }

    open func setUpAutoMobile() throws {}
    open func tearDownAutoMobile() throws {}

    private var executor: AutoMobilePlanExecutor?
    private let environment = AutoMobileEnvironment()

    override open func setUpWithError() throws {
        PerfTimer.log("setUpWithError START for \(name)")
        try PerfTimer.measure("super.setUpWithError") {
            try super.setUpWithError()
        }
        try PerfTimer.measure("setUpAutoMobile") {
            try setUpAutoMobile()
        }
        let config = try PerfTimer.measure("makeConfiguration") {
            try makeConfiguration()
        }
        PerfTimer.log("Configuration: planPath=\(config.planPath), transport=\(config.transport)")
        executor = PerfTimer.measure("createExecutor") {
            AutoMobilePlanExecutor(configuration: config)
        }
        PerfTimer.log("setUpWithError END for \(name)")
    }

    override open func tearDownWithError() throws {
        print("[AutoMobileTestCase] tearDownWithError starting for \(name)")
        try tearDownAutoMobile()
        executor = nil
        // Note: Session release is handled automatically by the daemon after executePlan completes
        try super.tearDownWithError()
        print("[AutoMobileTestCase] tearDownWithError complete")
    }

    public func executePlan() throws -> AutoMobilePlanExecutor.ExecutePlanResult {
        PerfTimer.log("executePlan START")
        guard let executor = executor else {
            PerfTimer.log("ERROR: executor is nil")
            throw AutoMobileTestCaseError.executorUnavailable
        }
        let metadata = PerfTimer.measure("buildTestMetadata") {
            buildTestMetadata()
        }
        PerfTimer.log("Executing with metadata: testClass=\(metadata.testClass), testMethod=\(metadata.testMethod)")
        let result = try PerfTimer.measure("executor.execute") {
            try executor.execute(testMetadata: metadata)
        }
        PerfTimer.log("executePlan END - success=\(result.success), steps=\(result.executedSteps)/\(result.totalSteps)")
        return result
    }

    private func makeConfiguration() throws -> AutoMobilePlanExecutor.Configuration {
        PerfTimer.log("makeConfiguration: resolving planPath")
        let planPath = planPath.trimmingCharacters(in: .whitespacesAndNewlines)
        PerfTimer.log("makeConfiguration: planPath=\(planPath)")
        guard !planPath.isEmpty else {
            PerfTimer.log("ERROR: planPath is empty")
            throw AutoMobileTestCaseError.missingPlanPath
        }

        let transport: AutoMobilePlanExecutor.Transport
        PerfTimer.log("makeConfiguration: checking for MCP endpoint env vars")
        if let endpoint = environment.firstNonEmpty([
            "AUTOMOBILE_MCP_URL",
            "AUTOMOBILE_MCP_HTTP_URL",
            "MCP_ENDPOINT",
        ]) {
            PerfTimer.log("makeConfiguration: using HTTP transport endpoint=\(endpoint)")
            let normalizedEndpoint = MCPEndpoint.normalize(endpoint)
            guard let endpointURL = URL(string: normalizedEndpoint) else {
                throw AutoMobileTestCaseError.invalidEndpoint(normalizedEndpoint)
            }
            transport = .streamableHttp(url: endpointURL)
        } else {
            PerfTimer.log("makeConfiguration: using Unix socket transport at \(daemonSocketPath)")
            transport = .daemonUnixSocket(path: daemonSocketPath)
        }

        PerfTimer.log("makeConfiguration: creating Configuration object")
        return AutoMobilePlanExecutor.Configuration(
            transport: transport,
            planPath: planPath,
            daemonRepoRoot: daemonRepoRoot,
            retryCount: retryCount,
            timeoutSeconds: timeoutSeconds,
            retryDelaySeconds: retryDelaySeconds,
            startStep: startStep,
            parameters: planParameters,
            secretParameterKeys: secretParameterKeys,
            cleanup: cleanupOptions,
            planBundle: planBundle,
            aiAssistance: aiAssistance
        )
    }

    private func buildTestMetadata() -> AutoMobilePlanExecutor.TestMetadata {
        let className = String(describing: type(of: self))
        let methodName = testMethodName()
        let appVersion = environment.firstNonEmpty([
            "AUTOMOBILE_APP_VERSION",
            "AUTO_MOBILE_APP_VERSION",
            "APP_VERSION",
        ])
        let gitCommit = environment.firstNonEmpty([
            "AUTOMOBILE_GIT_COMMIT",
            "AUTO_MOBILE_GIT_COMMIT",
            "GITHUB_SHA",
            "GIT_COMMIT",
            "CI_COMMIT_SHA",
        ])
        let isCi = environment.boolValue(["AUTOMOBILE_CI_MODE", "CI", "GITHUB_ACTIONS"])

        return AutoMobilePlanExecutor.TestMetadata(
            testClass: className,
            testMethod: methodName,
            appVersion: appVersion,
            gitCommit: gitCommit,
            isCi: isCi
        )
    }

    private func testMethodName() -> String {
        if let selector = invocation?.selector {
            return NSStringFromSelector(selector)
        }
        let fullName = name
        if let range = fullName.range(of: " ") {
            let suffix = fullName[range.upperBound...]
            return suffix.trimmingCharacters(in: CharacterSet(charactersIn: "]"))
        }
        return fullName
    }

    private enum TimingOrderingStrategy: String {
        case none
        case auto
        case durationAsc
        case durationDesc
    }

    private struct TimingOrderingSelection {
        let requested: TimingOrderingStrategy
        let resolved: TimingOrderingStrategy
    }

    private struct TimingCandidate {
        let test: XCTest
        let index: Int
        let durationMs: Int?
    }

    private class func resolveTimingOrderingSelection() -> TimingOrderingSelection {
        let rawValue = timingConfigValue("automobile.junit.timing.ordering")?
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? "auto"
        let requested = parseTimingOrderingStrategy(rawValue)
        let parallelWorkers = resolveParallelWorkerCount()
        let resolved: TimingOrderingStrategy
        if requested == .auto {
            resolved = parallelWorkers > 1 ? .durationDesc : .durationAsc
        } else {
            resolved = requested
        }
        return TimingOrderingSelection(requested: requested, resolved: resolved)
    }

    private class func parseTimingOrderingStrategy(_ rawValue: String) -> TimingOrderingStrategy {
        switch rawValue {
        case "auto":
            return .auto
        case "duration-asc", "duration_asc", "shortest-first", "shortest_first", "shortest":
            return .durationAsc
        case "duration-desc", "duration_desc", "longest-first", "longest_first", "longest":
            return .durationDesc
        case "none", "off", "false", "disabled":
            return .none
        default:
            return .none
        }
    }

    private class func resolveParallelWorkerCount() -> Int {
        if let argumentValue = argumentValue(flag: "-parallel-testing-worker-count"),
           let workerCount = Int(argumentValue), workerCount > 0
        {
            return workerCount
        }
        if let envValue = ProcessInfo.processInfo.environment["XCTEST_PARALLEL_THREAD_COUNT"],
           let workerCount = Int(envValue), workerCount > 0
        {
            return workerCount
        }
        return 1
    }

    private class func argumentValue(flag: String) -> String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else {
            return nil
        }
        return arguments[index + 1]
    }

    private class func logTimingOrdering(selection: TimingOrderingSelection, timingAvailable: Bool) {
        if selection.requested == .auto {
            print(
                "AutoMobileTestCase: Timing ordering=auto (resolved=\(selection.resolved.rawValue)), timing data available=\(timingAvailable)"
            )
        } else {
            print(
                "AutoMobileTestCase: Timing ordering=\(selection.requested.rawValue), timing data available=\(timingAvailable)"
            )
        }
    }

    private class func orderTestsByTiming(
        _ tests: [XCTest],
        strategy: TimingOrderingStrategy
    )
        -> [XCTest]
    {
        if strategy == .none || tests.isEmpty {
            return tests
        }

        let candidates = tests.enumerated().map { index, test in
            guard let testCase = test as? XCTestCase,
                  let methodName = testMethodName(from: testCase)
            else {
                return TimingCandidate(test: test, index: index, durationMs: nil)
            }
            let className = String(describing: type(of: testCase))
            let durationMs = TestTimingCache.shared.getTiming(testClass: className, testMethod: methodName)?
                .averageDurationMs
            return TimingCandidate(test: test, index: index, durationMs: durationMs)
        }

        let withTiming = candidates.filter { $0.durationMs != nil }
        let withoutTiming = candidates.filter { $0.durationMs == nil }

        if withTiming.isEmpty {
            return tests
        }

        let sortedWithTiming: [TimingCandidate]
        switch strategy {
        case .durationDesc:
            sortedWithTiming = withTiming.sorted {
                if $0.durationMs == $1.durationMs {
                    return $0.index < $1.index
                }
                return ($0.durationMs ?? 0) > ($1.durationMs ?? 0)
            }
        case .durationAsc:
            sortedWithTiming = withTiming.sorted {
                if $0.durationMs == $1.durationMs {
                    return $0.index < $1.index
                }
                return ($0.durationMs ?? 0) < ($1.durationMs ?? 0)
            }
        case .auto, .none:
            sortedWithTiming = withTiming
        }

        let sortedWithoutTiming = withoutTiming.sorted { $0.index < $1.index }
        return sortedWithTiming.map { $0.test } + sortedWithoutTiming.map { $0.test }
    }

    private class func timingConfigValue(_ key: String) -> String? {
        if let value = UserDefaults.standard.object(forKey: key) {
            if let stringValue = value as? String {
                return stringValue
            }
            return String(describing: value)
        }
        return ProcessInfo.processInfo.environment[key]
    }

    private class func testMethodName(from testCase: XCTestCase) -> String? {
        let fullName = testCase.name
        if let range = fullName.range(of: " ") {
            let suffix = fullName[range.upperBound...]
            return suffix.trimmingCharacters(in: CharacterSet(charactersIn: "]"))
        }
        return fullName
    }
}
