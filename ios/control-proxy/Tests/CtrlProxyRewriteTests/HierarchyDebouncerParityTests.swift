import Foundation
import XCTest

/// Differential parity for `HierarchyDebouncer` (rewrite Phase 4D). The reference was a
/// plain `class` guarding every field with an `NSLock`; the rewrite is an `@MainActor`
/// state machine with no lock, whose `@Sendable` timer callback re-enters isolation via
/// `MainActor.assumeIsolated` (the manual `FakeTimer` fires on the main thread). Both
/// are driven through the SAME scripted scenarios (`DebouncerScenarios`) and must
/// produce identical `DebouncerRun`s — the ordered `transition`/`changed` event stream,
/// the successful-extraction times (poll cadence + idle backoff), and the total
/// extraction count.
///
/// A few scenarios also carry anchored, independently hand-computed expectations
/// (asserted against the reference oracle) so a bug that made BOTH modules no-op the
/// same way cannot masquerade as trivially-equal parity.
@MainActor
final class HierarchyDebouncerParityTests: XCTestCase {
    func testAllScenariosMatchAcrossModules() throws {
        for scenario in DebouncerScenarios.all {
            let reference = try ReferenceHierarchyDebouncer.run(scenario)
            let rewrite = try RewriteHierarchyDebouncer.run(scenario)
            XCTAssertEqual(
                reference, rewrite,
                "debouncer parity diverged for scenario '\(scenario.name)'\n  reference=\(reference)\n  rewrite=\(rewrite)"
            )
        }
    }

    private func scenario(_ name: String) throws -> DebouncerScenario {
        try XCTUnwrap(
            DebouncerScenarios.all.first { $0.name == name },
            "missing scenario '\(name)'"
        )
    }

    /// Initial broadcast, then a real structural change (transition immediately followed
    /// by a debounced broadcast at the same hash), then an animation-only frame that
    /// must produce nothing. Anchored against the reference oracle.
    func testInitialChangeThenAnimationShape() throws {
        let run = try ReferenceHierarchyDebouncer.run(scenario("initialChangeThenAnimation"))

        XCTAssertEqual(run.readTimes, [0, 1000, 2000])
        XCTAssertEqual(run.extractionCount, 3)
        XCTAssertEqual(run.events.count, 3)

        guard case let .changed(initialHash) = run.events[0],
              case let .transition(transitionHash) = run.events[1],
              case let .changed(broadcastHash) = run.events[2]
        else {
            XCTFail("unexpected event shape: \(run.events)")
            return
        }
        XCTAssertEqual(transitionHash, broadcastHash, "transition + broadcast are the same structural state")
        XCTAssertNotEqual(initialHash, transitionHash, "the change must be a different structural hash")
    }

    /// A change inside the debounce window fires `transition` once, then broadcasts once
    /// the window elapses — never a second transition.
    func testDebouncedChangeShape() throws {
        let run = try ReferenceHierarchyDebouncer.run(scenario("debouncedChangeEventuallyBroadcast"))

        XCTAssertEqual(run.readTimes, [0, 10, 20, 30, 40, 50])
        XCTAssertEqual(run.events.count, 3, "initial changed, one transition, one debounced broadcast")
        XCTAssertEqual(run.events.filter { if case .transition = $0 { return true }; return false }.count, 1)
    }

    /// Idle backoff cadence: 200 → 400 → 800(cap) → 800, only the initial state broadcasts.
    func testIdleBackoffShape() throws {
        let run = try ReferenceHierarchyDebouncer.run(scenario("idleBackoffToCap"))

        XCTAssertEqual(run.readTimes, [0, 200, 600, 1400, 2200])
        XCTAssertEqual(run.extractionCount, 5)
        XCTAssertEqual(run.events.count, 1)
    }

    /// `updatePollIntervalMs` cancels the pending backed-off poll (stale generation) and
    /// restarts at the base interval: the stale poll at t=600 fires but performs no read.
    func testUpdatePollIntervalResetsCadenceShape() throws {
        let run = try ReferenceHierarchyDebouncer.run(scenario("updatePollIntervalResetsCadence"))

        XCTAssertEqual(run.readTimes, [0, 200, 400, 800])
        XCTAssertEqual(run.extractionCount, 4)
    }

    /// A throwing poll increments the extraction count but records no read and no event;
    /// the next successful poll recovers and broadcasts the change.
    func testContinuesPollingAfterErrorShape() throws {
        let run = try ReferenceHierarchyDebouncer.run(scenario("continuesPollingAfterError"))

        XCTAssertEqual(run.readTimes, [0, 400], "the throwing poll at t=200 records no read")
        XCTAssertEqual(run.extractionCount, 3, "initial + throwing poll + recovery poll")
        XCTAssertEqual(run.events.count, 3)
    }

    /// After `stop()`, no further polling occurs.
    func testStopPreventsPollingShape() throws {
        let run = try ReferenceHierarchyDebouncer.run(scenario("stopPreventsPolling"))

        XCTAssertEqual(run.readTimes, [0])
        XCTAssertEqual(run.extractionCount, 1)
        XCTAssertEqual(run.events.count, 1)
    }

    /// The poll landing inside the 100ms animation skip window (t=120) is skipped — no
    /// read there — while the poll past the window (t=200) extracts.
    func testAnimationSkipWindowShape() throws {
        let run = try ReferenceHierarchyDebouncer.run(scenario("animationSkipWindow"))

        XCTAssertEqual(run.readTimes, [0, 40, 200], "t=120 poll is skipped inside the animation window")
        XCTAssertEqual(run.extractionCount, 3)
        XCTAssertEqual(run.events.count, 1)
    }
}
