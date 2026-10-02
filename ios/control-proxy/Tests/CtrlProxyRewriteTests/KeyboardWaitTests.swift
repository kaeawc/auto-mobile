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

    func testCloseSucceedsBeforeTimeout() async throws {
        let clock = KeyboardTestClock()
        var probes = 0
        let closed = try await KeyboardWait.close(
            clock: clock, closeDeadline: clock.now.advanced(by: .milliseconds(3500))
        ) {
            probes += 1
            return probes < 4
        }
        XCTAssertTrue(closed)
        XCTAssertEqual(probes, 4)
        XCTAssertEqual(clock.sleeps, Array(repeating: .milliseconds(100), count: 3))
        XCTAssertEqual(clock.elapsedMs, 300)
    }

    func testCloseTimeoutMatchesOldLoopIncludingShortenedLastSleep() async throws {
        for start in [Duration.zero, .milliseconds(3150)] {
            let clock = KeyboardTestClock()
            let closeDeadline = clock.now.advanced(by: .milliseconds(3500))
            clock.advance(by: start)
            var probes = 0
            let closed = try await KeyboardWait.close(clock: clock, closeDeadline: closeDeadline) {
                probes += 1
                return true
            }

            // Old loop: visibility first (including after the final sleep), then
            // closePollDelay = min(100ms, min(attemptDeadline, closeDeadline) - now).
            var oldElapsed = start
            let oldAttemptDeadline = min(start + .milliseconds(600), .milliseconds(3500))
            var oldProbes = 0
            var oldSleeps: [Duration] = []
            var oldClosed = true
            while true {
                oldProbes += 1 // isKeyboardVisible is always true in this reference.
                let remaining = min(oldAttemptDeadline, .milliseconds(3500)) - oldElapsed
                guard remaining > .zero else {
                    oldClosed = false
                    break
                }
                let delay = min(.milliseconds(100), remaining)
                oldSleeps.append(delay)
                oldElapsed += delay
            }
            XCTAssertEqual(closed, oldClosed)
            XCTAssertFalse(closed)
            XCTAssertEqual(probes, oldProbes)
            XCTAssertEqual(clock.sleeps, oldSleeps)
            XCTAssertEqual(clock.now.offset, oldElapsed)
            if start == .zero {
                XCTAssertEqual(probes, 7)
                XCTAssertEqual(clock.elapsedMs, 600)
            } else {
                XCTAssertEqual(clock.sleeps.last, .milliseconds(50))
                XCTAssertEqual(clock.elapsedMs, 3500)
            }
        }
    }

    func testClosePollDelayRespectsAttemptAndWholeActionDeadlines() {
        func instant(_ milliseconds: Int64) -> KeyboardTestClock.Instant {
            KeyboardTestClock.Instant(offset: .milliseconds(milliseconds))
        }
        XCTAssertEqual(KeyboardWait.closePollDelay(
            now: instant(1000), attemptDeadline: instant(1600), closeDeadline: instant(4500)
        ), .milliseconds(100))
        XCTAssertEqual(KeyboardWait.closePollDelay(
            now: instant(1550), attemptDeadline: instant(1600), closeDeadline: instant(4500)
        ), .milliseconds(50))
        XCTAssertEqual(KeyboardWait.closePollDelay(
            now: instant(4450), attemptDeadline: instant(5000), closeDeadline: instant(4500)
        ), .milliseconds(50))
        XCTAssertNil(KeyboardWait.closePollDelay(
            now: instant(1600), attemptDeadline: instant(1600), closeDeadline: instant(4500)
        ))
        XCTAssertNil(KeyboardWait.closePollDelay(
            now: instant(4500), attemptDeadline: instant(5000), closeDeadline: instant(4500)
        ))
    }

    func testCloseProbesBeforeCheckingExpiredBudget() async throws {
        for visible in [true, false] {
            let clock = KeyboardTestClock()
            var probes = 0
            let closed = try await KeyboardWait.close(clock: clock, closeDeadline: clock.now) {
                probes += 1
                return visible
            }
            XCTAssertEqual(closed, !visible)
            XCTAssertEqual(probes, 1)
            XCTAssertTrue(clock.sleeps.isEmpty)
        }
    }

    func testDestructivePostConditionSucceedsBeforeTimeout() async throws {
        let clock = KeyboardTestClock()
        var probes = 0
        let satisfied = try await KeyboardWait.destructivePostCondition(clock: clock) {
            probes += 1
            return probes == 4
        }
        XCTAssertTrue(satisfied)
        XCTAssertEqual(probes, 4)
        XCTAssertEqual(clock.sleeps, Array(repeating: .milliseconds(50), count: 3))
        XCTAssertEqual(clock.elapsedMs, 150)
    }

    func testDestructivePostConditionTimeoutMatchesOldLoopAndFinalRead() async throws {
        let clock = KeyboardTestClock()
        var probes = 0
        let satisfied = try await KeyboardWait.destructivePostCondition(clock: clock) {
            probes += 1
            return false
        }
        // Old loop: check the deadline, exists/value read, then a full 50ms sleep.
        // On timeout it always performs one final exists/value read.
        var oldElapsed = Duration.zero
        var oldProbes = 0
        var oldSleeps: [Duration] = []
        while oldElapsed < .seconds(1) {
            oldProbes += 1
            oldSleeps.append(.milliseconds(50))
            oldElapsed += .milliseconds(50)
        }
        oldProbes += 1
        let oldSatisfied = false
        XCTAssertEqual(satisfied, oldSatisfied)
        XCTAssertFalse(satisfied)
        XCTAssertEqual(probes, oldProbes)
        XCTAssertEqual(probes, 21)
        XCTAssertEqual(clock.sleeps, oldSleeps)
        XCTAssertEqual(clock.now.offset, oldElapsed)
        XCTAssertEqual(clock.elapsedMs, 1000)
    }

    func testRemainingWaitsObserveSuccessDuringOverrunningSleep() async throws {
        for close in [true, false] {
            let clock = KeyboardTestClock(sleepOvershoot: .seconds(1))
            var probes = 0
            let result: Bool
            if close {
                result = try await KeyboardWait.close(
                    clock: clock, closeDeadline: clock.now.advanced(by: .milliseconds(3500))
                ) {
                    probes += 1
                    return clock.elapsedMs < 600
                }
            } else {
                result = try await KeyboardWait.destructivePostCondition(clock: clock) {
                    probes += 1
                    return clock.elapsedMs >= 1000
                }
            }
            XCTAssertTrue(result)
            XCTAssertEqual(probes, 2)
            XCTAssertEqual(clock.sleeps, [close ? .milliseconds(100) : .milliseconds(50)])
            XCTAssertEqual(clock.elapsedMs, close ? 1100 : 1050)
        }
    }

    func testRemainingWaitsPropagateInitialAndFinalProbeErrors() async {
        for close in [true, false] {
            for finalProbe in [false, true] {
                let clock = KeyboardTestClock(sleepOvershoot: .seconds(1))
                var probes = 0
                let probe = {
                    probes += 1
                    if !finalProbe || probes == 2 { throw ProbeError.failed }
                    return close
                }
                do {
                    if close {
                        _ = try await KeyboardWait.close(
                            clock: clock, closeDeadline: clock.now.advanced(by: .milliseconds(3500)), probe: probe
                        )
                    } else {
                        _ = try await KeyboardWait.destructivePostCondition(clock: clock, probe: probe)
                    }
                    XCTFail("Probe error was swallowed")
                } catch {
                    XCTAssertTrue(error is ProbeError)
                }
                XCTAssertEqual(probes, finalProbe ? 2 : 1)
                XCTAssertEqual(clock.sleeps, finalProbe ? [close ? .milliseconds(100) : .milliseconds(50)] : [])
            }
        }
    }

    func testRemainingWaitsPropagateCancellationDuringSleep() async {
        for close in [true, false] {
            let clock = KeyboardTestClock(manual: true)
            var probes = 0
            let task = Task { @MainActor in
                if close {
                    return try await KeyboardWait.close(
                        clock: clock, closeDeadline: clock.now.advanced(by: .milliseconds(3500))
                    ) {
                        probes += 1
                        return true
                    }
                }
                return try await KeyboardWait.destructivePostCondition(clock: clock) {
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
            XCTAssertEqual(clock.sleeps, [close ? .milliseconds(100) : .milliseconds(50)])
        }
    }

    func testMainActorMakesProgressWhileRemainingWaitsAreSuspended() async throws {
        for close in [true, false] {
            let clock = KeyboardTestClock(manual: true)
            var probes = 0
            let task = Task { @MainActor in
                if close {
                    return try await KeyboardWait.close(
                        clock: clock, closeDeadline: clock.now.advanced(by: .milliseconds(3500))
                    ) {
                        probes += 1
                        return probes < 2
                    }
                }
                return try await KeyboardWait.destructivePostCondition(clock: clock) {
                    probes += 1
                    return probes == 2
                }
            }
            await clock.waitUntilSleeping()
            var progress = 0
            await Task { @MainActor in progress += 1 }.value
            XCTAssertEqual(progress, 1)
            XCTAssertEqual(probes, 1)
            clock.release()
            let result = try await task.value
            XCTAssertTrue(result)
            XCTAssertEqual(probes, 2)
            XCTAssertEqual(clock.sleeps, [close ? .milliseconds(100) : .milliseconds(50)])
        }
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
            ("waitForKeyboardClose<C: Clock>", "KeyboardWait.close("),
            ("performPressKey", "KeyboardWait.destructivePostCondition("),
        ] {
            let start = try XCTUnwrap(source.range(of: "private func \(name)("))
            let remaining = source[start.upperBound...]
            let end = try XCTUnwrap(remaining.range(of: "\n        private "))
            let function = String(source[start.lowerBound ..< end.lowerBound])
            XCTAssertTrue(function.contains("async throws"))
            XCTAssertTrue(function.contains("try await " + poller))
            XCTAssertFalse(function.contains("RunLoop.current.run"))
            XCTAssertFalse(function.contains("Date()"))
            if name == "performPressKey" {
                // The horizontal-arrow budget is intentionally unchanged.
                let pollStart = try XCTUnwrap(function.range(of: "var valueAfterKeyPress = valueBeforeKeyPress"))
                XCTAssertFalse(function[pollStart.lowerBound...].contains("systemUptime"))
                XCTAssertTrue(function.contains("catchingObjCException({ focusedElement.exists })"))
            } else {
                XCTAssertFalse(function.contains("systemUptime"))
            }
        }
        let closeStart = try XCTUnwrap(source.range(of: "private func closeKeyboard<C: Clock>("))
        let closeEnd = try XCTUnwrap(source[closeStart.upperBound...].range(of: "\n        @discardableResult"))
        let closeAction = String(source[closeStart.lowerBound ..< closeEnd.lowerBound])
        XCTAssertTrue(closeAction.contains("clock.now.advanced(by: .milliseconds(3500))"))
        XCTAssertEqual(closeAction.components(separatedBy: "guard clock.now < closeDeadline").count - 1, 3)
        XCTAssertTrue(closeAction.contains("try await waitForKeyboardClose("))
        for forbidden in ["RunLoop.current.run", "Date()", "systemUptime"] {
            XCTAssertFalse(closeAction.contains(forbidden))
        }
    }
}
