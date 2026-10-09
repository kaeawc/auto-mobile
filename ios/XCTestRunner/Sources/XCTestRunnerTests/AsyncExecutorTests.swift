import Foundation
import os
import XCTest
@testable import XCTestRunner
import XCTestRunnerTestSupport

@MainActor
final class AsyncExecutorTests: XCTestCase {
    func testExecutePlanReturnsResultAndPassesOneSessionAndMetadataAcrossAwait() async throws {
        let client = AsyncExecutorClient()
        let generator = ExecutorSessionProbe()
        let executor = makeExecutor(client: client, handler: AsyncExecutorRecovery())
        let testCase = HermeticPlanTestCase(selector: #selector(HermeticPlanTestCase.planBody))
        testCase.executorFactory = { configuration in
            XCTAssertEqual(configuration.planPath, "unused")
            return executor
        }
        testCase.idGenerator = { generator.generate() }
        try testCase.setUpWithError()
        defer { try? testCase.tearDownWithError() }
        let observer = AutoMobileTestObserver()
        observer.testCaseWillStart(testCase)

        let result = try await Task.detached { try await testCase.executePlan() }.value
        observer.testCaseDidFinish(testCase)

        XCTAssertTrue(result.success)
        XCTAssertEqual(result.executedSteps, 2)
        XCTAssertEqual(generator.calls, 1)
        XCTAssertEqual(client.sessions, ["generated-session-1", "generated-session-1"])
        XCTAssertEqual(client.testClasses, ["HermeticPlanTestCase"])
        XCTAssertEqual(client.testMethods, ["planBody"])
        XCTAssertEqual(observer.getTimingData().map(\.testName), [testCase.name])
    }

    func testCancellingAsyncTestBodyPropagatesThroughExecutePlanToClient() async throws {
        let client = AsyncExecutorClient(pauseCall: true)
        let generator = ExecutorSessionProbe()
        let executor = makeExecutor(client: client, handler: AsyncExecutorRecovery())
        let testCase = HermeticPlanTestCase(selector: #selector(HermeticPlanTestCase.planBody))
        testCase.executorFactory = { _ in executor }
        testCase.idGenerator = { generator.generate() }
        try testCase.setUpWithError()
        defer { try? testCase.tearDownWithError() }

        let body = Task.detached { try await testCase.executePlan() }
        try await client.executions.wait(for: 1)
        body.cancel()
        await assertTransportCancellation(body)

        XCTAssertEqual(client.cancellations.count, 1)
        XCTAssertEqual(client.executions.count, 1)
        XCTAssertEqual(generator.calls, 1)
        XCTAssertEqual(client.sessions, ["generated-session-1", "generated-session-1"])
        XCTAssertEqual(client.resetSessionCount, 0)
    }

    func testAsyncDefaultUsesGeneratorOncePerExecution() async throws {
        let generator = ExecutorSessionProbe()
        let client = AsyncExecutorClient()
        let executor = makeExecutor(
            client: client,
            handler: AsyncExecutorRecovery(),
            idGenerator: { generator.generate() }
        )

        _ = try await executor.execute()
        _ = try await executor.execute()

        XCTAssertEqual(client.sessions, [
            "generated-session-1", "generated-session-1",
            "generated-session-2", "generated-session-2",
        ])
        XCTAssertEqual(generator.calls, 2, "each execution generates exactly one ID")
    }

    func testDefaultGeneratorProducesDistinctUUIDs() async throws {
        let client = AsyncExecutorClient()
        let executor = makeExecutor(client: client, handler: AsyncExecutorRecovery())
        _ = try await executor.execute()
        _ = try await executor.execute()
        let first = try XCTUnwrap(client.sessions[0])
        let second = try XCTUnwrap(client.sessions[2])
        XCTAssertNotNil(UUID(uuidString: first))
        XCTAssertNotNil(UUID(uuidString: second))
        XCTAssertNotEqual(first, second)
    }

    func testExplicitSessionOverridesGenerator() async throws {
        let client = AsyncExecutorClient()
        let generator = ExecutorSessionProbe()
        let executor = makeExecutor(
            client: client,
            handler: AsyncExecutorRecovery(),
            idGenerator: { generator.generate() }
        )
        let result = try await executor.execute(sessionUuid: "explicit-xctest-session")
        XCTAssertTrue(result.success)
        XCTAssertEqual(client.sessions, ["explicit-xctest-session", "explicit-xctest-session"])
        XCTAssertEqual(generator.calls, 0)
    }

    func testBlockedPreflightAllowsOtherTasksToProgressAndCompletesWhenReleased() async throws {
        let ensurer = BlockingExecutorDaemonEnsurer()
        defer { ensurer.release() }
        let client = AsyncExecutorClient()
        let executor = makeExecutor(
            client: client,
            handler: AsyncExecutorRecovery(),
            transport: .daemonUnixSocket(path: DaemonManager.socketPath),
            daemonEnsurer: ensurer
        )
        let task = Task { try await executor.execute() }
        try await ensurer.entered.wait(for: 1)
        let progress = await Task.detached { 42 }.value
        XCTAssertEqual(progress, 42)
        XCTAssertTrue(ensurer.isBlocked, "other async work finishes before ensure is released")
        XCTAssertEqual(client.initializations.count, 0)
        ensurer.release()
        let result = try await task.value
        XCTAssertTrue(result.success)
        XCTAssertEqual(ensurer.finished.count, 1)
        XCTAssertEqual(client.resetSessionCount, 0)
    }

    func testCancellationDuringPreflightReturnsBeforeEnsureAndIgnoresLateCompletion() async throws {
        let ensurer = BlockingExecutorDaemonEnsurer()
        defer { ensurer.release() }
        let scheduler = VirtualDeadlineScheduler()
        let client = AsyncExecutorClient()
        let handler = AsyncExecutorRecovery()
        let executor = makeExecutor(
            client: client,
            handler: handler,
            scheduler: scheduler,
            transport: .daemonUnixSocket(path: DaemonManager.socketPath),
            daemonEnsurer: ensurer
        )
        let task = Task { try await executor.execute() }
        try await ensurer.entered.wait(for: 1)
        task.cancel()
        await assertTransportCancellation(task)
        XCTAssertTrue(ensurer.isBlocked, "cancellation returns without joining the blocked ensure")
        XCTAssertEqual(ensurer.finished.count, 0)
        XCTAssertEqual(client.initializations.count, 0)
        XCTAssertTrue(client.names.isEmpty)
        XCTAssertEqual(client.resetSessionCount, 0)
        XCTAssertEqual(handler.calls.count, 0)
        XCTAssertTrue(scheduler.requestedDelays.isEmpty)
        ensurer.release()
        try await ensurer.finished.wait(for: 1)
        await assertTransportCancellation(task)
        XCTAssertEqual(ensurer.entered.count, 1)
        XCTAssertTrue(client.names.isEmpty)
        XCTAssertEqual(client.resetSessionCount, 0)
        XCTAssertEqual(handler.calls.count, 0)
        XCTAssertTrue(scheduler.requestedDelays.isEmpty)
    }

    func testCancellationDuringRetryEnsureDoesNotResetRetryOrRecoverAfterLateCompletion() async throws {
        let ensurer = BlockingExecutorDaemonEnsurer(blockOnCall: 2)
        defer { ensurer.release() }
        let scheduler = VirtualDeadlineScheduler()
        let client = AsyncExecutorClient(failures: 1)
        let handler = AsyncExecutorRecovery()
        let executor = makeExecutor(
            client: client,
            handler: handler,
            scheduler: scheduler,
            transport: .daemonUnixSocket(path: DaemonManager.socketPath),
            daemonEnsurer: ensurer
        )
        let task = Task { try await executor.execute() }
        try await ensurer.entered.wait(for: 2)
        XCTAssertEqual(client.executions.count, 1)
        XCTAssertEqual(client.resetSessionCount, 0, "ensure must finish before the pre-retry reset")
        task.cancel()
        await assertTransportCancellation(task)
        XCTAssertTrue(ensurer.isBlocked)
        XCTAssertEqual(ensurer.finished.count, 1, "only preflight has finished")
        XCTAssertEqual(client.resetSessionCount, 0)
        XCTAssertEqual(handler.calls.count, 0)
        XCTAssertTrue(scheduler.requestedDelays.isEmpty)
        ensurer.release()
        try await ensurer.finished.wait(for: 2)
        await assertTransportCancellation(task)
        XCTAssertEqual(ensurer.entered.count, 2)
        XCTAssertEqual(client.executions.count, 1)
        XCTAssertEqual(client.resetSessionCount, 0)
        XCTAssertEqual(handler.calls.count, 0)
        XCTAssertTrue(scheduler.requestedDelays.isEmpty)
    }

    func testSuccessDoesNotResetSession() async throws {
        let client = AsyncExecutorClient()
        let handler = AsyncExecutorRecovery()
        let result = try await makeExecutor(client: client, handler: handler).execute()
        XCTAssertTrue(result.success)
        XCTAssertEqual(client.names, ["setToolEnabled", "executePlan"])
        XCTAssertEqual(client.resetSessionCount, 0)
        XCTAssertEqual(handler.calls.count, 0)
    }

    func testFinalFailureWithoutRetryDoesNotResetSession() async {
        let client = AsyncExecutorClient(failures: 1)
        let handler = AsyncExecutorRecovery()
        await assertAsyncThrowsError { try await makeExecutor(client: client, handler: handler, retries: 0).execute() }
        XCTAssertEqual(client.resetSessionCount, 0)
        XCTAssertEqual(handler.calls.count, 0)
    }

    func testRetryWaitsForVirtualDelay() async throws {
        let scheduler = VirtualDeadlineScheduler()
        let client = AsyncExecutorClient(failures: 1)
        let handler = AsyncExecutorRecovery()
        let executor = makeExecutor(client: client, handler: handler, scheduler: scheduler)
        let task = Task { try await executor.execute() }
        try await scheduler.registered.wait(for: 1)
        XCTAssertEqual(client.names.filter { $0 == "executePlan" }.count, 1)
        XCTAssertEqual(client.resetSessionCount, 1, "session must reset before the retry delay")
        scheduler.advance(by: 9)
        XCTAssertEqual(scheduler.pendingCount, 1, "retry must wait the entire ten-second delay")
        scheduler.advance(by: 1)
        let result = try await task.value
        XCTAssertTrue(result.success)
        XCTAssertEqual(client.names.filter { $0 == "executePlan" }.count, 2)
        XCTAssertEqual(client.resetSessionCount, 1)
    }

    func testRetriesExhaustedResetSessionOncePerRetry() async throws {
        let scheduler = VirtualDeadlineScheduler()
        let client = AsyncExecutorClient(failures: 3)
        let handler = AsyncExecutorRecovery()
        let executor = makeExecutor(client: client, handler: handler, scheduler: scheduler)
        let task = Task { try await executor.execute() }
        for retry in 1 ... 2 {
            try await scheduler.registered.wait(for: retry)
            XCTAssertEqual(client.executions.count, retry)
            XCTAssertEqual(client.resetSessionCount, retry, "session must reset before each retry delay")
            scheduler.advance(by: 10)
        }
        await assertAsyncThrowsError { try await task.value }
        XCTAssertEqual(client.executions.count, 3)
        XCTAssertEqual(client.resetSessionCount, 2, "final failure must not add a reset")
        XCTAssertEqual(handler.calls.count, 0)
        XCTAssertEqual(scheduler.pendingCount, 0)
    }

    func testHTTPRetryDoesNotResetSession() async throws {
        let scheduler = VirtualDeadlineScheduler()
        let client = AsyncExecutorClient(failures: 1)
        let handler = AsyncExecutorRecovery()
        let executor = makeExecutor(
            client: client,
            handler: handler,
            scheduler: scheduler,
            transport: .streamableHttp(url: URL(fileURLWithPath: "/unused/async-executor"))
        )
        let task = Task { try await executor.execute() }
        try await scheduler.registered.wait(for: 1)
        XCTAssertEqual(client.resetSessionCount, 0)
        scheduler.advance(by: 10)
        let result = try await task.value
        XCTAssertTrue(result.success)
        XCTAssertEqual(client.executions.count, 2)
        XCTAssertEqual(client.resetSessionCount, 0)
        XCTAssertEqual(handler.calls.count, 0)
    }

    func testCancellationBeforeFirstCallDoesNotResetSession() async throws {
        let client = AsyncExecutorClient()
        let handler = AsyncExecutorRecovery()
        let executor = makeExecutor(client: client, handler: handler)
        let start = SingleResumeCell<Void>()
        let task = Task {
            // Deliberately enter execute with cancellation already set.
            try await start.wait(cancellable: false)
            return try await executor.execute()
        }
        let resetsBeforeCancellation = client.resetSessionCount
        XCTAssertEqual(resetsBeforeCancellation, 0)
        task.cancel()
        start.resume(returning: ())
        await assertTransportCancellation(task)
        XCTAssertEqual(client.initializations.count, 0)
        XCTAssertTrue(client.names.isEmpty)
        XCTAssertEqual(handler.calls.count, 0)
        XCTAssertEqual(client.resetSessionCount, resetsBeforeCancellation, "cancellation must not add a reset")
    }

    func testCancellationDuringCallDoesNotResetSessionRecoverOrRetry() async throws {
        let client = AsyncExecutorClient(pauseCall: true)
        let handler = AsyncExecutorRecovery()
        let executor = makeExecutor(client: client, handler: handler)
        let task = Task { try await executor.execute() }
        try await client.executions.wait(for: 1)
        let resetsBeforeCancellation = client.resetSessionCount
        XCTAssertEqual(resetsBeforeCancellation, 0)
        task.cancel()
        await assertTransportCancellation(task)
        XCTAssertEqual(client.executions.count, 1)
        XCTAssertEqual(handler.calls.count, 0)
        XCTAssertEqual(client.resetSessionCount, resetsBeforeCancellation, "cancellation must not add a reset")
    }

    func testCancellationErrorFromClientIsNotRetriedOrRecovered() async {
        let client = AsyncExecutorClient(cancellationError: true)
        let handler = AsyncExecutorRecovery()
        let executor = makeExecutor(client: client, handler: handler)
        let resetsBeforeCancellation = client.resetSessionCount
        XCTAssertEqual(resetsBeforeCancellation, 0)
        let task = Task { try await executor.execute() }
        await assertTransportCancellation(task)
        XCTAssertEqual(client.executions.count, 1)
        XCTAssertEqual(handler.calls.count, 0)
        XCTAssertEqual(client.resetSessionCount, resetsBeforeCancellation, "cancellation must not add a reset")
    }

    func testCancellationDuringRetryDelayPreservesOnlyPreDelayReset() async throws {
        let scheduler = VirtualDeadlineScheduler()
        let client = AsyncExecutorClient(failures: 1)
        let handler = AsyncExecutorRecovery()
        let executor = makeExecutor(client: client, handler: handler, scheduler: scheduler)
        let task = Task { try await executor.execute() }
        try await scheduler.registered.wait(for: 1)
        let resetsBeforeCancellation = client.resetSessionCount
        XCTAssertEqual(resetsBeforeCancellation, 1, "session already reset before the delay")
        task.cancel()
        await assertTransportCancellation(task)
        XCTAssertEqual(client.executions.count, 1)
        XCTAssertEqual(handler.calls.count, 0)
        XCTAssertEqual(scheduler.pendingCount, 0)
        XCTAssertEqual(client.resetSessionCount, resetsBeforeCancellation, "cancellation must not add a reset")
    }

    func testCancellationDuringRecoveryDoesNotResetSessionRetryOrResume() async throws {
        let client = AsyncExecutorClient(planFailure: true)
        let handler = AsyncExecutorRecovery(pause: true)
        let executor = makeExecutor(client: client, handler: handler)
        let task = Task { try await executor.execute() }
        try await handler.calls.wait(for: 1)
        let resetsBeforeCancellation = client.resetSessionCount
        XCTAssertEqual(resetsBeforeCancellation, 0)
        task.cancel()
        await assertTransportCancellation(task)
        XCTAssertEqual(handler.calls.count, 1)
        XCTAssertEqual(client.executions.count, 1)
        XCTAssertEqual(client.resetSessionCount, resetsBeforeCancellation, "cancellation must not add a reset")
    }

    func testSessionIsCapturedBeforeSuspensionAndARetryRunsUnderAFreshOneThatSurvivesRecoveryAndResume() async throws {
        let scheduler = VirtualDeadlineScheduler()
        let provider = ExecutorSessionProbe()
        let client = AsyncExecutorClient(failures: 1, planFailure: true, pauseInitialize: true)
        let handler = AsyncExecutorRecovery()
        let executor = makeExecutor(
            client: client,
            handler: handler,
            scheduler: scheduler,
            idGenerator: { provider.generate() }
        )
        let task = Task { try await executor.execute() }
        try await client.initializations.wait(for: 1)
        XCTAssertEqual(provider.calls, 1, "identity must be captured before initialize suspends")
        client.initializeGate.resume(returning: ())
        try await scheduler.registered.wait(for: 1)
        scheduler.advance(by: 10)
        let result = try await task.value
        XCTAssertTrue(result.success)
        XCTAssertTrue(result.aiRecoverySuccessful)
        // The transient retry runs under a fresh session (#11072); recovery and the resume keep it.
        XCTAssertEqual(provider.calls, 2)
        XCTAssertEqual(
            client.sessions,
            ["generated-session-1", "generated-session-1"] + Array(repeating: "generated-session-2", count: 4)
        )
        XCTAssertEqual(handler.sessions, ["generated-session-2"])
        XCTAssertEqual(client.executions.count, 3, "initial error, retry failure, recovery resume")
        XCTAssertEqual(client.resetSessionCount, 1)
    }

    private func makeExecutor(
        client: AsyncExecutorClient,
        handler: AsyncExecutorRecovery,
        retries: Int = 2,
        scheduler: any DeadlineScheduler = VirtualDeadlineScheduler(),
        transport: AutoMobilePlanExecutor.Transport = .daemonUnixSocket(path: "/unused/async-executor.sock"),
        daemonEnsurer: any AutoMobileDaemonEnsuring = AsyncExecutorDaemonEnsurer(),
        idGenerator: @escaping @Sendable () -> String = { UUID().uuidString }
    )
        -> AutoMobilePlanExecutor
    {
        // The injected client does no transport I/O. The default custom inert socket exercises
        // pre-retry resets; the injected daemon ensurer prevents accidental use of a live daemon.
        AutoMobilePlanExecutor(
            configuration: .init(
                transport: transport,
                planPath: "unused",
                retryCount: retries,
                retryDelaySeconds: 10
            ),
            planLoader: AsyncExecutorPlanLoader(),
            mcpClient: client,
            timer: FakeTimer(),
            logger: AsyncExecutorLogger(),
            recoveryHandler: handler,
            recoveryConfigProvider: StaticRecoveryConfigProvider(),
            recoveryModelConfig: nil,
            daemonEnsurer: daemonEnsurer,
            deadlineScheduler: scheduler,
            idGenerator: idGenerator,
            heldSessionController: RecordingHeldSessionController()
        )
    }
}

/// Configured before launch and touched again only after the detached body completes. XCTestCase
/// itself is not Sendable; this hermetic fixture confines its mutable hooks to that lifecycle.
private final class HermeticPlanTestCase: AutoMobileTestCase, @unchecked Sendable {
    override var planPath: String { "unused" }

    @objc
    func planBody() {}
}

private struct AsyncExecutorPlanLoader: AutoMobilePlanLoading {
    func loadPlan(at _: String, bundle _: Bundle?) throws -> String {
        "name: Async Plan\nsteps:\n  - tool: observe\n  - tool: tapOn"
    }
}

private struct AsyncExecutorLogger: AutoMobileLogger {
    func info(_: String) {}
    func warn(_: String) {}
    func error(_: String) {}
}

private struct AsyncExecutorDaemonEnsurer: AutoMobileDaemonEnsuring {
    func ensureDaemonRunning(repoRoot _: String?) -> Bool {
        XCTFail("A unit test must never ensure a live daemon")
        return false
    }
}

/// Only this fake blocks: the async test waits for events and always releases the semaphore.
private final class BlockingExecutorDaemonEnsurer: AutoMobileDaemonEnsuring {
    private struct State: Sendable {
        var calls = 0
        var blocked = false
    }

    private let state = OSAllocatedUnfairLock(initialState: State())
    private let semaphore = DispatchSemaphore(value: 0)
    private let blockOnCall: Int
    let entered = TransportEvents()
    let finished = TransportEvents()
    var isBlocked: Bool { state.withLock { $0.blocked } }

    init(blockOnCall: Int = 1) { self.blockOnCall = blockOnCall }

    func ensureDaemonRunning(repoRoot _: String?) -> Bool {
        let shouldBlock = state.withLock { current in
            current.calls += 1
            current.blocked = current.calls == blockOnCall
            return current.blocked
        }
        entered.signal()
        if shouldBlock { semaphore.wait() }
        state.withLock { $0.blocked = false }
        finished.signal()
        return true
    }

    func release() { semaphore.signal() }
}

private final class ExecutorSessionProbe: Sendable {
    private let state = OSAllocatedUnfairLock(initialState: 0)
    var calls: Int { state.withLock { $0 } }

    func generate() -> String {
        state.withLock {
            $0 += 1
            return "generated-session-\($0)"
        }
    }
}

private final class AsyncExecutorRecovery: PlanRecoveryHandler {
    let calls = TransportEvents()
    let gate = SingleResumeCell<Void>()
    private let pause: Bool
    private let storedSessions = OSAllocatedUnfairLock<[String?]>(initialState: [])
    var sessions: [String?] { storedSessions.withLock { $0 } }

    init(pause: Bool = false) { self.pause = pause }

    func attemptRecovery(_ context: FailedStepContext) async -> RecoveryOutcome {
        let shouldPause = storedSessions.withLock {
            $0.append(context.sessionUuid)
            return pause && $0.count == 1
        }
        calls.signal()
        do {
            if shouldPause { try await gate.wait() }
            try Task.checkCancellation()
            return RecoveryOutcome(success: true)
        } catch {
            XCTAssertTrue(error is CancellationError, "unexpected fake recovery error: \(error)")
            return RecoveryOutcome(success: false)
        }
    }
}

private final class AsyncExecutorClient: AutoMobileMCPClient {
    private struct State: Sendable {
        var testClasses: [String?] = []
        var testMethods: [String?] = []
        var names: [String] = []
        var sessions: [String?] = []
        var resetSessionCount = 0
        var failures: Int
        var planFailure: Bool
        var pauseNextInitialization: Bool
        var pauseNextExecution: Bool
    }

    private let state: OSAllocatedUnfairLock<State>
    private let cancellationError: Bool
    let initializations = TransportEvents()
    let executions = TransportEvents()
    let cancellations = TransportEvents()
    let initializeGate = SingleResumeCell<Void>()
    let callGate = SingleResumeCell<Void>()
    var testClasses: [String?] { state.withLock { $0.testClasses } }
    var testMethods: [String?] { state.withLock { $0.testMethods } }
    var names: [String] { state.withLock { $0.names } }
    var sessions: [String?] { state.withLock { $0.sessions } }
    var resetSessionCount: Int { state.withLock { $0.resetSessionCount } }

    init(
        failures: Int = 0,
        planFailure: Bool = false,
        pauseCall: Bool = false,
        pauseInitialize: Bool = false,
        cancellationError: Bool = false
    ) {
        state = OSAllocatedUnfairLock(initialState: State(
            failures: failures,
            planFailure: planFailure,
            pauseNextInitialization: pauseInitialize,
            pauseNextExecution: pauseCall
        ))
        self.cancellationError = cancellationError
    }

    func initialize(timeout _: TimeInterval) async throws {
        // Each cell can be waited on once, even when retries or recovery initialize again.
        let shouldPause = state.withLock { current in
            let shouldPause = current.pauseNextInitialization
            current.pauseNextInitialization = false
            return shouldPause
        }
        initializations.signal()
        if shouldPause { try await initializeGate.wait() }
        try Task.checkCancellation()
    }

    func callTool(name: String, arguments: [String: Any], timeout _: TimeInterval) async throws -> MCPToolResponse {
        // Record only Sendable routing values, never retain the dynamic wire dictionary.
        let sessionUuid = arguments["sessionUuid"] as? String
        let metadata = arguments["testMetadata"] as? [String: Any]
        let testClass = metadata?["testClass"] as? String
        let testMethod = metadata?["testMethod"] as? String
        let response = state.withLock { current -> Result<MCPToolResponse, any Error> in
            current.names.append(name)
            current.sessions.append(sessionUuid)
            if name != "executePlan" { return .success(MCPToolResponse(text: "{}")) }
            current.testClasses.append(testClass)
            current.testMethods.append(testMethod)
            if cancellationError { return .failure(CancellationError()) }
            if current.failures > 0 {
                current.failures -= 1
                return .failure(MCPClientError.requestFailed("timeout"))
            }
            if current.planFailure {
                current.planFailure = false
                return .success(
                    MCPToolResponse(
                        text: #"{"success":false,"executedSteps":0,"totalSteps":2,"failedStep":{"stepIndex":0,"tool":"observe","error":"broken","device":"fake-device"}}"#
                    )
                )
            }
            return .success(MCPToolResponse(text: #"{"success":true,"executedSteps":2,"totalSteps":2}"#))
        }
        if name == "executePlan" {
            let shouldPause = state.withLock { current in
                let shouldPause = current.pauseNextExecution
                current.pauseNextExecution = false
                return shouldPause
            }
            executions.signal()
            if shouldPause {
                try await withTaskCancellationHandler {
                    try await callGate.wait()
                } onCancel: {
                    self.cancellations.signal()
                }
            }
        }
        try Task.checkCancellation()
        return try response.get()
    }

    func readResource(uri _: String, timeout _: TimeInterval) async throws -> MCPResourceResponse {
        XCTFail("Static config must not read daemon resources")
        return MCPResourceResponse(text: "{}")
    }

    func resetSession() { state.withLock { $0.resetSessionCount += 1 } }
}
