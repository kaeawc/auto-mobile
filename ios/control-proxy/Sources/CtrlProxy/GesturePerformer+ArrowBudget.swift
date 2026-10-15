import Foundation
import ObjCExceptionCatcher
import os
#if os(iOS)
    import UIKit
#endif
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

extension GesturePerformer {
    enum ArrowOutcome: Equatable {
        case moved
        case boundaryNoOp
        case valueChanged
        case noEffect
        case wrongDirection
    }

    enum ArrowBudgetStep {
        case initialProbe, appKey, outcomeProbe, retry, completion
    }

    // One arrow press took ≈3.2s in a passing XCTestRunner CI simulator job;
    // failing jobs exhausted the old 3.5s budget before sending the key.
    nonisolated static let arrowBudgetMs = 6000

    /// Reserve time for the remaining synchronous XCUITest calls and their response.
    nonisolated static func arrowBudgetAllows(elapsedMs: Double, step: ArrowBudgetStep) -> Bool {
        let remainingMs = Double(arrowBudgetMs) - elapsedMs
        switch step {
        case .initialProbe: return remainingMs >= 2700
        case .appKey: return remainingMs >= 1800
        case .retry: return remainingMs >= 2000
        case .outcomeProbe: return remainingMs >= 1200
        case .completion: return remainingMs > 0
        }
    }

    struct ArrowBudget<C: Clock> where C.Duration == Duration {
        let clock: C
        let startedAt: C.Instant

        nonisolated init(clock: C) {
            self.clock = clock
            startedAt = clock.now
        }

        /// Pre-send exhaustion is an error; after sending, verification stays unverified.
        nonisolated func check(step: ArrowBudgetStep, consumedBy: String = "") throws -> Bool {
            let elapsed = startedAt.duration(to: clock.now).components
            let elapsedMs = Double(elapsed.seconds) * 1000 + Double(elapsed.attoseconds) / 1e15
            guard GesturePerformer.arrowBudgetAllows(elapsedMs: elapsedMs, step: step) else {
                switch step {
                case .initialProbe, .appKey:
                    throw GestureError.arrowBudgetExhausted(step: consumedBy, elapsedMs: Int(elapsedMs))
                case .outcomeProbe, .completion, .retry:
                    return false
                }
            }
            return true
        }
    }

    /// Shared by native fields and custom text wrappers. Each snapshot can require an IPC query.
    nonisolated static func firstFocusedCandidate<Elements: Sequence>(
        in elements: Elements,
        checkBudget: () throws -> Void,
        hasFocus: (Elements.Element) throws -> Bool
    ) rethrows
        -> Elements.Element?
    {
        for element in elements {
            // XCTest calls are synchronous; stop between queries rather than waiting
            // for the entire tree to resolve before noticing the arrow budget expired.
            try checkBudget()
            if try hasFocus(element) { return element }
        }
        return nil
    }

    /// Converts an XCUITest `NSException` (already bridged to `ObjCExceptionError` by
    /// `catchingObjCException`) raised before an arrow key is sent into the typed
    /// `GestureError.focusQueryFailed`, so the host gets a stable `errorCode` and a message
    /// saying the key was not sent instead of a raw `NSException(...)` string. Every other
    /// error, including `arrowBudgetExhausted`, passes through unchanged.
    nonisolated static func mappingFocusQueryException<T>(phase: String, _ body: () throws -> T) throws -> T {
        do {
            return try body()
        } catch let exception as ObjCExceptionError {
            throw GestureError.focusQueryFailed(
                phase: phase, detail: "\(exception.name): \(exception.reason ?? "no reason")"
            )
        }
    }

    /// Query sequencing shared with the XCUI adapter, so host tests cover budget forwarding
    /// through both native fields and custom wrappers without contacting an application.
    /// The adapter wraps each XCUITest closure in `catchingObjCException`; an exception from
    /// any of them fails the lookup as `GestureError.focusQueryFailed`.
    nonisolated static func resolveFocusedTextElement<Element, OtherElements: Sequence>(
        checkBudget: () throws -> Void,
        predicateMatch: () throws -> Element?,
        nativeQueries: [() throws -> [Element]],
        otherQuery: () throws -> OtherElements,
        nativeHasFocus: (Element) throws -> Bool,
        otherHasFocus: (Element) throws -> Bool
    )
        throws -> Element? where OtherElements.Element == Element
    {
        try mappingFocusQueryException(phase: "element resolution") {
            try checkBudget()
            if let match = try predicateMatch() { return match }
            for query in nativeQueries {
                try checkBudget()
                if let focused = try firstFocusedCandidate(
                    in: query(), checkBudget: checkBudget, hasFocus: nativeHasFocus
                ) {
                    return focused
                }
            }
            try checkBudget()
            return try firstFocusedCandidate(
                in: otherQuery(), checkBudget: checkBudget, hasFocus: otherHasFocus
            )
        }
    }

    /// The runner supplies XCUITest operations; host tests supply fast clock-driven fakes.
    nonisolated static func performHorizontalArrow<C: Clock, Element>(
        clock: C, key: String,
        requireFocus: () throws -> Void,
        resolveInput: (_ checkBudget: () throws -> Void) throws -> (Element?, String?),
        probeCaret: (Element, String?) throws -> Int?,
        sendKey: () throws -> Void,
        retryKey: (Element) throws -> Void,
        readValue: (Element) throws -> String,
        restoreValue: (Element, String) throws -> Void,
        knownCaret: (String) -> Int? = { _ in nil },
        verifiedCaret: (String, Int) -> Void = { _, _ in }
    )
        throws -> Bool where C.Duration == Duration
    {
        try requireFocus()
        // Focus acquisition is outside the arrow budget. Resolving the focused
        // element and its value below is the budgeted "focus check".
        let budget = ArrowBudget(clock: clock)
        _ = try budget.check(step: .initialProbe, consumedBy: "focus check")
        let (element, original) = try resolveInput {
            _ = try budget.check(step: .initialProbe, consumedBy: "focus check")
        }
        _ = try budget.check(step: .initialProbe, consumedBy: "focus check")
        let caretBefore: Int?
        let baselineIsMemo: Bool
        let lastStep: String
        if let original, let known = knownCaret(original) {
            caretBefore = known
            baselineIsMemo = true
            lastStep = "focus check"
        } else if let element {
            caretBefore = try probeCaret(element, original)
            baselineIsMemo = false
            lastStep = "caret probe"
        } else {
            caretBefore = nil
            baselineIsMemo = false
            lastStep = "focus check"
        }
        _ = try budget.check(step: .appKey, consumedBy: lastStep)
        try sendKey()
        guard let element, let original else { return false }

        for attempt in 0 ... 1 {
            guard let outcome = try observeArrowOutcome(
                key: key, original: original, caretBefore: caretBefore, baselineIsMemo: baselineIsMemo, budget: budget,
                readValue: { try readValue(element) },
                probeCaret: { try probeCaret(element, original) },
                restoreValue: { try restoreValue(element, original) },
                verifiedCaret: { verifiedCaret(original, $0) }
            ) else { return false }
            switch outcome {
            case .moved, .boundaryNoOp: return true
            case .wrongDirection:
                throw GestureError.gestureFailed("arrow key moved the caret in the wrong direction")
            case .valueChanged:
                return false
            case .noEffect:
                if attempt == 1 { throw GestureError.arrowNoEffect }
            }
            // The first send was a verified interior no-op, but an exhausted retry
            // budget leaves the whole retry sequence unverified; do not report no effect.
            guard try budget.check(step: .retry) else { return false }
            try retryKey(element)
        }
        return false
    }

    /// A memo baseline may be stale, so a mismatch cannot justify a retry or a caret verdict.
    private nonisolated static func observeArrowOutcome<C: Clock>(
        key: String, original: String, caretBefore: Int?, baselineIsMemo: Bool, budget: ArrowBudget<C>,
        readValue: () throws -> String,
        probeCaret: () throws -> Int?,
        restoreValue: () throws -> Void,
        verifiedCaret: (Int) -> Void
    )
        throws -> ArrowOutcome? where C.Duration == Duration
    {
        guard try budget.check(step: .outcomeProbe) else { return nil }
        let observed = try readValue()
        if arrowOutcome(key: key, original: original, observed: observed, before: caretBefore, after: nil)
            == .valueChanged
        {
            try restoreValue()
            throw GestureError.gestureFailed("arrow key changed the focused field value")
        }
        guard try budget.check(step: .outcomeProbe), let caretBefore else { return nil }
        let caretAfter = try probeCaret()
        guard try budget.check(step: .completion), let caretAfter else { return nil }
        // probeCaretIndex already checked that deleting its marker restored original.
        if baselineIsMemo {
            guard caretAfter == caretBefore + (key == "arrow_left" ? -1 : 1) else { return nil }
            verifiedCaret(caretAfter)
            return .moved
        }
        let outcome = arrowOutcome(
            key: key,
            original: original,
            observed: observed,
            before: caretBefore,
            after: caretAfter
        )
        if outcome == .moved || outcome == .boundaryNoOp { verifiedCaret(caretAfter) }
        return outcome
    }

    nonisolated static func arrowOutcome(
        key: String, original: String, observed: String, before: Int?, after: Int?
    )
        -> ArrowOutcome?
    {
        if observed != original { return .valueChanged }
        guard let before, let after else { return nil }
        if key == "arrow_left" {
            if after < before { return .moved }
            if before == 0, after == 0 { return .boundaryNoOp }
        } else {
            if after > before { return .moved }
            if before == original.count, after == before { return .boundaryNoOp }
        }
        if after != before { return .wrongDirection }
        return .noEffect
    }
}
