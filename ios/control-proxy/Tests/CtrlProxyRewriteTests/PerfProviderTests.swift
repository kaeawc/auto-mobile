@testable import CtrlProxyRewrite
import Foundation
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
    // MARK: - The load-bearing @TaskLocal validation (STATUS §9.3)

    /// The whole reason the rewrite uses `@TaskLocal` (not the reference's thread-local): a
    /// hierarchy request opens its perf scope on the (off-main) command path, then `await`s into
    /// the `@MainActor` `ElementLocator`, which opens a sub-block. A thread-local would split the
    /// tree at that executor boundary (the sub-block would land as a separate root). A task-local
    /// propagates across the `await` — same task, different executor — so the sub-block nests under
    /// the outer block exactly as the reference's single-threaded tree did.
    ///
    /// Fail-closed: the outer scope runs inside a `Task.detached` (which drops all isolation, so it
    /// executes on the cooperative pool, never the main thread — even if this class were later
    /// annotated `@MainActor`) and the sub-block is pinned to `MainActor`. The hop is therefore a
    /// real executor boundary regardless of test-runner scheduling; a thread-local impl would split
    /// the tree there and fail `roots.count == 1`.
    func testTaskLocalScopeNestsAcrossMainActorHop() async throws {
        let clock = FakeTimeProvider()
        let provider = PerfProvider(timeProvider: clock)

        // `withScope` binds the `@TaskLocal` on the detached task; the `await` into the `@MainActor`
        // sub-block is a genuine cross-executor hop within that one task — the exact condition under
        // which a thread-local would split the tree but a task-local must not.
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
        func requireSendable(_ value: some Sendable) {}
        requireSendable(PerfProvider(timeProvider: FakeTimeProvider()))
    }
}
