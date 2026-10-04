@testable import CtrlProxyRewrite
import Foundation
import os
import XCTest

/// A `@MainActor` collaborator that records a nested perf block, standing in for the rewrite's
/// `@MainActor` `ElementLocator` (Phase 4F): a command's perf scope is opened on the command path
/// and must still nest a sub-block opened after the request hops to the main actor. Asserts it is
/// genuinely main-actor-isolated so the hop cannot be silently optimized to a same-executor call.
@MainActor
private func recordNestedBlockOnMainActor(_ provider: PerfProvider, clock: FakeTimeProvider) {
    MainActor.assertIsolated("the nested sub-block must run on the main actor")
    provider.serial("mainActorChild")
    clock.advance(by: 3)
    provider.end()
}

final class PerfProviderTests: XCTestCase {
    // MARK: - Scope propagation across actor hops

    /// A hierarchy request opens its perf scope on the command path, then `await`s into the
    /// `@MainActor` `ElementLocator`, which opens a sub-block. The task-local scope ID must survive
    /// that executor boundary so the interval ledger can attach the sub-block to its parent.
    ///
    /// Fail-closed: the outer scope runs inside a `Task.detached` (which drops all isolation, so it
    /// executes on the cooperative pool, never the main thread — even if this class were later
    /// annotated `@MainActor`) and the sub-block is pinned to `MainActor`. The hop is therefore a
    /// real executor boundary regardless of test-runner scheduling; losing the scope ID there
    /// would split the intervals and fail `roots.count == 1`.
    func testScopeNestsAcrossMainActorHop() async throws {
        let clock = FakeTimeProvider()
        let provider = PerfProvider(timeProvider: clock)

        // `withScope` binds the interval scope on the detached task; the `await` into the `@MainActor`
        // sub-block is a genuine cross-executor hop within that one task.
        let timings = await Task.detached { () -> [PerfTiming]? in
            await provider.withScope { () async -> [PerfTiming]? in
                XCTAssertFalse(Thread.isMainThread, "the outer scope must run off the main thread")
                provider.serial("outer")
                clock.advance(by: 1)
                await recordNestedBlockOnMainActor(provider, clock: clock) // hops to @MainActor
                clock.advance(by: 1)
                provider.end()
                return provider.flush()
            }
        }.value

        let roots = try XCTUnwrap(timings)
        XCTAssertEqual(roots.count, 1, "the main-actor sub-block must nest, not become a second root")
        XCTAssertEqual(roots[0].name, "outer")
        XCTAssertEqual(roots[0].durationMs, 5) // 1 (pre-hop) + 3 (in child) + 1 (post-hop)
        let children = try XCTUnwrap(roots[0].children)
        XCTAssertEqual(children.count, 1)
        XCTAssertEqual(children[0].name, "mainActorChild")
        XCTAssertEqual(children[0].durationMs, 3)
        XCTAssertNil(children[0].children)
    }

    // MARK: - track / trackAsync auto start/end

    /// `track` brackets a synchronous block with start/end, nesting a child under an outer block.
    func testTrackNestsSynchronously() throws {
        let clock = FakeTimeProvider()
        let provider = PerfProvider(timeProvider: clock)

        let timings = provider.withScope { () -> [PerfTiming]? in
            provider.track("outer") {
                clock.advance(by: 1)
                provider.track("inner") { clock.advance(by: 4) }
                clock.advance(by: 1)
            }
            return provider.flush()
        }

        let roots = try XCTUnwrap(timings)
        XCTAssertEqual(roots.map(\.name), ["outer"])
        XCTAssertEqual(roots[0].durationMs, 6) // 1 + 4 (inner) + 1
        let children = try XCTUnwrap(roots[0].children)
        XCTAssertEqual(children.map(\.name), ["inner"])
        XCTAssertEqual(children[0].durationMs, 4)
    }

    /// Lock the serialized `perfTiming` payload shape so interval recording preserves the wire
    /// representation, including omitted `children` on leaf intervals.
    func testNestedIntervalsKeepPerfTimingWireShape() throws {
        let clock = FakeTimeProvider()
        let provider = PerfProvider(timeProvider: clock)

        let timing = try XCTUnwrap(provider.withScope {
            provider.serial("root")
            clock.advance(by: 2)
            provider.serial("child")
            clock.advance(by: 3)
            provider.end()
            clock.advance(by: 3)
            provider.end()
            return provider.flush()?.first
        })
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(timing)

        XCTAssertEqual(
            String(decoding: data, as: UTF8.self),
            #"{"children":[{"durationMs":3,"name":"child"}],"durationMs":8,"name":"root"}"#
        )
    }

    /// `trackAsync` is the variant most exposed to the `@TaskLocal`/executor change: its `defer`
    /// `endOperation` must fire on the correct side of the `await`, and the scope must survive the
    /// suspension. A nested `trackAsync` must still nest under the outer one.
    func testTrackAsyncNestsAndClosesAcrossAwait() async throws {
        let clock = FakeTimeProvider()
        let provider = PerfProvider(timeProvider: clock)

        let timings = await provider.withScope { () async -> [PerfTiming]? in
            await provider.trackAsync("outerAsync") {
                clock.advance(by: 2)
                await provider.trackAsync("innerAsync") { clock.advance(by: 3) }
                clock.advance(by: 1)
            }
            return provider.flush()
        }

        let roots = try XCTUnwrap(timings)
        XCTAssertEqual(roots.map(\.name), ["outerAsync"])
        XCTAssertEqual(roots[0].durationMs, 6) // 2 + 3 (inner) + 1
        let children = try XCTUnwrap(roots[0].children)
        XCTAssertEqual(children.map(\.name), ["innerAsync"])
        XCTAssertEqual(children[0].durationMs, 3)
    }

    // MARK: - Safe no-op outside any scope

    /// Outside any `withScope`, the call-tree operations are safe no-ops (the task-local is nil):
    /// perf timing is diagnostic, not wire-critical, so imperative calls made before Phase 6 wires
    /// scopes must not crash or fabricate data.
    func testCallTreeOperationsAreNoOpsOutsideScope() {
        let provider = PerfProvider(timeProvider: FakeTimeProvider())
        provider.serial("orphan")
        provider.startOperation("orphan2")
        provider.end()
        provider.endOperation("orphan")
        XCTAssertFalse(provider.hasData)
        XCTAssertNil(provider.flush())
    }

    /// Debounce counters live in the shared pool, not the task-local scope, so `recordDebounce`
    /// works outside any scope and surfaces in `flush()`.
    func testDebounceRecordedOutsideScope() throws {
        let clock = FakeTimeProvider()
        let provider = PerfProvider(timeProvider: clock)
        provider.recordDebounce()
        clock.advance(by: 7)
        provider.recordDebounce()

        let roots = try XCTUnwrap(provider.flush())
        XCTAssertEqual(roots.count, 1)
        XCTAssertEqual(roots[0].name, "debounce")
        let children = try XCTUnwrap(roots[0].children)
        XCTAssertEqual(children.map(\.name), ["count", "lastTime"])
        XCTAssertEqual(children[0].durationMs, 2) // two debounces recorded
        XCTAssertEqual(children[1].durationMs, 7) // last debounce at t=7
    }

    // MARK: - Pool / scope lifecycle

    /// `flush()` drains the shared pool across scopes: a root completed in one scope is reported by
    /// a later `flush()` even from a different scope (the pooled-flush behavior the reference
    /// relied on so command-handling and background-polling timings report together).
    func testCompletedRootsPoolAcrossScopes() throws {
        let clock = FakeTimeProvider()
        let provider = PerfProvider(timeProvider: clock)

        provider.withScope {
            provider.serial("first")
            clock.advance(by: 2)
            provider.end()
        }
        let roots = try XCTUnwrap(provider.withScope { provider.flush() })
        XCTAssertEqual(roots.map(\.name), ["first"])
        XCTAssertEqual(roots[0].durationMs, 2)
    }

    /// Idle-client background polling retains only the newest completed roots in completion order.
    func testCompletedRootsPoolKeepsNewestRootsAtMaximumSize() throws {
        let clock = FakeTimeProvider()
        let provider = PerfProvider(timeProvider: clock)

        for i in 0 ..< 1000 {
            provider.withScope {
                provider.serial("root\(i)")
                clock.advance(by: 1)
                provider.end()
            }
        }

        let roots = try XCTUnwrap(provider.flush())
        let names = roots.map(\.name)
        XCTAssertEqual(roots.count, PerfProvider.maximumCompletedRoots)
        XCTAssertEqual(names, ((1000 - PerfProvider.maximumCompletedRoots) ..< 1000).map { "root\($0)" })
        XCTAssertFalse(names.contains("root0"))
    }

    /// A handler snapshot leaves its enclosing request open and does not consume roots completed
    /// by another scope before the server performs its top-level flush.
    func testNamedSnapshotPreservesOuterRequestAndSharedCompletedRoots() throws {
        let clock = FakeTimeProvider()
        let provider = PerfProvider(timeProvider: clock)

        try provider.withScope {
            provider.serial("handleRequest:hierarchy")
            clock.advance(by: 2)
            provider.serial("handleRequestHierarchy")
            clock.advance(by: 3)

            let snapshot = try XCTUnwrap(provider.snapshot("handleRequestHierarchy"))
            XCTAssertEqual(snapshot.name, "handleRequestHierarchy")
            XCTAssertEqual(snapshot.durationMs, 3)
            XCTAssertTrue(provider.hasData)

            // Simulate a separate request or poll completing between snapshot and top-level flush.
            provider.withScope {
                provider.serial("concurrent")
                clock.advance(by: 4)
                provider.end()
            }

            // The handler's own defer closes only its nested span; the enclosing request remains.
            provider.end()
            XCTAssertTrue(provider.hasData)
            clock.advance(by: 2)
            provider.end()

            let roots = try XCTUnwrap(provider.flush())
            XCTAssertEqual(roots.map(\.name), ["concurrent", "handleRequest:hierarchy"])
            XCTAssertEqual(roots[0].durationMs, 4)
            XCTAssertEqual(roots[1].durationMs, 11)
            XCTAssertEqual(try XCTUnwrap(roots[1].children).map(\.name), ["handleRequestHierarchy"])
        }
    }

    /// `clear()` wipes both the active scope and the shared pool.
    func testClearWipesScopeAndPool() {
        let clock = FakeTimeProvider()
        let provider = PerfProvider(timeProvider: clock)

        provider.withScope {
            provider.serial("a")
            clock.advance(by: 2)
            provider.end()
            provider.recordDebounce()
            provider.serial("openRoot") // left open on the scope
            provider.clear()
            XCTAssertFalse(provider.hasData)
            XCTAssertNil(provider.flush())
        }
    }

    /// `peek()` reports the open root plus pooled roots without clearing; `hasData` tracks both.
    func testPeekReflectsOpenRootWithoutClearing() throws {
        let clock = FakeTimeProvider()
        let provider = PerfProvider(timeProvider: clock)

        try provider.withScope {
            provider.serial("live")
            clock.advance(by: 4)
            XCTAssertTrue(provider.hasData)

            let peeked = provider.peek()
            XCTAssertEqual(peeked.map(\.name), ["live"])
            XCTAssertEqual(peeked[0].durationMs, 4) // open entry timed to "now"

            // peek() did not clear: flushing still yields the (now-closed) root.
            let flushed = try XCTUnwrap(provider.flush())
            XCTAssertEqual(flushed.map(\.name), ["live"])
        }
    }

    // MARK: - Sendability

    /// Compile-time proof that `PerfProvider` is genuinely `Sendable` (via `PerfTracking`), so the
    /// Phase-6 coordinator can share one instance across the command path and the `@MainActor` UI
    /// domain without `@unchecked`.
    func testPerfProviderIsSendable() {
        func requireSendable(_: some Sendable) {}
        requireSendable(PerfProvider(timeProvider: FakeTimeProvider()))
    }
}

final class FakeGestureLogSink: GestureLogSink, Sendable {
    private let storage = OSAllocatedUnfairLock(initialState: [String]())
    func warning(_ line: String) { storage.withLock { $0.append(line) } }
    var lines: [String] { storage.withLock { $0 } }
}

extension PerfProviderTests {
    func testSwipeAnnotationsRenderAtBoundAndFinishFromCurrentAndCompletedPhases() {
        let cases: [(SwipeDispatchMode, String?, String, Bool)] = [
            (.xcuitest, "com.test.playground", "xcuitestGesture", true),
            (.xcuitest, nil, "coordinateResolution", false),
            (.synthesizedLockScreen, nil, "synthesizedGesture", false),
            // Missing synthesis symbols can reach the ordinary XCUITest call.
            (.synthesizedLockScreen, "com.test.playground", "xcuitestGesture", true),
        ]
        for (dispatch, trackedApp, phase, entered) in cases {
            let clock = FakeMonotonicClock()
            let sink = FakeGestureLogSink()
            let diagnostics = GesturePhaseDiagnostics(
                command: "request_swipe", receivedAtMs: 0, deadlineMs: 5000,
                now: { clock.now() }, sink: sink
            )
            diagnostics.annotateSwipe(dispatch: dispatch, trackedApp: trackedApp)
            diagnostics.begin(phase)
            clock.advance(by: 250)
            diagnostics.markBoundExceeded(boundMs: 250)
            diagnostics.begin("postGesture")
            clock.advance(by: 50)
            diagnostics.finish()
            diagnostics.finish()
            let mode = dispatch == .xcuitest ? "xcuitest" : "synthesizedLockScreen"
            let fields = " dispatch=\(mode) trackedApp=\(trackedApp ?? "none") xcuitestEntered=\(entered)"
            XCTAssertEqual(sink.lines, [
                "gesture_phases command=request_swipe boundHit=true phaseAtBound=\(phase) boundMs=250 elapsedMs=250 deadlineRemainingMs=4750\(fields) (still running)",
                "gesture_phases command=request_swipe queueWaitMs=0 \(phase)Ms=250 postGestureMs=50 totalMs=300 deadlineRemainingMs=4700 phaseAtBound=\(phase)\(fields)",
            ])
        }
    }

    func testSwipeAnnotationsAreAbsentForOtherCommands() {
        let clock = FakeMonotonicClock()
        let sink = FakeGestureLogSink()
        let diagnostics = GesturePhaseDiagnostics(
            command: "request_tap_coordinates", receivedAtMs: 0, deadlineMs: nil,
            now: { clock.now() }, sink: sink
        )
        diagnostics.annotateSwipe(dispatch: .xcuitest, trackedApp: "com.test.app")
        diagnostics.begin("xcuitestGesture")
        clock.advance(by: 250)
        diagnostics.markBoundExceeded(boundMs: 250)
        diagnostics.finish()
        XCTAssertEqual(sink.lines, [
            "gesture_phases command=request_tap_coordinates boundHit=true phaseAtBound=xcuitestGesture boundMs=250 elapsedMs=250 deadlineRemainingMs=none (still running)",
            "gesture_phases command=request_tap_coordinates queueWaitMs=0 xcuitestGestureMs=250 totalMs=250 deadlineRemainingMs=none phaseAtBound=xcuitestGesture",
        ])
    }

    func testBoundRecordsEveryRunningPhaseAndLogsImmediateAndFinalOnce() {
        for phase in [
            "queueWait",
            "executionPreparation",
            "targetResolution",
            "coordinateResolution",
            "xcuitestGesture",
            "synthesizedGesture",
            "postGesture",
        ] {
            let clock = FakeMonotonicClock()
            let sink = FakeGestureLogSink()
            let diagnostics = GesturePhaseDiagnostics(
                command: "request_swipe",
                receivedAtMs: 0,
                deadlineMs: 5000,
                now: { clock.now() },
                sink: sink
            )
            diagnostics.begin(phase)
            clock.advance(by: 250)
            XCTAssertEqual(diagnostics.currentPhase, phase)
            let hit = diagnostics.markBoundExceeded(boundMs: 250)
            XCTAssertEqual(hit.phase, phase)
            XCTAssertEqual(hit.elapsedMs, 250)
            XCTAssertEqual(
                sink.lines,
                [
                    "gesture_phases command=request_swipe boundHit=true phaseAtBound=\(phase) boundMs=250 elapsedMs=250 deadlineRemainingMs=4750 (still running)",
                ]
            )
            diagnostics.begin("postGesture")
            diagnostics.markBoundExceeded(boundMs: 250)
            XCTAssertEqual(sink.lines.count, 1)
            clock.advance(by: 50)
            let timing = diagnostics.finish()
            diagnostics.finish()
            XCTAssertEqual(timing.durationMs, 300)
            XCTAssertEqual(sink.lines.count, 2)
            XCTAssertTrue(sink.lines[1].contains("phaseAtBound=\(phase)"))
            XCTAssertTrue(sink.lines[1].contains("totalMs=300"))
        }
    }

    func testGesturePhasesSumToTotalAndEncodeThroughRealResponse() throws {
        let clock = FakeMonotonicClock()
        let sink = FakeGestureLogSink()
        let diagnostics = GesturePhaseDiagnostics(
            command: "request_swipe",
            receivedAtMs: 0,
            deadlineMs: nil,
            now: { clock.now() },
            sink: sink
        )
        for phase in [
            "executionPreparation",
            "targetResolution",
            "coordinateResolution",
            "xcuitestGesture",
            "postGesture",
        ] {
            clock.advance(by: 10)
            diagnostics.begin(phase)
        }
        clock.advance(by: 10)
        let timing = diagnostics.finish()
        XCTAssertEqual(timing.durationMs, 60)
        XCTAssertEqual(timing.children?.reduce(0) { $0 + $1.durationMs }, 60)
        XCTAssertTrue(sink.lines.isEmpty)
        let response = WebSocketResponse(type: "swipe_result", timestamp: 42, success: true, totalTimeMs: 60)
            .withPerfTiming(timing, totalTimeMs: 60)
        let encoded = try JSONEncoder().encode(response)
        let decoded = try JSONDecoder().decode(WebSocketResponse.self, from: encoded)
        XCTAssertEqual(
            decoded.perfTiming?.children?.map(\.name),
            [
                "queueWait",
                "executionPreparation",
                "targetResolution",
                "coordinateResolution",
                "xcuitestGesture",
                "postGesture",
            ]
        )
    }

    func testGestureDeadlineLogsExactlyOnceEvenBelowSlowThreshold() {
        let clock = FakeMonotonicClock()
        let sink = FakeGestureLogSink()
        let diagnostics = GesturePhaseDiagnostics(
            command: "request_swipe",
            receivedAtMs: 0,
            deadlineMs: 5,
            now: { clock.now() },
            sink: sink
        )
        clock.advance(by: 10)
        diagnostics.begin("executionPreparation")
        diagnostics.markDeadlineExceeded()
        diagnostics.finish()
        diagnostics.finish()
        XCTAssertEqual(
            sink.lines,
            [
                "gesture_phases command=request_swipe queueWaitMs=10 executionPreparationMs=0 totalMs=10 deadlineRemainingMs=-5",
            ]
        )
    }

    func testGestureSlowThresholdAndNoPerfResponseUnchanged() throws {
        for (elapsed, expectedLogs) in [(1999, 0), (2000, 0), (2001, 1)] {
            let clock = FakeMonotonicClock()
            let sink = FakeGestureLogSink()
            let diagnostics = GesturePhaseDiagnostics(
                command: "request_tap_coordinates",
                receivedAtMs: 0,
                deadlineMs: nil,
                now: { clock.now() },
                sink: sink
            )
            diagnostics.begin("xcuitestGesture")
            clock.advance(by: Int64(elapsed))
            diagnostics.finish()
            diagnostics.finish()
            XCTAssertEqual(sink.lines.count, expectedLogs)
            XCTAssertNil(diagnostics.attaching(to: nil))
            let response = WebSocketResponse(type: "swipe_result", timestamp: 42, success: true, totalTimeMs: 12)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            let before = try encoder.encode(response)
            let after = try diagnostics.attaching(to: nil).map { timing in
                try encoder.encode(response.withPerfTiming(timing, totalTimeMs: 12))
            } ?? encoder.encode(response)
            XCTAssertEqual(before, after)
        }
    }
}
