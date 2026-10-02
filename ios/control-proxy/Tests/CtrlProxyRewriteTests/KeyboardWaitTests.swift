@testable import CtrlProxyRewrite
import Foundation
import os
import XCTest

/// A single-sleeper clock: automatic sleeps advance instantly; manual sleeps suspend
/// until released or cancelled. No wall time, actor blocking, or unchecked Sendable.
private final class KeyboardTestClock: Clock, Sendable {
    struct Instant: InstantProtocol {
        let offset: Duration

        func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
        func duration(to other: Instant) -> Duration { other.offset - offset }
        static func < (lhs: Instant, rhs: Instant) -> Bool { lhs.offset < rhs.offset }
    }

    private struct State {
        var now = Instant(offset: .zero)
        var sleeps: [Duration] = []
        var pending: CheckedContinuation<Void, any Error>?
        var deadline: Instant?
        var enteredSleep = false
        var observers: [CheckedContinuation<Void, Never>] = []
        var cancelled = false
    }

    private let state = OSAllocatedUnfairLock(initialState: State())
    private let manual: Bool
    private let sleepOvershoot: Duration

    init(manual: Bool = false, sleepOvershoot: Duration = .zero) {
        self.manual = manual
        self.sleepOvershoot = sleepOvershoot
    }

    var now: Instant { state.withLock { $0.now } }
    var minimumResolution: Duration { .nanoseconds(1) }
    var sleeps: [Duration] { state.withLock { $0.sleeps } }
    var elapsedMs: Int64 {
        let elapsed = now.offset.components
        return elapsed.seconds * 1000 + elapsed.attoseconds / 1_000_000_000_000_000
    }

    func advance(by duration: Duration) {
        state.withLock { $0.now = $0.now.advanced(by: duration) }
    }

    func sleep(until deadline: Instant, tolerance _: Duration?) async throws {
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                state.withLock {
                    guard !$0.cancelled else {
                        continuation.resume(throwing: CancellationError())
                        return
                    }
                    $0.sleeps.append($0.now.duration(to: deadline))
                    $0.enteredSleep = true
                    if manual {
                        precondition($0.pending == nil)
                        $0.pending = continuation
                        $0.deadline = deadline
                    } else {
                        $0.now = deadline.advanced(by: sleepOvershoot)
                        continuation.resume()
                    }
                    for observer in $0.observers {
                        observer.resume()
                    }
                    $0.observers.removeAll()
                }
            }
        } onCancel: {
            self.state.withLock {
                $0.cancelled = true
                $0.pending?.resume(throwing: CancellationError())
                $0.pending = nil
            }
        }
    }

    func waitUntilSleeping() async {
        await withCheckedContinuation { continuation in
            state.withLock {
                if $0.enteredSleep {
                    continuation.resume()
                } else {
                    $0.observers.append(continuation)
                }
            }
        }
    }

    func release() {
        state.withLock {
            if let deadline = $0.deadline { $0.now = deadline }
            $0.pending?.resume()
            $0.pending = nil
            $0.deadline = nil
        }
    }
}

@MainActor
final class KeyboardWaitTests: XCTestCase {
    private enum ProbeError: Error { case failed }

    func testFocusSucceedsWithoutSleepingAfterSuccess() async throws {
        let clock = KeyboardTestClock()
        var probes = 0
        let result = try await KeyboardWait.focus(clock: clock, tap: {
            clock.advance(by: .milliseconds(25))
        }, probe: {
            probes += 1
            return (probes == 4, "strategy-\(probes)")
        })

        XCTAssertTrue(result.hasFocus)
        XCTAssertEqual(result.strategy, "strategy-4")
        XCTAssertEqual(result.iterations, 4)
        XCTAssertEqual(clock.sleeps, Array(repeating: .milliseconds(50), count: 3))
        XCTAssertEqual(result.elapsedMs, 175)
    }

    func testFocusTimeoutIncludesFinalProbeAndPostTapBudget() async throws {
        let clock = KeyboardTestClock()
        var probes = 0
        let result = try await KeyboardWait.focus(clock: clock, tap: {
            clock.advance(by: .seconds(2))
        }, probe: {
            probes += 1
            return (false, "strategy-\(probes)")
        })

        // Reference cadence: check deadline, probe, then always sleep on failure.
        var oldElapsed = Duration.zero
        var oldIterations = 0
        while oldElapsed < .milliseconds(500) {
            oldIterations += 1
            oldElapsed += .milliseconds(50)
        }
        XCTAssertFalse(result.hasFocus)
        XCTAssertEqual(result.iterations, oldIterations + 1)
        XCTAssertEqual(result.strategy, "strategy-\(oldIterations + 1)")
        XCTAssertEqual(result.iterations, 11)
        XCTAssertEqual(clock.sleeps, Array(repeating: .milliseconds(50), count: oldIterations))
        XCTAssertEqual(result.elapsedMs, 2500)
    }

    func testFocusArrivesDuringSleepThatOverrunsDeadline() async throws {
        // Model a main-actor hierarchy walk delaying the first 50ms sleep until 600ms.
        let clock = KeyboardTestClock(sleepOvershoot: .milliseconds(550))
        let result = try await KeyboardWait.focus(clock: clock, tap: {}, probe: {
            let hasFocus = clock.elapsedMs >= 100
            if hasFocus { clock.advance(by: .milliseconds(25)) }
            return (hasFocus, hasFocus ? "final-snapshot" : "none")
        })

        XCTAssertTrue(result.hasFocus)
        XCTAssertEqual(result.strategy, "final-snapshot")
        XCTAssertEqual(result.iterations, 2)
        XCTAssertEqual(clock.sleeps, [.milliseconds(50)])
        XCTAssertEqual(result.elapsedMs, 625, "Elapsed time includes the final probe")
    }

    func testFocusNeverArrivesDuringSleepThatOverrunsDeadline() async throws {
        let clock = KeyboardTestClock(sleepOvershoot: .milliseconds(550))
        var probes = 0
        let result = try await KeyboardWait.focus(clock: clock, tap: {}, probe: {
            probes += 1
            return (false, "strategy-\(probes)")
        })

        XCTAssertFalse(result.hasFocus)
        XCTAssertEqual(result.strategy, "strategy-2")
        XCTAssertEqual(result.iterations, 2)
        XCTAssertEqual(probes, 2)
        XCTAssertEqual(clock.sleeps, [.milliseconds(50)])
        XCTAssertEqual(result.elapsedMs, 600)
    }

    func testVisibilityTimeoutReturnsLastObservation() async throws {
        for expected in [false, true] {
            let clock = KeyboardTestClock()
            var probes = 0
            let visible = try await KeyboardWait.visibility(clock: clock, expected: expected) {
                probes += 1
                return !expected
            }
            XCTAssertEqual(visible, !expected)
            XCTAssertEqual(probes, 21)
            XCTAssertEqual(clock.sleeps, Array(repeating: .milliseconds(50), count: 20))
        }
    }

    func testVisibilityObservesSuccessAtDeadline() async throws {
        let clock = KeyboardTestClock()
        var probes = 0
        let visible = try await KeyboardWait.visibility(clock: clock, expected: true) {
            probes += 1
            return clock.elapsedMs == 1000
        }
        XCTAssertTrue(visible)
        XCTAssertEqual(probes, 21)
        XCTAssertEqual(clock.sleeps.count, 20)
    }

    func testVisibilityAlreadyMatchesWithoutSleeping() async throws {
        let clock = KeyboardTestClock()
        let visible = try await KeyboardWait.visibility(clock: clock, expected: true) { true }
        XCTAssertTrue(visible)
        XCTAssertTrue(clock.sleeps.isEmpty)
    }

    func testProbeErrorsPropagate() async {
        let clock = KeyboardTestClock()
        do {
            _ = try await KeyboardWait.focus(clock: clock, tap: {}, probe: { throw ProbeError.failed })
            XCTFail("Focus probe error was swallowed")
        } catch {
            XCTAssertTrue(error is ProbeError)
        }
        do {
            _ = try await KeyboardWait.visibility(clock: clock, expected: true) { throw ProbeError.failed }
            XCTFail("Visibility probe error was swallowed")
        } catch {
            XCTAssertTrue(error is ProbeError)
        }
        XCTAssertTrue(clock.sleeps.isEmpty)
    }

    func testCancellationDuringSleepStopsBothPollers() async {
        for focus in [true, false] {
            let clock = KeyboardTestClock(manual: true)
            var probes = 0
            let task = Task { @MainActor in
                if focus {
                    return try await KeyboardWait.focus(clock: clock, tap: {}, probe: {
                        probes += 1
                        return (false, "none")
                    }).hasFocus
                }
                return try await KeyboardWait.visibility(clock: clock, expected: true) {
                    probes += 1
                    return false
                }
            }
            await clock.waitUntilSleeping()
            task.cancel()
            do {
                _ = try await task.value
                XCTFail("Cancellation was swallowed")
            } catch {
                XCTAssertTrue(error is CancellationError)
            }
            XCTAssertEqual(probes, 1)
            XCTAssertEqual(clock.sleeps, [.milliseconds(50)])
        }
    }

    func testMainActorMakesProgressWhileFocusWaitIsSuspended() async throws {
        let clock = KeyboardTestClock(manual: true)
        var probes = 0
        let task = Task { @MainActor in
            try await KeyboardWait.focus(clock: clock, tap: {}, probe: {
                probes += 1
                return (probes == 2, "snapshot")
            })
        }
        await clock.waitUntilSleeping()
        var progress = 0
        await Task { @MainActor in progress += 1 }.value
        XCTAssertEqual(progress, 1)
        XCTAssertEqual(probes, 1, "The poller must remain suspended until release")
        clock.release()
        let result = try await task.value
        XCTAssertTrue(result.hasFocus)
        XCTAssertEqual(result.iterations, 2)
    }

    func testTaskLocalSurvivesAwaitedKeyboardWait() async throws {
        // Guards a task-local surviving an await in general, not production setText coverage.
        let clock = KeyboardTestClock()
        let sink = FakeGestureLogSink()
        let diagnostics = GesturePhaseDiagnostics(
            command: "request_swipe",
            receivedAtMs: 0,
            deadlineMs: nil,
            now: { clock.elapsedMs },
            sink: sink
        )
        try await GesturePhaseDiagnostics.$current.withValue(diagnostics) {
            GesturePhaseDiagnostics.current?.begin("x")
            var probes = 0
            _ = try await KeyboardWait.focus(clock: clock, tap: {}, probe: {
                probes += 1
                return (probes == 4, "snapshot")
            })
            XCTAssertTrue(GesturePhaseDiagnostics.current === diagnostics)
            GesturePhaseDiagnostics.current?.begin("y")
        }
        let timing = diagnostics.finish()
        XCTAssertEqual(timing.children?.first { $0.name == "x" }?.durationMs, 150)
        XCTAssertEqual(timing.durationMs, clock.elapsedMs)
        XCTAssertTrue(sink.lines.isEmpty)
    }

    func testIOSWrappersUseAsyncPollerWithoutRunLoopOrWallClock() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = try String(
            contentsOf: packageRoot.appendingPathComponent("Sources/CtrlProxyRewrite/GesturePerformer.swift"),
            encoding: .utf8
        )
        for (name, poller) in [
            ("tapAndAwaitKeyboardFocus", "KeyboardWait.focus("),
            ("waitForKeyboardVisibility", "KeyboardWait.visibility("),
        ] {
            let start = try XCTUnwrap(source.range(of: "private func \(name)("))
            let remaining = source[start.upperBound...]
            let end = try XCTUnwrap(remaining.range(of: "\n        private "))
            let function = String(source[start.lowerBound ..< end.lowerBound])
            XCTAssertTrue(function.contains("async throws"))
            XCTAssertTrue(function.contains("try await " + poller))
            XCTAssertFalse(function.contains("RunLoop.current.run"))
            XCTAssertFalse(function.contains("Date()"))
        }
    }
}
