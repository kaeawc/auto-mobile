@testable import CtrlProxyRewrite
import Foundation
import os
import XCTest

private final class ArrowTestClock: Clock, Sendable {
    struct Instant: InstantProtocol {
        let offset: Duration

        func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
        func duration(to other: Instant) -> Duration { other.offset - offset }
        static func < (lhs: Instant, rhs: Instant) -> Bool { lhs.offset < rhs.offset }
    }

    private let instant = OSAllocatedUnfairLock(initialState: Instant(offset: .zero))
    var now: Instant { instant.withLock { $0 } }
    var minimumResolution: Duration { .nanoseconds(1) }

    func advance(by duration: Duration) {
        instant.withLock { $0 = $0.advanced(by: duration) }
    }

    func sleep(until deadline: Instant, tolerance _: Duration?) async throws {
        try Task.checkCancellation()
        instant.withLock { $0 = max($0, deadline) }
    }
}

/// Exercises the production sequencer with synchronous operations and no wall-clock waits.
private final class ArrowKeyScenario {
    let clock = ArrowTestClock()
    var key = "arrow_left"
    var focusDuration: Duration = .zero
    var lookupDuration: Duration = .zero
    var probeDurations: [Duration] = [.zero, .zero, .zero]
    var readDuration: Duration = .zero
    var sendDuration: Duration = .zero
    var retryDuration: Duration = .zero
    var caretPositions: [Int?] = [1, 0]
    var observedValue = "abc"
    var sends = 0
    var probes = 0
    var reads = 0
    var restorations = 0
    var focusChecks = 0
    var resolutions = 0
    var scanCandidateCount: Int?
    var candidateDuration: Duration = .zero
    var focusedCandidate: Int?
    var scannedCandidates: [Int] = []
    var useProductionResolver = false
    var nativeCandidateCount = 0
    var nativeQueries = 0
    var otherQueries = 0

    func run(
        knownCaret: (String) -> Int? = { _ in nil },
        verifiedCaret: (String, Int) -> Void = { _, _ in }
    )
        throws -> Bool
    {
        try GesturePerformer.performHorizontalArrow(
            clock: clock, key: key,
            requireFocus: {
                self.focusChecks += 1
                self.clock.advance(by: self.focusDuration)
            },
            resolveInput: { checkBudget in
                self.resolutions += 1
                self.clock.advance(by: self.lookupDuration)
                if let count = self.scanCandidateCount {
                    let hasFocus: (Int) -> Bool = { index in
                        self.scannedCandidates.append(index)
                        self.clock.advance(by: self.candidateDuration)
                        return index == self.focusedCandidate
                    }
                    let match: Int?
                    if self.useProductionResolver {
                        match = try GesturePerformer.resolveFocusedTextElement(
                            checkBudget: checkBudget,
                            predicateMatch: { nil },
                            nativeQueries: [{
                                self.nativeQueries += 1
                                return Array(0 ..< self.nativeCandidateCount)
                            }],
                            otherQuery: {
                                self.otherQueries += 1
                                return 0 ..< count
                            },
                            nativeHasFocus: hasFocus, otherHasFocus: hasFocus
                        )
                    } else {
                        match = try GesturePerformer.firstFocusedCandidate(
                            in: 0 ..< count, checkBudget: checkBudget, hasFocus: hasFocus
                        )
                    }
                    return match.map { ("field-\($0)", "abc") } ?? (nil, nil)
                }
                return ("field", "abc")
            },
            probeCaret: { _, _ in
                let index = self.probes
                self.probes += 1
                self.clock.advance(by: self.probeDurations[index])
                return self.caretPositions[index]
            },
            sendKey: {
                self.sends += 1
                self.clock.advance(by: self.sendDuration)
            },
            retryKey: { _ in
                self.sends += 1
                self.clock.advance(by: self.retryDuration)
            },
            readValue: { _ in
                self.reads += 1
                self.clock.advance(by: self.readDuration)
                return self.observedValue
            },
            restoreValue: { _, _ in self.restorations += 1 },
            knownCaret: knownCaret, verifiedCaret: verifiedCaret
        )
    }
}

final class PressKeyTests: XCTestCase {
    func testFocusedEmptyOtherIsEligibleForKeyPressButNotTextInputDetection() {
        XCTAssertTrue(GesturePerformer.isFocusedSnapshotCandidate(
            hasFocus: true, isKnownTextInput: false, isOther: true,
            hasTextInputEvidence: false, forKeyPress: true
        ))
        XCTAssertFalse(GesturePerformer.isFocusedSnapshotCandidate(
            hasFocus: true, isKnownTextInput: false, isOther: true,
            hasTextInputEvidence: false, forKeyPress: false
        ))
        XCTAssertFalse(GesturePerformer.isFocusedSnapshotCandidate(
            hasFocus: false, isKnownTextInput: false, isOther: true,
            hasTextInputEvidence: false, forKeyPress: true
        ))
    }

    func testDestructiveKeyRequiresObservableField() {
        XCTAssertFalse(GesturePerformer.canVerifyDestructiveKey(focusedValue: nil))
        XCTAssertTrue(GesturePerformer.canVerifyDestructiveKey(focusedValue: ""))
    }

    func testDestructiveKeyOutcomeAcceptsEmptyFieldBoundary() {
        XCTAssertEqual(GesturePerformer.destructiveKeyOutcome(before: "", after: ""), .boundaryNoOp)
        XCTAssertEqual(GesturePerformer.destructiveKeyOutcome(before: "", after: "unexpected"), .boundaryNoOp)
    }

    func testDestructiveKeyOutcomeRequiresDeletionFromNonEmptyField() {
        XCTAssertEqual(GesturePerformer.destructiveKeyOutcome(before: "hello", after: "hel"), .deleted)
        XCTAssertEqual(GesturePerformer.destructiveKeyOutcome(before: "hello", after: "hello"), .noEffect)
        XCTAssertEqual(GesturePerformer.destructiveKeyOutcome(before: "hello", after: "helloo"), .noEffect)
    }

    func testDestructiveKeyModifiersAreRejectedWithActionableError() {
        for (key, modifiers) in [
            ("backspace", ["shift"]),
            ("delete", ["meta"]),
            ("BACKSPACE", ["shift"]),
            ("DELETE", ["meta"]),
        ] {
            XCTAssertThrowsError(try GesturePerformer.validateDestructiveKeyModifiers(
                normalizedKey: key.lowercased(), modifiers: modifiers
            )) { error in
                guard case let GesturePerformer.GestureError.notSupported(message) = error else {
                    return XCTFail("Expected notSupported error, got \(error)")
                }
                XCTAssertEqual(
                    message,
                    "Modifiers (\(modifiers[0])) are not supported with \(key.lowercased()); send the key without modifiers"
                )
            }
        }
    }

    func testDestructiveKeysWithoutModifiersAndOtherKeysWithModifiersAreAllowed() {
        for key in ["backspace", "delete"] {
            XCTAssertNoThrow(try GesturePerformer.validateDestructiveKeyModifiers(normalizedKey: key, modifiers: []))
        }
        for key in ["arrow_left", "enter"] {
            XCTAssertNoThrow(try GesturePerformer.validateDestructiveKeyModifiers(
                normalizedKey: key, modifiers: ["shift"]
            ))
        }
    }

    func testFieldTextExcludesEmptyFieldPlaceholders() {
        XCTAssertEqual(GesturePerformer.fieldText(
            snapshotValue: nil, value: "Search or enter website name", placeholderValue: "Search or enter website name"
        ), "")
        XCTAssertEqual(GesturePerformer.fieldText(
            snapshotValue: nil, value: "stale text", placeholderValue: "Search or enter website name"
        ), "")
        XCTAssertEqual(GesturePerformer.fieldText(
            snapshotValue: "", value: "Search or enter website", placeholderValue: "Search or enter website"
        ), "")
        XCTAssertEqual(GesturePerformer.fieldText(
            snapshotValue: "abc", value: "abc", placeholderValue: "Search or enter website"
        ), "abc")
    }

    func testForwardDeleteMarkerSelectionFailsClosedWhenCandidatesAreUsed() {
        XCTAssertEqual(GesturePerformer.forwardDeleteMarker(for: "hello"), "\u{E000}")
        XCTAssertEqual(GesturePerformer.forwardDeleteMarker(for: "h\u{E000}ello"), "\u{E001}")
        let allMarkers = (0xE000 ... 0xE007).compactMap(UnicodeScalar.init).map(String.init).joined()
        XCTAssertNil(GesturePerformer.forwardDeleteMarker(for: allMarkers))
    }

    func testForwardDeleteProbeFindsCaretAndRejectsUntrustedValues() {
        let marker = "\u{E000}"
        XCTAssertEqual(
            GesturePerformer.forwardDeleteMarkerIndex(original: "hello", probed: "hell\(marker)o", marker: marker),
            4
        )
        XCTAssertEqual(
            GesturePerformer.forwardDeleteMarkerIndex(original: "hello", probed: "hello\(marker)", marker: marker),
            5
        )
        XCTAssertNil(GesturePerformer.forwardDeleteMarkerIndex(
            original: "hello",
            probed: "hell\(marker)O",
            marker: marker
        ))
        XCTAssertNil(GesturePerformer.forwardDeleteMarkerIndex(
            original: "hello",
            probed: "hell\(marker)\(marker)o",
            marker: marker
        ))
        XCTAssertNil(GesturePerformer.forwardDeleteMarkerIndex(original: "hello", probed: "hello", marker: marker))
        XCTAssertEqual(GesturePerformer.forwardDeleteResult(original: "hello", caretIndex: 3), "helo")
        XCTAssertEqual(GesturePerformer.forwardDeleteResult(original: "abcde", caretIndex: 3), "abce")
        XCTAssertNil(GesturePerformer.forwardDeleteResult(original: "hello", caretIndex: 5))
        XCTAssertNil(GesturePerformer.forwardDeleteResult(original: "", caretIndex: 0))
        XCTAssertNil(GesturePerformer.forwardDeleteResult(original: "hello", caretIndex: -1))
        XCTAssertEqual(GesturePerformer.forwardDeleteResult(original: "a👩🏽‍💻b", caretIndex: 1), "ab")
    }

    func testHorizontalArrowOutcomeRejectsChangedValueBeforeConsideringCaret() {
        XCTAssertEqual(GesturePerformer.arrowOutcome(
            key: "arrow_left", original: "abc", observed: "←abc", before: 0, after: 0
        ), .valueChanged)
        XCTAssertEqual(GesturePerformer.arrowOutcome(
            key: "arrow_right", original: "abc", observed: "abc→", before: 1, after: 2
        ), .valueChanged)
    }

    func testHorizontalArrowOutcomeRequiresMovementInTheRequestedDirection() {
        XCTAssertEqual(GesturePerformer.arrowOutcome(
            key: "arrow_left", original: "abc", observed: "abc", before: 3, after: 2
        ), .moved)
        XCTAssertEqual(GesturePerformer.arrowOutcome(
            key: "arrow_right", original: "abc", observed: "abc", before: 1, after: 2
        ), .moved)
        XCTAssertEqual(GesturePerformer.arrowOutcome(
            key: "arrow_left", original: "abc", observed: "abc", before: 2, after: 2
        ), .noEffect)
        XCTAssertEqual(GesturePerformer.arrowOutcome(
            key: "arrow_right", original: "abc", observed: "abc", before: 1, after: 1
        ), .noEffect)
        XCTAssertEqual(GesturePerformer.arrowOutcome(
            key: "arrow_right", original: "abc", observed: "abc", before: 2, after: 1
        ), .wrongDirection)
    }

    func testHorizontalArrowOutcomeAcceptsOnlyUnchangedBoundaryNoOps() {
        XCTAssertEqual(GesturePerformer.arrowOutcome(
            key: "arrow_left", original: "abc", observed: "abc", before: 0, after: 0
        ), .boundaryNoOp)
        XCTAssertEqual(GesturePerformer.arrowOutcome(
            key: "arrow_right", original: "abc", observed: "abc", before: 3, after: 3
        ), .boundaryNoOp)
        XCTAssertEqual(GesturePerformer.arrowOutcome(
            key: "arrow_left", original: "", observed: "", before: 0, after: 0
        ), .boundaryNoOp)
    }

    func testHorizontalArrowOutcomeIgnoresChangingPlaceholdersOnEmptyField() {
        let original = GesturePerformer.fieldText(
            snapshotValue: nil, value: "Search or enter website name", placeholderValue: "Search or enter website name"
        )
        let observed = GesturePerformer.fieldText(
            snapshotValue: nil, value: "Search or enter website", placeholderValue: "Search or enter website"
        )
        XCTAssertEqual(GesturePerformer.arrowOutcome(
            key: "arrow_left", original: original, observed: observed, before: 0, after: 0
        ), .boundaryNoOp)
        XCTAssertEqual(GesturePerformer.arrowOutcome(
            key: "arrow_right", original: original, observed: observed, before: 0, after: 0
        ), .boundaryNoOp)
    }

    func testHorizontalArrowOutcomeIsUnverifiedWithoutCaretProbe() {
        XCTAssertNil(GesturePerformer.arrowOutcome(
            key: "arrow_left", original: "abc", observed: "abc", before: nil, after: nil
        ))
        XCTAssertNil(GesturePerformer.arrowOutcome(
            key: "arrow_right", original: "abc", observed: "abc", before: 1, after: nil
        ))
    }

    func testHorizontalArrowNoEffectUsesExactActionableMessage() {
        XCTAssertEqual(
            GesturePerformer.GestureError.arrowNoEffect.localizedDescription,
            "arrow keys have no effect on this iOS runtime; use Cmd+arrow (line start/end) or sendKeys text editing instead"
        )
    }

    func testHorizontalArrowBudgetExhaustedNamesStepAndSaysKeyWasNotSent() {
        let description = GesturePerformer.GestureError.arrowBudgetExhausted(
            step: "caret probe", elapsedMs: 4500
        ).localizedDescription
        XCTAssertEqual(
            description,
            "arrow key was not sent: runner time budget exhausted at caret probe after 4500ms; retry"
        )
        XCTAssertFalse(description.contains("no effect"))
    }

    func testArrowBudgetReservesTimeForEachRemainingOperation() {
        let allows = GesturePerformer.arrowBudgetAllows
        XCTAssertEqual(GesturePerformer.arrowBudgetMs, 6000)
        XCTAssertTrue(allows(0, .initialProbe))
        XCTAssertTrue(allows(3300, .initialProbe))
        XCTAssertFalse(allows(3301, .initialProbe))
        XCTAssertTrue(allows(4200, .appKey))
        XCTAssertFalse(allows(4201, .appKey))
        XCTAssertTrue(allows(4800, .outcomeProbe))
        XCTAssertFalse(allows(4801, .outcomeProbe))
        XCTAssertTrue(allows(4000, .retry))
        XCTAssertFalse(allows(4001, .retry))
        XCTAssertFalse(allows(6000, .outcomeProbe))
        XCTAssertTrue(allows(5999, .completion))
        XCTAssertFalse(allows(6000, .completion))
    }

    func testArrowBudgetExhaustedDuringFocusCheckDoesNotSendKey() {
        let scenario = ArrowKeyScenario()
        scenario.lookupDuration = .seconds(4)
        XCTAssertThrowsError(try scenario.run()) { error in
            guard case let GesturePerformer.GestureError.arrowBudgetExhausted(step, elapsedMs) = error else {
                return XCTFail("Expected pre-send budget error, got \(error)")
            }
            XCTAssertEqual(step, "focus check")
            XCTAssertEqual(elapsedMs, 4000)
            XCTAssertTrue(error.localizedDescription.contains("was not sent"))
        }
        XCTAssertEqual(scenario.sends, 0)
        XCTAssertEqual(scenario.probes, 0)
    }

    func testArrowStopsScanningUnfocusedCandidatesWhenResolutionBudgetExpires() {
        // Retained iPad input failure: the runner kept resolving Other indices 0...253
        // for over a minute after the host's 9s timeout. No live device is needed here.
        let scenario = ArrowKeyScenario()
        scenario.scanCandidateCount = 254
        scenario.candidateDuration = .milliseconds(250)
        XCTAssertThrowsError(try scenario.run()) { error in
            guard case let GesturePerformer.GestureError.arrowBudgetExhausted(step, elapsedMs) = error else {
                return XCTFail("Expected pre-send budget error, got \(error)")
            }
            XCTAssertEqual(step, "focus check")
            XCTAssertEqual(elapsedMs, 3500)
        }
        XCTAssertEqual(scenario.scannedCandidates, Array(0 ..< 14))
        XCTAssertEqual(scenario.sends, 0)
        XCTAssertEqual(scenario.probes, 0)
    }

    func testArrowStillUsesFocusedCandidateWithinResolutionBudget() throws {
        let scenario = ArrowKeyScenario()
        scenario.scanCandidateCount = 254
        scenario.candidateDuration = .milliseconds(250)
        scenario.focusedCandidate = 2
        XCTAssertTrue(try scenario.run())
        XCTAssertEqual(scenario.scannedCandidates, [0, 1, 2])
        XCTAssertEqual(scenario.sends, 1)
    }

    func testProductionResolverStopsNativeScanBeforeQueryingCustomWrappers() {
        assertProductionResolverStopsScan(nativeCandidateCount: 254, expectedOtherQueries: 0)
    }

    func testProductionResolverStopsCustomWrapperScanAfterNativeQueries() {
        assertProductionResolverStopsScan(nativeCandidateCount: 0, expectedOtherQueries: 1)
    }

    private func assertProductionResolverStopsScan(nativeCandidateCount: Int, expectedOtherQueries: Int) {
        let scenario = ArrowKeyScenario()
        scenario.useProductionResolver = true
        scenario.nativeCandidateCount = nativeCandidateCount
        scenario.scanCandidateCount = 254
        scenario.candidateDuration = .milliseconds(250)
        XCTAssertThrowsError(try scenario.run()) { error in
            guard case let GesturePerformer.GestureError.arrowBudgetExhausted(step, elapsedMs) = error else {
                return XCTFail("Expected pre-send budget error, got \(error)")
            }
            XCTAssertEqual(step, "focus check")
            XCTAssertEqual(elapsedMs, 3500)
        }
        XCTAssertEqual(scenario.scannedCandidates, Array(0 ..< 14))
        XCTAssertEqual(scenario.nativeQueries, 1)
        XCTAssertEqual(scenario.otherQueries, expectedOtherQueries)
        XCTAssertEqual(scenario.sends, 0)
        XCTAssertEqual(scenario.probes, 0)
    }

    func testArrowBudgetExhaustedDuringCaretProbeDoesNotSendKey() {
        let scenario = ArrowKeyScenario()
        scenario.probeDurations[0] = .milliseconds(4500)
        XCTAssertThrowsError(try scenario.run()) { error in
            guard case let GesturePerformer.GestureError.arrowBudgetExhausted(step, elapsedMs) = error else {
                return XCTFail("Expected pre-send budget error, got \(error)")
            }
            XCTAssertEqual(step, "caret probe")
            XCTAssertEqual(elapsedMs, 4500)
        }
        XCTAssertEqual(scenario.sends, 0)
        XCTAssertEqual(scenario.probes, 1)
    }

    func testArrowBudgetExhaustedAfterSendReturnsUnverifiedWithoutProbing() throws {
        let scenario = ArrowKeyScenario()
        scenario.sendDuration = .seconds(5)
        XCTAssertFalse(try scenario.run())
        XCTAssertEqual(scenario.sends, 1)
        XCTAssertEqual(scenario.probes, 1)
        XCTAssertEqual(scenario.reads, 0)
    }

    func testArrowBudgetExhaustedDuringValueReadReturnsUnverified() throws {
        let scenario = ArrowKeyScenario()
        scenario.readDuration = .seconds(5)
        XCTAssertFalse(try scenario.run())
        XCTAssertEqual(scenario.sends, 1)
        XCTAssertEqual(scenario.probes, 1)
        XCTAssertEqual(scenario.reads, 1)
    }

    func testArrowBudgetExhaustedDuringOutcomeProbeDoesNotClaimObservedMovement() throws {
        let scenario = ArrowKeyScenario()
        scenario.probeDurations[1] = .seconds(6)
        XCTAssertFalse(try scenario.run())
        XCTAssertEqual(scenario.sends, 1)
        XCTAssertEqual(scenario.probes, 2)
    }

    func testArrowRetryBudgetExhaustedReturnsUnverifiedAfterFirstNoOp() throws {
        let scenario = ArrowKeyScenario()
        scenario.caretPositions = [1, 1]
        scenario.readDuration = .milliseconds(4100)
        XCTAssertFalse(try scenario.run())
        XCTAssertEqual(scenario.sends, 1)
        XCTAssertEqual(scenario.probes, 2)
    }

    func testArrowVerifiedNoOpAfterRetryThrowsArrowNoEffect() {
        let scenario = ArrowKeyScenario()
        scenario.caretPositions = [1, 1, 1]
        XCTAssertThrowsError(try scenario.run()) { error in
            guard case GesturePerformer.GestureError.arrowNoEffect = error else {
                return XCTFail("Expected verified no-op, got \(error)")
            }
        }
        XCTAssertEqual(scenario.sends, 2)
        XCTAssertEqual(scenario.probes, 3)
    }

    func testArrowBudgetExhaustedAfterRetrySendRemainsUnverified() throws {
        let scenario = ArrowKeyScenario()
        scenario.caretPositions = [1, 1]
        scenario.retryDuration = .seconds(6)
        XCTAssertFalse(try scenario.run())
        XCTAssertEqual(scenario.sends, 2)
        XCTAssertEqual(scenario.probes, 2)
    }

    func testArrowMovementAndBoundaryNoOpsRemainVerified() throws {
        for (key, before, after) in [
            ("arrow_left", 1, 0), ("arrow_right", 1, 2),
            ("arrow_left", 0, 0), ("arrow_right", 3, 3),
        ] {
            let scenario = ArrowKeyScenario()
            scenario.key = key
            scenario.caretPositions = [before, after]
            XCTAssertTrue(try scenario.run())
            XCTAssertEqual(scenario.sends, 1)
        }
    }

    func testArrowRetryCanVerifyMovement() throws {
        let scenario = ArrowKeyScenario()
        scenario.caretPositions = [1, 1, 0]
        XCTAssertTrue(try scenario.run())
        XCTAssertEqual(scenario.sends, 2)
    }

    func testArrowMissingCaretVerificationRemainsUnverifiedAfterRetry() throws {
        let scenario = ArrowKeyScenario()
        scenario.caretPositions = [1, 1, nil]
        XCTAssertFalse(try scenario.run())
        XCTAssertEqual(scenario.sends, 2)
    }

    func testArrowBudgetStartsAfterFocusAcquisition() throws {
        let scenario = ArrowKeyScenario()
        scenario.focusDuration = .seconds(4) // Alone would exhaust the old pre-focus 3.5s budget.
        scenario.lookupDuration = .seconds(1)
        scenario.probeDurations = [.seconds(1), .milliseconds(200)]
        scenario.sendDuration = .seconds(1)
        XCTAssertTrue(try scenario.run())
        XCTAssertEqual(scenario.clock.now.offset, .milliseconds(7200))
        XCTAssertEqual(scenario.sends, 1)
    }

    func testArrowChangedValueRestoresOriginalAndDoesNotReportNoEffect() {
        let scenario = ArrowKeyScenario()
        scenario.observedValue = "changed"
        XCTAssertThrowsError(try scenario.run()) { error in
            guard case let GesturePerformer.GestureError.gestureFailed(reason) = error else {
                return XCTFail("Expected changed-value error, got \(error)")
            }
            XCTAssertEqual(reason, "arrow key changed the focused field value")
        }
        XCTAssertEqual(scenario.sends, 1)
        XCTAssertEqual(scenario.restorations, 1)
    }

    func testDecodePreservesKeyAndModifiersAndResponseType() throws {
        let request = try JSONDecoder().decode(WebSocketRequest.self, from: Data(
            #"{"type":"request_press_key","requestId":"key-1","key":"tab","modifiers":["shift","meta"]}"#.utf8
        ))
        guard case let .pressKey(payload) = request else { return XCTFail("Expected pressKey") }
        XCTAssertEqual(payload.key, "tab")
        XCTAssertEqual(payload.modifiers, ["shift", "meta"])
        XCTAssertEqual(payload.requestId, "key-1")
        XCTAssertEqual(request.requestType, .requestPressKey)
        XCTAssertEqual(RequestType.requestPressKey.responseType, .pressKeyResult)
    }
}

@MainActor
final class CaretMemoTests: XCTestCase {
    private func performer(clock: ArrowTestClock) -> GesturePerformer {
        GesturePerformer(elementLocator: RewriteFakeElementLocator(), keyboardClock: clock)
    }

    func testThreeLeftArrowsReuseBeforeProbeButConfirmEveryKey() throws {
        let memoScenario = ArrowKeyScenario()
        let baseline = ArrowKeyScenario()
        memoScenario.caretPositions = [3, 2, 1, 0]
        baseline.caretPositions = [3, 2, 2, 1, 1, 0]
        for scenario in [memoScenario, baseline] {
            scenario.lookupDuration = .milliseconds(100)
            scenario.sendDuration = .milliseconds(100)
            scenario.readDuration = .milliseconds(100)
            scenario.probeDurations = Array(repeating: .milliseconds(200), count: 6)
        }
        let gestures = performer(clock: memoScenario.clock)
        for _ in 0 ..< 3 {
            let memo = gestures.consumeCaretMemo(key: "arrow_left", modifiers: [])
            XCTAssertTrue(try memoScenario.run(
                knownCaret: { memo?.caret(bundleId: "app", value: $0) },
                verifiedCaret: { gestures.rememberCaret(bundleId: "app", value: $0, index: $1) }
            ))
            XCTAssertTrue(try baseline.run())
        }
        XCTAssertEqual(memoScenario.probes, 4) // One BEFORE + three AFTER probes.
        XCTAssertEqual(baseline.probes, 6)
        XCTAssertEqual(memoScenario.reads, 3)
        XCTAssertEqual(memoScenario.sends, 3)
        XCTAssertEqual(memoScenario.focusChecks, 3)
        XCTAssertEqual(memoScenario.resolutions, 3)
        XCTAssertEqual(memoScenario.clock.now.offset, .milliseconds(1700))
        XCTAssertEqual(baseline.clock.now.offset, .milliseconds(2100))
    }

    func testMemoRejectsDifferentValueBundleAndExpiredTTL() {
        let clock = ArrowTestClock()
        let gestures = performer(clock: clock)
        gestures.rememberCaret(bundleId: "app", value: "abc", index: 1)
        let memo = gestures.consumeCaretMemo(key: "arrow_left", modifiers: [])
        XCTAssertEqual(memo?.caret(bundleId: "app", value: "abc"), 1)
        XCTAssertNil(memo?.caret(bundleId: "app", value: "abd"))
        XCTAssertNil(memo?.caret(bundleId: "other", value: "abc"))
        XCTAssertNil(memo?.caret(bundleId: nil, value: "abc"))
        clock.advance(by: GesturePerformer.caretMemoTTL)
        XCTAssertNil(memo?.caret(bundleId: "app", value: "abc"))
        XCTAssertNil(gestures.consumeCaretMemo(key: "arrow_left", modifiers: []))
    }

    func testOtherKeysAndModifiersConsumeWithoutReusingMemo() {
        let gestures = performer(clock: ArrowTestClock())
        for (key, modifiers) in [
            ("backspace", []), ("delete", []), ("enter", []), ("tab", []), ("escape", []),
            ("arrow_up", []), ("arrow_down", []), ("unsupported", []),
            ("arrow_left", ["shift"]), ("delete", ["meta"]),
        ] {
            gestures.rememberCaret(bundleId: "app", value: "abc", index: 1)
            XCTAssertNil(gestures.consumeCaretMemo(key: key, modifiers: modifiers))
            XCTAssertNil(gestures.consumeCaretMemo(key: "arrow_left", modifiers: []))
        }
    }

    func testArrowMemoMissRunsBothProbes() throws {
        for miss in ["value", "bundle", "expired"] {
            let scenario = ArrowKeyScenario()
            let gestures = performer(clock: scenario.clock)
            gestures.rememberCaret(bundleId: "app", value: miss == "value" ? "old" : "abc", index: 1)
            let memo = gestures.consumeCaretMemo(key: "arrow_left", modifiers: [])
            if miss == "expired" { scenario.clock.advance(by: GesturePerformer.caretMemoTTL) }
            XCTAssertTrue(try scenario.run(
                knownCaret: { memo?.caret(bundleId: miss == "bundle" ? "other" : "app", value: $0) }
            ))
            XCTAssertEqual(scenario.probes, 2)
            XCTAssertEqual(scenario.reads, 1)
        }
    }

    func testExactOneStepAfterMemoHitRecordsFreshCaretOnlyWithinBudget() throws {
        for (key, after) in [("arrow_left", 0), ("arrow_right", 2)] {
            for exhausted in [false, true] {
                let scenario = ArrowKeyScenario()
                scenario.key = key
                scenario.caretPositions = [after]
                scenario.probeDurations = [exhausted ? .seconds(6) : .zero]
                let gestures = performer(clock: scenario.clock)
                gestures.rememberCaret(bundleId: "app", value: "abc", index: 1)
                let memo = gestures.consumeCaretMemo(key: key, modifiers: [])
                XCTAssertEqual(try scenario.run(
                    knownCaret: { memo?.caret(bundleId: "app", value: $0) },
                    verifiedCaret: { gestures.rememberCaret(bundleId: "app", value: $0, index: $1) }
                ), !exhausted)
                XCTAssertEqual(scenario.sends, 1)
                XCTAssertEqual(scenario.probes, 1)
                let next = gestures.consumeCaretMemo(key: key, modifiers: [])
                XCTAssertEqual(next?.caret(bundleId: "app", value: "abc"), exhausted ? nil : after)
            }
        }
    }

    func testMemoizedBoundaryIsUnverifiedAndLeavesMemoCleared() throws {
        for (key, boundary) in [("arrow_left", 0), ("arrow_right", 3)] {
            let scenario = ArrowKeyScenario()
            scenario.key = key
            scenario.caretPositions = [boundary]
            let gestures = performer(clock: scenario.clock)
            gestures.rememberCaret(bundleId: "app", value: "abc", index: boundary)
            let memo = gestures.consumeCaretMemo(key: key, modifiers: [])
            XCTAssertFalse(try scenario.run(
                knownCaret: { memo?.caret(bundleId: "app", value: $0) },
                verifiedCaret: { gestures.rememberCaret(bundleId: "app", value: $0, index: $1) }
            ))
            XCTAssertEqual(scenario.sends, 1)
            XCTAssertEqual(scenario.probes, 1)
            XCTAssertNil(gestures.consumeCaretMemo(key: key, modifiers: []))
        }
    }

    func testFreshBaselineBoundaryVerifiesAndRecordsCaret() throws {
        for (key, boundary) in [("arrow_left", 0), ("arrow_right", 3)] {
            let scenario = ArrowKeyScenario()
            scenario.key = key
            scenario.caretPositions = [boundary, boundary]
            let gestures = performer(clock: scenario.clock)
            XCTAssertTrue(try scenario.run(
                verifiedCaret: { gestures.rememberCaret(bundleId: "app", value: $0, index: $1) }
            ))
            XCTAssertEqual(scenario.sends, 1)
            XCTAssertEqual(scenario.probes, 2)
            let memo = gestures.consumeCaretMemo(key: key, modifiers: [])
            XCTAssertEqual(memo?.caret(bundleId: "app", value: "abc"), boundary)
        }
    }

    func testExternallyMovedCaretMatchingMemoDoesNotRetry() throws {
        for (key, retryAfter) in [("arrow_left", 0), ("arrow_right", 2)] {
            let scenario = ArrowKeyScenario()
            scenario.key = key
            // External movement to 2 (left) or 0 (right); the first key returns to memo 1.
            scenario.caretPositions = [1, retryAfter]
            let gestures = performer(clock: scenario.clock)
            gestures.rememberCaret(bundleId: "app", value: "abc", index: 1)
            let memo = gestures.consumeCaretMemo(key: key, modifiers: [])
            XCTAssertFalse(try scenario.run(
                knownCaret: { memo?.caret(bundleId: "app", value: $0) },
                verifiedCaret: { gestures.rememberCaret(bundleId: "app", value: $0, index: $1) }
            ))
            XCTAssertEqual(scenario.sends, 1)
            XCTAssertEqual(scenario.probes, 1)
            XCTAssertNil(gestures.consumeCaretMemo(key: key, modifiers: []))
        }
    }

    func testNoEffectAfterMemoHitIsUnverifiedAndLeavesMemoCleared() throws {
        let scenario = ArrowKeyScenario()
        scenario.caretPositions = [1, 1] // AFTER probes only; the retry must not run.
        let gestures = performer(clock: scenario.clock)
        gestures.rememberCaret(bundleId: "app", value: "abc", index: 1)
        let memo = gestures.consumeCaretMemo(key: "arrow_left", modifiers: [])
        XCTAssertFalse(try scenario.run(
            knownCaret: { memo?.caret(bundleId: "app", value: $0) },
            verifiedCaret: { gestures.rememberCaret(bundleId: "app", value: $0, index: $1) }
        ))
        XCTAssertEqual(scenario.sends, 1)
        XCTAssertEqual(scenario.probes, 1)
        XCTAssertEqual(scenario.reads, 1)
        XCTAssertNil(gestures.consumeCaretMemo(key: "arrow_left", modifiers: []))
    }

    func testFreshBaselineNoEffectRetriesAndThrows() {
        let scenario = ArrowKeyScenario()
        scenario.caretPositions = [1, 1, 1]
        XCTAssertThrowsError(try scenario.run()) { error in
            guard case GesturePerformer.GestureError.arrowNoEffect = error else {
                return XCTFail("Expected arrowNoEffect, got \(error)")
            }
        }
        XCTAssertEqual(scenario.sends, 2)
        XCTAssertEqual(scenario.probes, 3)
        XCTAssertEqual(scenario.reads, 2)
    }

    func testStaleMemoWrongDirectionIsUnverifiedAndLeavesMemoCleared() throws {
        let scenario = ArrowKeyScenario()
        scenario.caretPositions = [2] // Stale memo says 1, but AFTER left is 2.
        let gestures = performer(clock: scenario.clock)
        gestures.rememberCaret(bundleId: "app", value: "abc", index: 1)
        let memo = gestures.consumeCaretMemo(key: "arrow_left", modifiers: [])
        XCTAssertFalse(try scenario.run(
            knownCaret: { memo?.caret(bundleId: "app", value: $0) },
            verifiedCaret: { gestures.rememberCaret(bundleId: "app", value: $0, index: $1) }
        ))
        XCTAssertEqual(scenario.sends, 1)
        XCTAssertEqual(scenario.probes, 1)
        XCTAssertNil(gestures.consumeCaretMemo(key: "arrow_left", modifiers: []))
    }

    func testFreshBaselineWrongDirectionStillThrows() {
        let scenario = ArrowKeyScenario()
        scenario.caretPositions = [1, 2]
        XCTAssertThrowsError(try scenario.run()) { error in
            guard case let GesturePerformer.GestureError.gestureFailed(reason) = error else {
                return XCTFail("Expected wrong-direction error, got \(error)")
            }
            XCTAssertEqual(reason, "arrow key moved the caret in the wrong direction")
        }
        XCTAssertEqual(scenario.sends, 1)
        XCTAssertEqual(scenario.probes, 2)
    }

    func testMultiStepOrMissingAfterMemoHitIsUnverifiedAndLeavesMemoCleared() throws {
        let cases: [(String, Int, Int?)] = [("arrow_left", 2, 0), ("arrow_right", 1, 3), ("arrow_left", 1, nil)]
        for (key, before, after) in cases {
            let scenario = ArrowKeyScenario()
            scenario.key = key
            scenario.caretPositions = [after]
            let gestures = performer(clock: scenario.clock)
            gestures.rememberCaret(bundleId: "app", value: "abc", index: before)
            let memo = gestures.consumeCaretMemo(key: key, modifiers: [])
            XCTAssertFalse(try scenario.run(
                knownCaret: { memo?.caret(bundleId: "app", value: $0) },
                verifiedCaret: { gestures.rememberCaret(bundleId: "app", value: $0, index: $1) }
            ))
            XCTAssertEqual(scenario.sends, 1)
            XCTAssertEqual(scenario.probes, 1)
            XCTAssertNil(gestures.consumeCaretMemo(key: key, modifiers: []))
        }
    }

    func testUnverifiedOrChangedValueAfterMemoHitLeavesMemoCleared() {
        for changedValue in [false, true] {
            let scenario = ArrowKeyScenario()
            if changedValue {
                scenario.observedValue = "changed"
            } else {
                scenario.sendDuration = .seconds(6)
            }
            let gestures = performer(clock: scenario.clock)
            gestures.rememberCaret(bundleId: "app", value: "abc", index: 1)
            let memo = gestures.consumeCaretMemo(key: "arrow_left", modifiers: [])
            do {
                let verified = try scenario.run(
                    knownCaret: { memo?.caret(bundleId: "app", value: $0) },
                    verifiedCaret: { gestures.rememberCaret(bundleId: "app", value: $0, index: $1) }
                )
                XCTAssertFalse(changedValue)
                XCTAssertFalse(verified)
            } catch {
                XCTAssertTrue(changedValue)
                XCTAssertEqual(error.localizedDescription, "Gesture failed: arrow key changed the focused field value")
                XCTAssertEqual(scenario.restorations, 1)
            }
            XCTAssertNil(gestures.consumeCaretMemo(key: "arrow_left", modifiers: []))
        }
    }

    func testDeleteClearsMemoRecordedAndReusedByArrows() throws {
        let scenario = ArrowKeyScenario()
        scenario.caretPositions = [3, 2, 1, 1, 0]
        scenario.probeDurations = Array(repeating: .zero, count: 5)
        let gestures = performer(clock: scenario.clock)
        XCTAssertTrue(try scenario.run(
            verifiedCaret: { gestures.rememberCaret(bundleId: "app", value: $0, index: $1) }
        ))
        XCTAssertEqual(scenario.probes, 2)

        let memo = try XCTUnwrap(gestures.consumeCaretMemo(key: "arrow_left", modifiers: []))
        XCTAssertEqual(memo.caret(bundleId: "app", value: "abc"), 2)
        XCTAssertTrue(try scenario.run(
            knownCaret: { memo.caret(bundleId: "app", value: $0) },
            verifiedCaret: { gestures.rememberCaret(bundleId: "app", value: $0, index: $1) }
        ))
        XCTAssertEqual(scenario.probes, 3) // The prior arrow's memo replaces the BEFORE probe.

        XCTAssertNil(gestures.consumeCaretMemo(key: "delete", modifiers: []))
        let afterDelete = gestures.consumeCaretMemo(key: "arrow_left", modifiers: [])
        XCTAssertNil(afterDelete)
        XCTAssertTrue(try scenario.run(
            knownCaret: { afterDelete?.caret(bundleId: "app", value: $0) }
        ))
        XCTAssertEqual(scenario.probes, 5) // Both probes run after delete clears the memo.
        XCTAssertEqual(scenario.reads, 3)
        XCTAssertEqual(scenario.sends, 3)
    }

    func testInterveningNonKeyCommandInvalidatesMemoThroughDispatch() async throws {
        let gestures = performer(clock: ArrowTestClock())
        gestures.rememberCaret(bundleId: "app", value: "abc", index: 1)
        let handler = CommandHandler(
            elementLocator: RewriteFakeElementLocator(), gesturePerformer: gestures, perf: PerfProvider()
        )
        let request = try JSONDecoder().decode(WebSocketRequest.self, from: Data(
            #"{"type":"request_screenshot","requestId":"between-keys"}"#.utf8
        ))
        _ = await handler.handle(request)
        XCTAssertNil(gestures.consumeCaretMemo(key: "arrow_left", modifiers: []))
    }

    func testRejectedPressKeyInvalidatesMemoBeforeRunnerInvocation() async throws {
        let gestures = performer(clock: ArrowTestClock())
        gestures.rememberCaret(bundleId: "app", value: "abc", index: 1)
        let handler = CommandHandler(
            elementLocator: RewriteFakeElementLocator(), gesturePerformer: gestures, perf: PerfProvider()
        )
        let request = WebSocketRequest.pressKey(RequestPressKey(
            requestId: "stale-frame", frameContext: "stale", key: "arrow_left", modifiers: []
        ))
        let result = await handler.handle(request)
        let response = try XCTUnwrap(result as? WebSocketResponse)
        XCTAssertEqual(response.success, false)
        XCTAssertNil(gestures.consumeCaretMemo(key: "arrow_left", modifiers: []))
    }
}

@MainActor
final class PressKeyDispatchTests: XCTestCase {
    func testPressKeyRecordsPhasesThroughWebSocketDispatch() async throws {
        let clock = FakeMonotonicClock()
        let gestures = RewriteFakeGesturePerformer()
        let sink = FakeGestureLogSink()
        let phases = [
            "focusCheck", "elementResolution", "valueRead", "caretProbe",
            "keyDelivery", "outcomeConfirmation", "postCondition",
        ]
        gestures.onPressKey = {
            for phase in phases {
                GesturePhaseDiagnostics.current?.begin(phase)
                clock.advance(by: 400)
            }
        }
        let server = WebSocketServer(
            commandHandler: CommandHandler(
                elementLocator: RewriteFakeElementLocator(), gesturePerformer: gestures,
                perf: FakePerfTracking(flushResult: nil)
            ),
            perf: FakePerfTracking(flushResult: [.timing("handleRequest:request_press_key", durationMs: 2800)]),
            frameContext: FakeFrameContextRecording(token: nil),
            monotonicNowMs: { clock.now() }, gestureLogSink: sink
        )
        let done = expectation(description: "press key response")
        let responder = CapturingResponder(onEach: { done.fulfill() })
        server.dispatchCommand(
            Data(#"{"type":"request_press_key","requestId":"phases","key":"delete","modifiers":[]}"#.utf8),
            responder: responder
        )
        await fulfillment(of: [done], timeout: 2)
        let data = try XCTUnwrap(responder.captured.first)
        let response = try JSONDecoder().decode(WebSocketResponse.self, from: data)
        XCTAssertEqual(response.success, true)
        XCTAssertEqual(gestures.keyCalls.count, 1)
        let timing = try XCTUnwrap(response.perfTiming?.children?.last)
        XCTAssertEqual(timing.name, "gesturePhases")
        XCTAssertEqual(timing.durationMs, 2800)
        let children = try XCTUnwrap(timing.children)
        XCTAssertEqual(Array(children.map(\.name).suffix(phases.count)), phases)
        XCTAssertTrue(children.suffix(phases.count).allSatisfy { $0.durationMs == 400 })
        XCTAssertEqual(sink.lines.count, 1)
        XCTAssertTrue(sink.lines[0].contains("gesture_phases command=request_press_key"))
        XCTAssertTrue(sink.lines[0].contains("caretProbeMs=400"))
    }

    func testPressKeyForwardsModifiersAndPreservesFailure() async throws {
        let gestures = RewriteFakeGesturePerformer()
        let handler = CommandHandler(
            elementLocator: RewriteFakeElementLocator(),
            gesturePerformer: gestures,
            perf: PerfProvider()
        )
        let request = WebSocketRequest.pressKey(RequestPressKey(
            requestId: "key-1", key: "tab", modifiers: ["shift", "meta"]
        ))
        let result = await handler.handle(request)
        let response = try XCTUnwrap(result as? WebSocketResponse)
        XCTAssertEqual(response.type, "press_key_result")
        XCTAssertEqual(response.requestId, "key-1")
        XCTAssertEqual(response.success, true)
        XCTAssertEqual(gestures.keyCalls.count, 1)
        XCTAssertEqual(gestures.keyCalls.first?.0, "tab")
        XCTAssertEqual(gestures.keyCalls.first?.1, ["shift", "meta"])
        gestures.keyWarning = "Value did not change; delivery could not be confirmed"
        let warnedResult = await handler.handle(request)
        let warned = try XCTUnwrap(warnedResult as? WebSocketResponse)
        let warningJSON = try XCTUnwrap(String(data: JSONEncoder().encode(warned), encoding: .utf8))
        XCTAssertTrue(warningJSON.contains("\"warning\":\"Value did not change; delivery could not be confirmed\""))
        gestures.keyWarning = nil
        gestures.keyVerified = false
        let unverifiedResult = await handler.handle(request)
        let unverified = try XCTUnwrap(unverifiedResult as? WebSocketResponse)
        XCTAssertEqual(unverified.success, true)
        XCTAssertEqual(unverified.verified, false)
        gestures.keyError = .executionFailed("No focus")
        let failedResult = await handler.handle(request)
        let failure = try XCTUnwrap(failedResult as? WebSocketResponse)
        XCTAssertEqual(failure.success, false)
        XCTAssertEqual(failure.type, "press_key_result")
        XCTAssertEqual(failure.requestId, "key-1")
        XCTAssertEqual(gestures.keyCalls.count, 3)
    }
}
