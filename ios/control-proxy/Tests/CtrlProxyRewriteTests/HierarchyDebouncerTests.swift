@testable import CtrlProxyRewrite
import os
import XCTest

@MainActor
final class HierarchyDebouncerTests: XCTestCase {
    func testStartIsIdempotentAndBroadcastsInitialState() throws {
        let initial = hierarchy("initial")
        let harness = DebouncerHarness(steps: [.hierarchy(initial)])

        harness.debouncer.start()
        harness.debouncer.start()

        XCTAssertEqual(harness.extractor.callCount, 1)
        XCTAssertEqual(harness.timer.scheduledDelays, [1000])
        XCTAssertEqual(harness.timer.pendingCallbackCount, 1)
        XCTAssertEqual(harness.results.count, 1)
        try assertChanged(harness.results.first, hierarchy: initial)
        XCTAssertEqual(harness.debouncer.getLastHierarchy()?.hierarchy?.text, "initial")
        XCTAssertTrue(harness.transitions.isEmpty)
    }

    func testIdleBackoffDoublesAndHoldsAtFourTimesBase() {
        let harness = DebouncerHarness(steps: [.hierarchy(hierarchy("idle"))])
        harness.debouncer.start()

        harness.timer.advance(by: 1000)
        harness.timer.advance(by: 2000)
        harness.timer.advance(by: 4000)

        XCTAssertEqual(harness.timer.scheduledDelays, [1000, 2000, 4000, 4000])
        XCTAssertEqual(harness.extractor.callCount, 4)
        XCTAssertEqual(harness.results.count, 1)
        XCTAssertTrue(harness.transitions.isEmpty)
    }

    func testChangedHashResetsBackoffToBase() throws {
        let initial = hierarchy("initial")
        let changed = hierarchy("changed")
        XCTAssertNotEqual(StructuralHasher.computeHash(initial), StructuralHasher.computeHash(changed))
        let harness = DebouncerHarness(steps: [
            .hierarchy(initial), .hierarchy(initial), .hierarchy(initial), .hierarchy(changed),
        ])
        harness.debouncer.start()
        harness.timer.advance(by: 1000)
        harness.timer.advance(by: 2000)
        harness.timer.advance(by: 4000)

        XCTAssertEqual(harness.timer.scheduledDelays, [1000, 2000, 4000, 1000])
        XCTAssertEqual(harness.results.count, 2)
        try assertChanged(harness.results.last, hierarchy: changed)
        XCTAssertEqual(harness.debouncer.getLastHierarchy()?.hierarchy?.text, "changed")
    }

    func testDebouncedChangeIsRetriedUntilBroadcastBoundary() throws {
        let changed = hierarchy("changed")
        let harness = DebouncerHarness(steps: [
            .hierarchy(hierarchy("initial")), .hierarchy(changed),
        ], pollIntervalMs: 10)
        harness.debouncer.start()

        // A debounced hash is retried on every poll, but only broadcasts at 50 ms.
        for _ in 0 ..< 4 {
            harness.timer.advance(by: 10)
            XCTAssertEqual(harness.results.count, 1)
        }
        XCTAssertEqual(harness.extractor.callCount, 5)
        XCTAssertEqual(harness.debouncer.getLastHierarchy()?.hierarchy?.text, "changed")
        harness.timer.advance(by: 10)

        XCTAssertEqual(harness.timer.now(), 50)
        XCTAssertEqual(harness.extractor.callCount, 6)
        XCTAssertEqual(harness.results.count, 2)
        try assertChanged(harness.results.last, hierarchy: changed)
        harness.timer.advance(by: 10)
        XCTAssertEqual(harness.results.count, 2)
        XCTAssertEqual(harness.timer.scheduledDelays.last, 20)
    }

    func testAnimationWindowSkipsExtractionAndResumesAtBoundary() {
        let harness = DebouncerHarness(steps: [.hierarchy(hierarchy("idle"))], pollIntervalMs: 10)
        harness.debouncer.start()
        harness.timer.advance(by: 10)
        XCTAssertEqual(harness.extractor.callCount, 2)

        // Skipped polls retain the 20 ms backoff; they do not grow it again.
        for _ in 0 ..< 4 {
            harness.timer.advance(by: 20)
            XCTAssertEqual(harness.extractor.callCount, 2)
        }
        XCTAssertEqual(harness.timer.now(), 90)
        harness.timer.advance(by: 19)
        XCTAssertEqual(harness.extractor.callCount, 2)
        harness.timer.advance(by: 1)

        XCTAssertEqual(harness.timer.now(), 110)
        XCTAssertEqual(harness.extractor.callCount, 3)
        XCTAssertEqual(harness.timer.scheduledDelays, [10, 20, 20, 20, 20, 20, 40])
        XCTAssertEqual(harness.results.count, 1)
    }

    func testStopInvalidatesPendingCallback() {
        let harness = DebouncerHarness(steps: [
            .hierarchy(hierarchy("initial")), .hierarchy(hierarchy("changed")),
        ])
        harness.debouncer.start()
        harness.debouncer.stop()
        XCTAssertEqual(harness.timer.pendingCallbackCount, 1)
        harness.timer.advance(by: 2000)

        XCTAssertEqual(harness.extractor.callCount, 1)
        XCTAssertEqual(harness.results.count, 1)
        XCTAssertTrue(harness.transitions.isEmpty)
        XCTAssertEqual(harness.timer.pendingCallbackCount, 0)
        XCTAssertEqual(harness.timer.scheduledDelays, [1000])
    }

    func testStopThenStartResumesAtBaseInterval() throws {
        let initial = hierarchy("initial")
        let restarted = hierarchy("restarted")
        let harness = DebouncerHarness(steps: [
            .hierarchy(initial), .hierarchy(initial), .hierarchy(initial), .hierarchy(restarted),
        ])
        harness.debouncer.start()
        harness.timer.advance(by: 1000)
        harness.timer.advance(by: 2000)
        XCTAssertEqual(harness.timer.scheduledDelays.last, 4000)

        harness.debouncer.stop()
        harness.debouncer.start()

        XCTAssertEqual(harness.extractor.callCount, 4)
        XCTAssertEqual(harness.results.count, 2)
        try assertChanged(harness.results.last, hierarchy: restarted)
        XCTAssertEqual(harness.debouncer.getLastHierarchy()?.hierarchy?.text, "restarted")
        // Intentionally red until pass 2 resets the stale effective interval.
        XCTAssertEqual(harness.timer.scheduledDelays.last, 1000)
    }

    func testUpdateIntervalResetsBackoffAndInvalidatesOldCallback() throws {
        let initial = hierarchy("initial")
        let changed = hierarchy("changed")
        let harness = DebouncerHarness(steps: [
            .hierarchy(initial), .hierarchy(initial), .hierarchy(initial), .hierarchy(changed),
        ])
        harness.debouncer.start()
        harness.timer.advance(by: 1000)
        harness.timer.advance(by: 2000)
        XCTAssertEqual(harness.timer.scheduledDelays.last, 4000)

        // The new poll at 8000 ms lets the stale 7000 ms callback fire alone.
        harness.debouncer.updatePollIntervalMs(5000)
        XCTAssertEqual(harness.timer.scheduledDelays, [1000, 2000, 4000, 5000])
        XCTAssertEqual(harness.timer.pendingCallbackCount, 2)
        harness.timer.advance(by: 4000)
        XCTAssertEqual(harness.extractor.callCount, 3)
        XCTAssertEqual(harness.results.count, 1)
        XCTAssertTrue(harness.transitions.isEmpty)
        XCTAssertEqual(harness.timer.pendingCallbackCount, 1)
        XCTAssertEqual(harness.timer.scheduledDelays.count, 4)

        harness.timer.advance(by: 1000)
        XCTAssertEqual(harness.extractor.callCount, 4)
        XCTAssertEqual(harness.results.count, 2)
        try assertChanged(harness.results.last, hierarchy: changed)
        XCTAssertEqual(harness.timer.scheduledDelays.last, 5000)
        XCTAssertEqual(harness.timer.pendingCallbackCount, 1)
    }

    func testPollingErrorIsSwallowedAndNextPollRetries() throws {
        let changed = hierarchy("changed")
        let harness = DebouncerHarness(steps: [
            .hierarchy(hierarchy("initial")), .failure, .hierarchy(changed),
        ])
        harness.debouncer.start()
        harness.timer.advance(by: 1000)

        XCTAssertEqual(harness.extractor.callCount, 2)
        XCTAssertEqual(harness.results.count, 1)
        XCTAssertTrue(harness.transitions.isEmpty)
        XCTAssertEqual(harness.debouncer.getLastHierarchy()?.hierarchy?.text, "initial")
        XCTAssertEqual(harness.timer.scheduledDelays, [1000, 1000])
        XCTAssertEqual(harness.timer.pendingCallbackCount, 1)

        harness.timer.advance(by: 1000)
        XCTAssertEqual(harness.extractor.callCount, 3)
        XCTAssertEqual(harness.results.count, 2)
        try assertChanged(harness.results.last, hierarchy: changed)
        XCTAssertEqual(harness.timer.scheduledDelays, [1000, 1000, 1000])
    }

    func testTransitionFiresForDebouncedChangeOnlyOncePerObservedHash() {
        let harness = DebouncerHarness(steps: [
            .hierarchy(hierarchy("initial")), .hierarchy(hierarchy("changed")),
        ], pollIntervalMs: 10)
        harness.debouncer.start()
        harness.timer.advance(by: 10)

        XCTAssertEqual(harness.results.count, 1)
        XCTAssertEqual(harness.transitions.count, 1)
        XCTAssertEqual(harness.transitions.first?.hierarchy?.text, "changed")
        harness.timer.advance(by: 10)
        XCTAssertEqual(harness.extractor.callCount, 3)
        XCTAssertEqual(harness.results.count, 1)
        XCTAssertEqual(harness.transitions.count, 1)
    }

    func testSetOnResultReplacesPreviousCallback() throws {
        let changed = hierarchy("changed")
        let harness = DebouncerHarness(steps: [
            .hierarchy(hierarchy("initial")), .hierarchy(changed),
        ])
        harness.debouncer.start()
        var replacementResults: [HierarchyResult] = []
        harness.debouncer.setOnResult { replacementResults.append($0) }
        harness.timer.advance(by: 1000)

        XCTAssertEqual(harness.results.count, 1)
        XCTAssertEqual(replacementResults.count, 1)
        try assertChanged(replacementResults.first, hierarchy: changed)
    }

    func testUnchangedPollUpdatesLastHierarchyWithoutBroadcasting() {
        let initial = hierarchy("idle", updatedAt: 1)
        let refreshed = hierarchy("idle", updatedAt: 2)
        XCTAssertEqual(StructuralHasher.computeHash(initial), StructuralHasher.computeHash(refreshed))
        let harness = DebouncerHarness(steps: [.hierarchy(initial), .hierarchy(refreshed)])
        XCTAssertNil(harness.debouncer.getLastHierarchy())
        harness.debouncer.start()
        harness.timer.advance(by: 1000)

        XCTAssertEqual(harness.debouncer.getLastHierarchy()?.updatedAt, 2)
        XCTAssertEqual(harness.results.count, 1)
        XCTAssertTrue(harness.transitions.isEmpty)
    }

    func testCommandCaptureUpdatesLatestWithoutChangingPollState() throws {
        let initial = hierarchy("initial", updatedAt: 10)
        let command = hierarchy("command", updatedAt: 20)
        // The poll sees the same structure as the command but still must report the change
        // from its own last broadcast, not from the recorded command capture.
        let polled = hierarchy("command", updatedAt: 30)
        let harness = DebouncerHarness(steps: [.hierarchy(initial), .hierarchy(polled)])
        harness.debouncer.start()

        let earlierSequence = harness.debouncer.beginCapture()
        let commandSequence = harness.debouncer.beginCapture()
        harness.debouncer.recordCommandCapture(command, captureSequence: commandSequence)
        harness.debouncer.recordCommandCapture(
            hierarchy("late command", updatedAt: 40), captureSequence: earlierSequence
        )

        XCTAssertEqual(harness.debouncer.getLastHierarchy()?.updatedAt, 20)
        XCTAssertEqual(harness.debouncer.getLastHierarchy()?.hierarchy?.text, "command")
        XCTAssertEqual(harness.results.count, 1)
        XCTAssertTrue(harness.transitions.isEmpty)
        XCTAssertEqual(harness.timer.scheduledDelays, [1000])
        XCTAssertEqual(harness.timer.pendingCallbackCount, 1)
        XCTAssertEqual(harness.extractor.callCount, 1)

        harness.timer.advance(by: 1000)
        XCTAssertEqual(harness.debouncer.getLastHierarchy()?.updatedAt, 30)
        XCTAssertEqual(harness.results.count, 2)
        try assertChanged(harness.results.last, hierarchy: polled)
        XCTAssertEqual(harness.transitions.map(\.updatedAt), [30])
        XCTAssertEqual(harness.timer.scheduledDelays, [1000, 1000])

        harness.debouncer.recordCommandCapture(command, captureSequence: commandSequence)
        XCTAssertEqual(harness.debouncer.getLastHierarchy()?.updatedAt, 30)
        XCTAssertEqual(harness.results.count, 2)
        XCTAssertEqual(harness.transitions.count, 1)
        XCTAssertEqual(harness.timer.scheduledDelays, [1000, 1000])
    }

    func testCommandCaptureAcceptsEqualTimestamp() {
        let harness = DebouncerHarness(steps: [.hierarchy(hierarchy("initial", updatedAt: 20))])
        harness.debouncer.start()
        harness.debouncer.recordCommandCapture(
            hierarchy("command", updatedAt: 20), captureSequence: harness.debouncer.beginCapture()
        )
        XCTAssertEqual(harness.debouncer.getLastHierarchy()?.hierarchy?.text, "command")
        XCTAssertEqual(harness.results.count, 1)
        XCTAssertTrue(harness.transitions.isEmpty)
        XCTAssertEqual(harness.timer.scheduledDelays, [1000])
    }

    func testOlderPollsCannotReplaceCommandCapture() throws {
        let initial = hierarchy("initial", updatedAt: 10)
        let olderChanged = hierarchy("older change", updatedAt: 16)
        let harness = DebouncerHarness(steps: [
            .hierarchy(initial), .hierarchy(hierarchy("initial", updatedAt: 15)), .hierarchy(olderChanged),
        ])
        harness.debouncer.start()
        let command = hierarchy("command", updatedAt: 20)
        harness.debouncer.recordCommandCapture(command, captureSequence: harness.debouncer.beginCapture())
        // Each poll begins first, then a later command records before the poll completes.
        harness.extractor.onCapture = { [weak debouncer = harness.debouncer] in
            guard let debouncer else { return }
            debouncer.recordCommandCapture(command, captureSequence: debouncer.beginCapture())
        }

        // Exercise both the unchanged and changed poll writes. Poll callbacks retain their
        // existing behavior; only the hierarchy used by SDK refreshes is sequence-guarded.
        harness.timer.advance(by: 1000)
        XCTAssertEqual(harness.debouncer.getLastHierarchy()?.updatedAt, 20)
        XCTAssertEqual(harness.results.count, 1)
        XCTAssertEqual(harness.timer.scheduledDelays, [1000, 2000])
        harness.timer.advance(by: 2000)
        XCTAssertEqual(harness.debouncer.getLastHierarchy()?.updatedAt, 20)
        XCTAssertEqual(harness.debouncer.getLastHierarchy()?.hierarchy?.text, "command")
        XCTAssertEqual(harness.results.count, 2)
        try assertChanged(harness.results.last, hierarchy: olderChanged)
        XCTAssertEqual(harness.transitions.map(\.updatedAt), [16])
        XCTAssertEqual(harness.timer.scheduledDelays, [1000, 2000, 1000])
    }

    func testInitialPollCannotReplaceNewerCommandCapture() {
        let harness = DebouncerHarness(steps: [.hierarchy(hierarchy("initial", updatedAt: 10))])
        let command = hierarchy("command", updatedAt: 20)
        harness.debouncer.recordCommandCapture(command, captureSequence: harness.debouncer.beginCapture())
        XCTAssertEqual(harness.debouncer.getLastHierarchy()?.updatedAt, 20)
        XCTAssertTrue(harness.results.isEmpty)
        XCTAssertTrue(harness.transitions.isEmpty)
        XCTAssertTrue(harness.timer.scheduledDelays.isEmpty)

        harness.extractor.onCapture = { [weak debouncer = harness.debouncer] in
            guard let debouncer else { return }
            debouncer.recordCommandCapture(command, captureSequence: debouncer.beginCapture())
        }
        harness.debouncer.start()
        XCTAssertEqual(harness.debouncer.getLastHierarchy()?.updatedAt, 20)
        XCTAssertEqual(harness.results.count, 1)
        XCTAssertEqual(harness.timer.scheduledDelays, [1000])
    }

    func testCommandCapturePreservesAnimationSkipAndBackoff() {
        let initial = hierarchy("idle", updatedAt: 10)
        let harness = DebouncerHarness(steps: [.hierarchy(initial)], pollIntervalMs: 10)
        harness.debouncer.start()
        harness.timer.advance(by: 10)
        XCTAssertEqual(harness.timer.scheduledDelays, [10, 20])

        harness.debouncer.recordCommandCapture(
            hierarchy("command", updatedAt: 20), captureSequence: harness.debouncer.beginCapture()
        )
        XCTAssertEqual(harness.results.count, 1)
        XCTAssertTrue(harness.transitions.isEmpty)
        XCTAssertEqual(harness.timer.scheduledDelays, [10, 20])
        harness.timer.advance(by: 20)
        XCTAssertEqual(harness.extractor.callCount, 2, "Recording must not exit the animation skip window")
        XCTAssertEqual(harness.timer.scheduledDelays, [10, 20, 20])
        XCTAssertEqual(harness.debouncer.getLastHierarchy()?.updatedAt, 20)
    }

    func testNewerPollsReplaceCacheWhenWallClockStepsBack() throws {
        let initial = hierarchy("initial", updatedAt: 30)
        let unchanged = hierarchy("initial", updatedAt: 20)
        let changed = hierarchy("changed", updatedAt: 10)
        let harness = DebouncerHarness(steps: [.hierarchy(initial), .hierarchy(unchanged), .hierarchy(changed)])
        harness.debouncer.start()

        harness.timer.advance(by: 1000)
        XCTAssertEqual(harness.debouncer.getLastHierarchy()?.updatedAt, 20)
        XCTAssertEqual(harness.results.count, 1)
        XCTAssertTrue(harness.transitions.isEmpty)
        harness.timer.advance(by: 2000)
        XCTAssertEqual(harness.debouncer.getLastHierarchy()?.updatedAt, 10)
        XCTAssertEqual(harness.debouncer.getLastHierarchy()?.hierarchy?.text, "changed")
        XCTAssertEqual(harness.results.count, 2)
        try assertChanged(harness.results.last, hierarchy: changed)
        XCTAssertEqual(harness.transitions.map(\.updatedAt), [10])
        XCTAssertEqual(harness.timer.scheduledDelays, [1000, 2000, 1000])
    }

    func testLaterInitialCaptureReplacesCommandDespiteOlderTimestamp() {
        let harness = DebouncerHarness(steps: [.hierarchy(hierarchy("initial", updatedAt: 10))])
        harness.debouncer.recordCommandCapture(
            hierarchy("command", updatedAt: 20), captureSequence: harness.debouncer.beginCapture()
        )
        harness.debouncer.start()

        XCTAssertEqual(harness.debouncer.getLastHierarchy()?.updatedAt, 10)
        XCTAssertEqual(harness.debouncer.getLastHierarchy()?.hierarchy?.text, "initial")
        XCTAssertEqual(harness.results.count, 1)
        XCTAssertTrue(harness.transitions.isEmpty)
        XCTAssertEqual(harness.timer.scheduledDelays, [1000])
    }

    private func hierarchy(_ label: String, updatedAt: Int64 = 1) -> ViewHierarchy {
        ViewHierarchy(updatedAt: updatedAt, packageName: "test.app", hierarchy: UIElementInfo(text: label))
    }

    private func assertChanged(
        _ result: HierarchyResult?,
        hierarchy: ViewHierarchy,
        file: StaticString = #filePath,
        line: UInt = #line
    )
        throws
    {
        let result = try XCTUnwrap(result, file: file, line: line)
        guard case let .changed(actualHierarchy, hash, extractionTimeMs) = result else {
            XCTFail("Expected a changed result", file: file, line: line)
            return
        }
        XCTAssertEqual(actualHierarchy.hierarchy?.text, hierarchy.hierarchy?.text, file: file, line: line)
        XCTAssertEqual(hash, StructuralHasher.computeHash(hierarchy), file: file, line: line)
        XCTAssertEqual(extractionTimeMs, 0, file: file, line: line)
    }
}

@MainActor
private final class DebouncerHarness {
    let extractor: ScriptedHierarchyExtractor
    let timer = RecordingHierarchyTimer()
    let debouncer: HierarchyDebouncer
    var results: [HierarchyResult] = []
    var transitions: [ViewHierarchy] = []

    init(steps: [ScriptedHierarchyExtractor.Step], pollIntervalMs: Int64 = 1000) {
        extractor = ScriptedHierarchyExtractor(steps: steps)
        debouncer = HierarchyDebouncer(
            hierarchyExtractor: extractor,
            perf: FakePerfTracking(flushResult: nil),
            timer: timer,
            pollIntervalMs: pollIntervalMs
        )
        debouncer.setOnResult { [weak self] in self?.results.append($0) }
        debouncer.setOnTransition { [weak self] in self?.transitions.append($0) }
    }
}

@MainActor
private final class ScriptedHierarchyExtractor: HierarchyExtracting {
    enum Step {
        case hierarchy(ViewHierarchy)
        case failure
    }

    private enum ExtractionError: Error {
        case scripted
    }

    private let steps: [Step]
    private(set) var callCount = 0
    var onCapture: (() -> Void)?

    init(steps: [Step]) {
        precondition(!steps.isEmpty, "Provide at least one scripted extraction")
        self.steps = steps
    }

    func getViewHierarchy(disableAllFiltering: Bool) throws -> ViewHierarchy {
        XCTAssertFalse(disableAllFiltering)
        // Repeat the final step so idle and retry tests need no redundant fixtures.
        let step = steps[min(callCount, steps.count - 1)]
        callCount += 1
        onCapture?()
        switch step {
        case let .hierarchy(hierarchy): return hierarchy
        case .failure: throw ExtractionError.scripted
        }
    }
}

private final class RecordingHierarchyTimer: ProxyTimer {
    private let delegate = FakeProxyTimer(mode: .manual)
    private let delays = OSAllocatedUnfairLock<[Int64]>(initialState: [])

    var scheduledDelays: [Int64] { delays.withLock { $0 } }
    var pendingCallbackCount: Int { delegate.pendingCallbackCount }

    func now() -> Int64 { delegate.now() }

    func wait(milliseconds: Int64) async {
        await delegate.wait(milliseconds: milliseconds)
    }

    func schedule(after milliseconds: Int64, callback: @escaping @Sendable () -> Void) {
        delays.withLock { $0.append(milliseconds) }
        delegate.schedule(after: milliseconds, callback: callback)
    }

    @MainActor
    func advance(by milliseconds: Int64) {
        delegate.advance(by: milliseconds)
    }
}
