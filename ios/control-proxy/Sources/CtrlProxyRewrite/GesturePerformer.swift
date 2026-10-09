import Foundation
import ObjCExceptionCatcher
import os
#if os(iOS)
    import UIKit
#endif
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

/// Performs gestures and interactions using XCUITest APIs.
///
/// Rewrite archetype — `@MainActor`. Every gesture ultimately drives XCUITest on the
/// main thread. The reference hopped onto main per operation with `DispatchQueue.main.sync`
/// (`runOnMainThread` / `runOnMainThreadNonThrowing`); isolating the whole class to the
/// main actor removes those hops — each public method already runs there. `NSException`s
/// XCUITest can still raise are caught by `catchingObjCException` (throwing) and the
/// private `catchingObjCExceptionNonThrowing` (log + fallback), the rewrite's expression
/// of the two `runOnMainThread` variants minus the thread transfer.
///
/// What the port drops (reference-only concurrency scaffolding no longer needed inside a
/// single isolation domain): the `clipboardShadowQueue` that guarded the `clipboardShadow`
/// static against cross-thread `copy`/`paste` access — the shadow is now plain main-actor
/// state — and `os.Logger`/`gestureLog`, replaced by the rewrite's `print("[GesturePerformer] …")`
/// convention. The pure helpers the host gate exercises (`resolveClipboardGet`,
/// `scopedLinkCandidates`, the privacy-resource name maps) are `nonisolated static` so the
/// macOS test host can call them off the main actor.
///
/// PHASE 8 FIXUP (resolved): focus, visibility, close, and destructive-key post-condition
/// waits now await `KeyboardWait` with an injected monotonic `Clock`, yielding the main
/// actor between probes and checking the condition after the deadline's final sleep.
/// Close-action gates and horizontal-arrow budgets use the same injected clock.
/// The waits honour task cancellation via `CancellationError`, but WebSocketServer's serial
/// command-chain tasks are unstructured and never cancelled, so cancellation is currently unreachable in production.
@MainActor
public final class GesturePerformer: GesturePerforming {
    private let keyboardClock: any Clock<Duration>
    private var caretMemo: CaretMemo?
    private let logger = Logger(subsystem: "dev.jasonpearson.automobile", category: "GesturePerformer")

    nonisolated static let caretMemoTTL: Duration = .seconds(2)

    /// Baseline only for non-destructive horizontal arrows. Age and text checks
    /// cannot detect external caret movement: a memo only confirms an exact
    /// one-step move and is never the basis for a retry or a no-effect/direction
    /// verdict. Any mismatch is unverified. Forward delete always probes its
    /// BEFORE caret independently.
    struct CaretMemo: Sendable {
        let bundleId: String
        let value: String
        let index: Int
        private let age: @Sendable () -> Duration

        nonisolated init<C: Clock>(bundleId: String, value: String, index: Int, clock: C)
            where C.Duration == Duration
        {
            self.bundleId = bundleId
            self.value = value
            self.index = index
            let recordedAt = clock.now
            age = { recordedAt.duration(to: clock.now) }
        }

        nonisolated func caret(bundleId: String?, value: String?) -> Int? {
            let elapsed = age()
            guard bundleId == self.bundleId, value == self.value,
                  elapsed >= .zero, elapsed < GesturePerformer.caretMemoTTL,
                  index >= 0, index <= self.value.count
            else { return nil }
            return index
        }
    }

    public func invalidateCaretMemo() { caretMemo = nil }

    /// Clear before every key's validation/delivery; only plain horizontal arrows reuse the memo.
    func consumeCaretMemo(key: String, modifiers: [String]) -> CaretMemo? {
        let memo = caretMemo
        caretMemo = nil
        guard modifiers.isEmpty, ["arrow_left", "arrow_right"].contains(key.lowercased()) else { return nil }
        return memo
    }

    func rememberCaret(bundleId: String?, value: String, index: Int) {
        guard let bundleId, !bundleId.isEmpty else { return }
        caretMemo = CaretMemo(bundleId: bundleId, value: value, index: index, clock: keyboardClock)
    }

    nonisolated static func consumerUsage(for button: String) throws -> UInt32 {
        switch button {
        case "volume_up": return 0xE9
        case "volume_down": return 0xEA
        case "power": return 0x30
        default: throw GestureError.notSupported("Consumer button: \(button)")
        }
    }

    nonisolated static func swipeVelocity(distance: Double, duration: TimeInterval) -> Double? {
        guard distance.isFinite, duration.isFinite, distance > 0, duration > 0 else { return nil }
        return min(max(distance / duration, 100), 10000)
    }

    public enum GestureError: LocalizedError {
        case noApplication
        case elementNotFound(String)
        case gestureFailed(String)
        case arrowNoEffect
        case arrowBudgetExhausted(step: String, elapsedMs: Int)
        case notSupported(String)
        case missingParameter(String)
        case clipboardEmpty
        case clipboardReadUnavailable
        case unsupportedAction(String)

        public var errorDescription: String? {
            switch self {
            case .noApplication:
                return "No application available for gestures"
            case let .elementNotFound(id):
                return "Element not found: \(id)"
            case let .gestureFailed(reason):
                return "Gesture failed: \(reason)"
            case .arrowNoEffect:
                return "arrow keys have no effect on this iOS runtime; use Cmd+arrow (line start/end) or sendKeys text editing instead"
            case let .arrowBudgetExhausted(step, elapsedMs):
                return "arrow key was not sent: runner time budget exhausted at \(step) after \(elapsedMs)ms; retry"
            case let .notSupported(feature):
                return "Feature not supported: \(feature)"
            case let .missingParameter(param):
                return "Missing parameter: \(param)"
            case .clipboardEmpty:
                return "Clipboard is empty"
            case .clipboardReadUnavailable:
                return "Clipboard read unavailable; live pasteboard access may be restricted, so shadow clipboard content was not returned"
            case let .unsupportedAction(action):
                return "Unsupported action: \(action)"
            }
        }
    }

    enum ClipboardReadResult: Equatable {
        case value(String)
        case empty
        case unavailable
    }

    nonisolated static func resolveClipboardGet(readResult: ClipboardReadResult) throws -> String? {
        switch readResult {
        case let .value(text):
            return text.isEmpty ? nil : text
        case .empty:
            return nil
        case .unavailable:
            throw GestureError.clipboardReadUnavailable
        }
    }

    /// Cmd+V does not need the text, so only a pasteboard known to be empty refuses the paste.
    /// `.unavailable` is only produced after `hasStrings` was true, so it must still paste; the
    /// host's post-paste check decides whether the field changed (#10083).
    nonisolated static func resolveClipboardPaste(readResult: ClipboardReadResult) throws {
        switch readResult {
        case let .value(text):
            if text.isEmpty { throw GestureError.clipboardEmpty }
        case .empty:
            throw GestureError.clipboardEmpty
        case .unavailable:
            return
        }
    }

    /// Pressing a key needs a first responder, while text editing still needs
    /// evidence that an `.other` snapshot is a text input.
    nonisolated static func isFocusedSnapshotCandidate(
        hasFocus: Bool, isKnownTextInput: Bool, isOther: Bool,
        hasTextInputEvidence: Bool, forKeyPress: Bool
    )
        -> Bool
    {
        hasFocus && (isKnownTextInput || (isOther && (forKeyPress || hasTextInputEvidence)))
    }

    enum SnapshotFocusElementType {
        case textField, secureTextField, searchField, textView, other
    }

    nonisolated static func acceptSnapshotFocus(
        keyboardVisible: Bool, focusedElementType: SnapshotFocusElementType
    )
        -> Bool
    {
        if keyboardVisible { return true }
        switch focusedElementType {
        case .textField, .secureTextField, .searchField, .textView: return true
        case .other: return false
        }
    }

    struct FocusDiagnosticEntry {
        let kind: String
        let identifier: String
        let hasFocus: Bool
        let isSelected: Bool
        let valueLength: Int
        let frame: CGRect
    }

    struct FocusDiagnosticSummary {
        var counts: [String: Int] = [:]
        var entries: [String: [FocusDiagnosticEntry]] = [:]
        var visitedNodes = 0
        var truncated = false
    }

    /// Visit at most `maxNodes` snapshot nodes, without building a second tree.
    nonisolated static func boundedFocusDiagnostic<Node>(
        root: Node,
        maxNodes: Int = 200,
        maxDepth: Int = 64,
        children: (Node) -> [Node],
        describe: (Node) -> FocusDiagnosticEntry?
    )
        -> FocusDiagnosticSummary
    {
        var summary = FocusDiagnosticSummary()
        var pending: [(node: Node, depth: Int)] = [(root, 0)]
        while let current = pending.popLast() {
            if summary.visitedNodes >= maxNodes {
                summary.truncated = true
                break
            }
            summary.visitedNodes += 1
            if let entry = describe(current.node) {
                summary.counts[entry.kind, default: 0] += 1
                if summary.entries[entry.kind, default: []].count < 5 {
                    summary.entries[entry.kind, default: []].append(entry)
                }
            }
            let descendants = children(current.node)
            if current.depth >= maxDepth {
                if !descendants.isEmpty { summary.truncated = true }
                continue
            }
            pending.append(contentsOf: descendants.reversed().map { ($0, current.depth + 1) })
        }
        return summary
    }

    nonisolated static func canVerifyDestructiveKey(focusedValue: String?) -> Bool {
        focusedValue != nil
    }

    enum DestructiveKeyOutcome: Equatable {
        case deleted
        case boundaryNoOp
        case noEffect
    }

    nonisolated static func destructiveKeyOutcome(before: String, after: String) -> DestructiveKeyOutcome {
        if before.isEmpty { return .boundaryNoOp }
        return after.count < before.count ? .deleted : .noEffect
    }

    enum FocusedElementKind: CaseIterable {
        case textField, secureTextField, textView, searchField, other, unsupported
    }

    enum FocusedValueReliability: Equatable {
        case reliable, other, unreliable
    }

    nonisolated static func focusedValueReliability(for kind: FocusedElementKind) -> FocusedValueReliability {
        switch kind {
        case .textField, .secureTextField, .textView, .searchField: return .reliable
        case .other: return .other
        case .unsupported: return .unreliable
        }
    }

    enum DestructiveKeyPostCondition: Equatable {
        case delivered, failed, deliveredWithWarning, boundaryNoOp
    }

    nonisolated static func destructiveKeyPostCondition(
        kind: FocusedElementKind, before: String, after: String
    )
        -> DestructiveKeyPostCondition
    {
        switch destructiveKeyOutcome(before: before, after: after) {
        case .deleted: return .delivered
        case .boundaryNoOp: return .boundaryNoOp
        case .noEffect:
            if focusedValueReliability(for: kind) == .reliable { return .failed }
            return before == after ? .deliveredWithWarning : .delivered
        }
    }

    nonisolated static func destructiveKeyWarning(key: String) -> String {
        "Key '\(key)' was delivered, but the accessibility value did not change; " +
            "this element type does not reliably reflect edits, so delivery could not be confirmed"
    }

    nonisolated static func validateDestructiveKeyModifiers(normalizedKey: String, modifiers: [String]) throws {
        guard normalizedKey == "backspace" || normalizedKey == "delete", !modifiers.isEmpty else { return }
        throw GestureError.notSupported(
            "Modifiers (\(modifiers.joined(separator: ", "))) are not supported with \(normalizedKey); send the key without modifiers"
        )
    }

    nonisolated static func fieldText(snapshotValue: String?, value: String?, placeholderValue: String?) -> String {
        guard snapshotValue != nil, value != placeholderValue else { return "" }
        return value ?? ""
    }

    nonisolated static func forwardDeleteMarker(for original: String) -> String? {
        for codePoint in 0xE000 ... 0xE007 {
            guard let scalar = UnicodeScalar(codePoint) else { continue }
            let marker = String(scalar)
            if !original.contains(marker) { return marker }
        }
        return nil
    }

    nonisolated static func forwardDeleteMarkerIndex(original: String, probed: String, marker: String) -> Int? {
        guard probed.count == original.count + 1,
              let range = probed.range(of: marker),
              !probed[range.upperBound...].contains(marker),
              String(probed[..<range.lowerBound]) + String(probed[range.upperBound...]) == original
        else { return nil }
        return probed.distance(from: probed.startIndex, to: range.lowerBound)
    }

    nonisolated static func forwardDeleteResult(original: String, caretIndex: Int) -> String? {
        guard caretIndex >= 0, caretIndex < original.count else { return nil }
        return String(original.prefix(caretIndex)) + String(original.dropFirst(caretIndex + 1))
    }

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
            if before == 0 && after == 0 { return .boundaryNoOp }
        } else {
            if after > before { return .moved }
            if before == original.count && after == before { return .boundaryNoOp }
        }
        if after != before { return .wrongDirection }
        return .noEffect
    }

    /// A flat XCUITest links query cannot map a per-owner occurrence above zero.
    nonisolated static func validateSemanticLinkFallback(occurrence: Int, ownerResourceId: String?) throws {
        guard ownerResourceId != nil || occurrence <= 0 else {
            throw GestureError.gestureFailed(
                "Semantic link occurrence > 0 needs an owner in the XCUITest fallback; scope with container/subtext."
            )
        }
    }

    /// Includes a scoped owner when the owner is itself a link; XCUITest's
    /// descendants query otherwise excludes that element.
    nonisolated static func scopedLinkCandidates<Element>(
        owner: Element,
        ownerIsLink: Bool,
        descendants: [Element]
    )
        -> [Element]
    {
        ownerIsLink ? [owner] + descendants : descendants
    }

    /// Every AutoMobile permission name that maps to a resettable iOS
    /// `XCUIProtectedResource` (Xcode 26.3 header). The `all` keyword expands to
    /// this list; the TS host list in `IosPhysicalPermissions.ts`
    /// (`IOS_PHYSICAL_RESET_ALL_PERMISSIONS`) must stay in lock-step so the public
    /// tool path and the direct runner path reset the identical set.
    /// `local-network` is iOS 15.4+ only; below that OS version
    /// `protectedResource(for:)` returns nil so it fails honestly per-permission
    /// rather than being silently skipped.
    nonisolated static let allResettablePrivacyResourceNames = [
        "camera",
        "photos",
        "microphone",
        "contacts",
        "location",
        "calendar",
        "reminders",
        "media-library",
        "homekit",
        "focus",
        "local-network",
        "bluetooth",
        "keyboard-network",
        "health",
        "user-tracking",
    ]

    private nonisolated static let resettablePrivacyResourceAliases = Set(
        allResettablePrivacyResourceNames + [
            "photos-add",
            "contacts-limited",
            "location-always",
        ]
    )

    nonisolated static func canonicalPrivacyResourceName(for name: String) -> String {
        switch name {
        case "photos-add": return "photos"
        case "contacts-limited": return "contacts"
        case "location-always": return "location"
        default: return name
        }
    }

    nonisolated static func expandedPrivacyResourceNames(for name: String) -> [String]? {
        if name == "all" {
            return allResettablePrivacyResourceNames
        }
        if resettablePrivacyResourceAliases.contains(name) {
            return [name]
        }
        return nil
    }

    private nonisolated static let submitButtonNames = [
        "return", "return_arrow", "returnarrow", "go", "search", "done", "next",
        "send", "join", "route", "↵", "⏎", "↩",
    ]
    private nonisolated static let closeButtonNames = [
        "dismiss keyboard", "hide keyboard", "dismisskeyboard", "hidekeyboard",
    ] + submitButtonNames
    private nonisolated static let multilineCloseError =
        "Keyboard did not close: the focused field is multiline and has no dismiss key; tap outside the field or use a different action"

    enum CloseAttempt: Equatable {
        case matchedButton
        case newline
        case escape
    }

    enum ImeFocusedField: Equatable, Sendable {
        case absent
        case singleLine
        case multiline
        case unresolved
    }

    enum ImeActionDecision: Equatable, Sendable {
        case tapKey(index: Int)
        case typeReturn
        case notAvailable(String)
    }

    /// Match the requested action exactly (case-insensitive) by label or identifier.
    /// A different action label, including plain Return, is not an IME action
    /// for a text view. Single-line and unresolved inputs retain the Return fallback,
    /// including focused inputs using a hardware keyboard.
    /// An explicitly disabled matching key must not be bypassed by that fallback.
    nonisolated static func imeActionDecision(
        action: String,
        focusedField: ImeFocusedField,
        keyboardVisible: Bool,
        keys: [(label: String, identifier: String, isEnabled: Bool)]
    )
        -> ImeActionDecision
    {
        let action = action.lowercased()
        guard ["done", "go", "search", "send", "next"].contains(action) else {
            return .notAvailable("IME action: \(action)")
        }
        if keyboardVisible {
            let matches = keys.indices.filter {
                keys[$0].label.lowercased() == action || keys[$0].identifier.lowercased() == action
            }
            if let index = matches.first(where: { keys[$0].isEnabled }) {
                return .tapKey(index: index)
            }
            if !matches.isEmpty {
                return .notAvailable("IME action '\(action)' is not available: the keyboard action key is disabled")
            }
        } else if focusedField == .absent {
            return .notAvailable(
                "IME action '\(action)' is not available: no keyboard is visible and no focused text field was found"
            )
        }
        if focusedField == .multiline {
            return .notAvailable(
                "IME action '\(action)' is not available for this multi-line field: Return would insert a line break"
            )
        }
        return .typeReturn
    }

    nonisolated static func closeAttemptOrder(
        hasEnabledMatch: Bool,
        hasSubmitKey: Bool,
        isMultiline: Bool
    )
        -> [CloseAttempt]
    {
        (hasEnabledMatch ? [.matchedButton] : []) + (!isMultiline && hasSubmitKey ? [.newline] : []) + [.escape]
    }

    nonisolated static func closeKeyCandidates(
        _ labels: [(label: String, identifier: String)],
        isMultiline: Bool = false
    )
        -> [(
            index: Int,
            method: String
        )]
    {
        let keys = labels.map { "\($0.label) \($0.identifier)".lowercased() }
        let dismiss = keys.indices.filter {
            keys[$0].contains("dismiss keyboard") || keys[$0].contains("hide keyboard") ||
                keys[$0].contains("dismisskeyboard") || keys[$0].contains("hidekeyboard")
        }.map { (index: $0, method: "dismissKey") }
        let returns = keys.indices.filter { index in
            let words = keys[index].components(separatedBy: CharacterSet.alphanumerics.inverted)
            let isSubmit = ["return", "go", "search", "done", "next", "send", "join", "route"].contains {
                words.contains($0)
            }
                || keys[index].contains("returnarrow")
                || ["↵", "⏎", "↩"].contains { keys[index].contains($0) }
            return !dismiss.contains(where: { $0.index == index }) && isSubmit
        }.map { (index: $0, method: "returnKey") }
        return dismiss + (isMultiline ? [] : returns)
    }

    #if canImport(XCTest) && os(iOS)
        private static func focusedElementKind(_ type: XCUIElement.ElementType) -> FocusedElementKind {
            switch type {
            case .textField: return .textField
            case .secureTextField: return .secureTextField
            case .textView: return .textView
            case .searchField: return .searchField
            case .other: return .other
            default: return .unsupported
            }
        }

        private weak var application: XCUIApplication?
        /// Strong reference to keep the application alive when set via updateApplication.
        /// Without this, the weak `application` property would immediately deallocate
        /// freshly created XCUIApplication instances that have no other strong owner.
        private var ownedApplication: XCUIApplication?
        private let elementLocator: ElementLocating
        private let tapDiagnosticsSampler: any TapDiagnosticsSampling

        /// Cached SpringBoard app reference for system alert handling.
        private lazy var springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

        public init(
            application: XCUIApplication? = nil,
            elementLocator: ElementLocating,
            keyboardClock: any Clock<Duration> = ContinuousClock()
        ) {
            DeviceRotation.startMonitoring()
            self.application = application
            self.elementLocator = elementLocator
            self.keyboardClock = keyboardClock
            tapDiagnosticsSampler = DefaultTapDiagnosticsSampler()
        }

        init(
            application: XCUIApplication?, elementLocator: ElementLocating,
            keyboardClock: any Clock<Duration>, tapDiagnosticsSampler: any TapDiagnosticsSampling
        ) {
            DeviceRotation.startMonitoring()
            self.application = application
            self.elementLocator = elementLocator
            self.keyboardClock = keyboardClock
            self.tapDiagnosticsSampler = tapDiagnosticsSampler
        }

        /// `catchingObjCException` for methods that cannot propagate errors: a caught
        /// `NSException` is logged and `fallback` returned. The reference's
        /// `runOnMainThreadNonThrowing`; the `main.sync` hop is gone (we run on main) but
        /// the XCUITest `NSException` guard remains necessary.
        private func catchingObjCExceptionNonThrowing<T>(_ block: () -> T, fallback: T) -> T {
            do {
                return try catchingObjCException(block)
            } catch {
                print("[GesturePerformer] ObjC exception in non-throwing context: \(error)")
                return fallback
            }
        }

        // MARK: - Keyboard Focus Helpers

        /// Returns true if any text-input element in the snapshot has UIKit
        /// first-responder focus (`snapshot.hasFocus`).
        ///
        /// Used as a fallback when the `hasKeyboardFocus == true` NSPredicate
        /// returns no results — which happens with React Native `TextInput`
        /// fields and other frameworks whose UITextField wrapper is the UIKit
        /// first responder but does not propagate `hasKeyboardFocus` through
        /// the XCTest accessibility bridge. `snapshot.hasFocus` reliably
        /// reflects UIKit first-responder state, mirroring what
        /// `ElementLocator` uses to populate `focused: true` in the hierarchy.
        ///
        /// For `.other` (RN wrapper views), require a non-empty `value` or
        /// `placeholderValue` before treating the node as a text input —
        /// otherwise any focused `.other` (a button, custom control, etc.)
        /// would register as focused text and we'd try to delete from it.
        ///
        /// Depth-guarded at 64 to bound recursion on pathological trees.
        private static func focusedTextInputType(
            _ snapshot: XCUIElementSnapshot,
            forKeyPress: Bool = false,
            depth: Int = 0
        )
            -> XCUIElement.ElementType?
        {
            if depth > 64 { return nil }

            let type = snapshot.elementType
            let isKnownTextInput = type == .textField
                || type == .textView
                || type == .secureTextField
                || type == .searchField
            let isTextLikeOther = type == .other && snapshotLooksLikeTextInput(snapshot)

            if isFocusedSnapshotCandidate(
                hasFocus: snapshot.hasFocus,
                isKnownTextInput: isKnownTextInput,
                isOther: type == .other,
                hasTextInputEvidence: isTextLikeOther,
                forKeyPress: forKeyPress
            ) {
                return type
            }
            for child in snapshot.children {
                if let focusedType = focusedTextInputType(child, forKeyPress: forKeyPress, depth: depth + 1) {
                    return focusedType
                }
            }
            return nil
        }

        /// Heuristic for treating an `.other`-typed snapshot as a text-input
        /// wrapper. Text fields expose a non-empty `value` (current content)
        /// or a `placeholderValue` (hint text); plain buttons / containers
        /// do not.
        private static func snapshotLooksLikeTextInput(_ snapshot: XCUIElementSnapshot) -> Bool {
            if let value = snapshot.value as? String, !value.isEmpty {
                return true
            }
            if let placeholder = snapshot.placeholderValue, !placeholder.isEmpty {
                return true
            }
            return false
        }

        /// Detection strategies for keyboard focus, in order of cost:
        ///
        /// 1. `hasKeyboardFocus == true` NSPredicate — cheap, reliable for
        ///    standard UIKit apps.
        /// 2. Snapshot `hasFocus` traversal — catches React Native TextInputs
        ///    and other frameworks whose first-responder status isn't
        ///    exposed through `hasKeyboardFocus`.
        /// 3. Keyboard-visibility probe — last-resort safety net; if the
        ///    system keyboard is visible, something in the user-visible app
        ///    must own first responder.
        ///
        /// Returns `(hasFocus, strategy)` so the caller can log which path
        /// won.
        private func detectKeyboardFocus(app: XCUIApplication, forKeyPress: Bool = false) throws -> (Bool, String) {
            try catchingObjCException {
                // Strategy 1: predicate
                let byPredicate = app.descendants(matching: .any)
                    .matching(NSPredicate(format: "hasKeyboardFocus == true"))
                    .firstMatch
                    .exists
                if byPredicate {
                    return (true, "predicate")
                }

                // Strategy 2: snapshot.hasFocus traversal. Skip SpringBoard —
                // the app we want is never SpringBoard in a text-input flow.
                if app.identifier != "com.apple.springboard",
                   let snapshot = try? app.snapshot(),
                   let focusedType = GesturePerformer.focusedTextInputType(snapshot, forKeyPress: forKeyPress)
                {
                    let keyboardVisible = isKeyboardVisible(app: app)
                    let focusType: SnapshotFocusElementType
                    switch focusedType {
                    case .textField: focusType = .textField
                    case .secureTextField: focusType = .secureTextField
                    case .searchField: focusType = .searchField
                    case .textView: focusType = .textView
                    default: focusType = .other
                    }
                    if GesturePerformer.acceptSnapshotFocus(
                        keyboardVisible: keyboardVisible, focusedElementType: focusType
                    ) {
                        return (true, "snapshot.hasFocus")
                    }
                    return (false, "snapshot.hasFocus-without-keyboard")
                }

                // Strategy 3: keyboard-visibility probe. Covers the case
                // where neither the predicate nor the snapshot picks up
                // focus (e.g., unknown/stale foreground bundle ID) but the
                // user-visible keyboard proves something owns first responder.
                if self.springboard.keyboards.firstMatch.exists || app.keyboards.firstMatch.exists {
                    return (true, "keyboard-visibility")
                }

                return (false, "none")
            }
        }

        /// Check that some element in the app has keyboard focus.
        /// Throws with a contextual error message if no focus is detected.
        /// On failure, the thrown error embeds a focus-diagnostic summary so
        /// it surfaces in the MCP response — not just in device logs.
        private func requireKeyboardFocus(
            app: XCUIApplication, context: String, forKeyPress: Bool = false
        )
            throws
        {
            let queryStart = Date()
            let (hasFocus, strategy) = try detectKeyboardFocus(app: app, forKeyPress: forKeyPress)
            let elapsedMs = Int(Date().timeIntervalSince(queryStart) * 1000)
            print(
                "[GesturePerformer] requireKeyboardFocus hasFocus=\(hasFocus) strategy=\(strategy) context=\"\(context)\" elapsedMs=\(elapsedMs)"
            )

            guard hasFocus else {
                let appLabel = catchingObjCExceptionNonThrowing({ app.label }, fallback: "unknown")
                print("[GesturePerformer] requireKeyboardFocus appLabel=\(appLabel)")
                let diag = buildFocusDiagnostic(app: app, reason: "requireKeyboardFocus: \(context)")
                print("[GesturePerformer] \(diag)")
                throw GestureError.gestureFailed(
                    "No element has keyboard focus — \(context). Diagnostic: \(diag)"
                )
            }
        }

        /// Tap an element and poll for keyboard focus (500ms timeout, 50ms
        /// intervals). Uses the same 3-strategy detection as
        /// `requireKeyboardFocus`. Timeout was extended from 200ms → 500ms
        /// to accommodate the snapshot-based fallback, which does an extra
        /// XPC round-trip per poll when the predicate misses.
        ///
        /// Throws if the element does not receive focus after the tap.
        private func tapAndAwaitKeyboardFocus(
            app: XCUIApplication,
            element: XCUIElement,
            resourceId: String
        )
            async throws
        {
            let result = try await KeyboardWait.focus(
                clock: keyboardClock,
                tap: {
                    try catchingObjCException {
                        print(
                            "[GesturePerformer] tapAndAwaitKeyboardFocus begin resourceId=\(resourceId) exists=\(element.exists) isHittable=\(element.isHittable) type=\(element.elementType.rawValue)"
                        )
                        element.tap()
                    }
                },
                probe: { try self.detectKeyboardFocus(app: app) }
            )
            let hasFocus = result.hasFocus
            let strategy = result.strategy
            let iterations = result.iterations
            let elapsedMs = result.elapsedMs
            print(
                "[GesturePerformer] tapAndAwaitKeyboardFocus done resourceId=\(resourceId) hasFocus=\(hasFocus) strategy=\(strategy) iterations=\(iterations) elapsedMs=\(elapsedMs)"
            )

            guard hasFocus else {
                let diag = buildFocusDiagnostic(app: app, reason: "tapAndAwaitKeyboardFocus: \(resourceId)")
                print("[GesturePerformer] \(diag)")
                throw GestureError.gestureFailed(
                    "Element '\(resourceId)' did not receive keyboard focus after tap. Diagnostic: \(diag)"
                )
            }
        }

        /// Build a compact diagnostic string enumerating candidate text-entry
        /// elements and their focus state, for #1925-style "no keyboard focus"
        /// failures. Returned as a single line so it fits in a WebSocket error.
        private func buildFocusDiagnostic(app: XCUIApplication, reason: String) -> String {
            catchingObjCExceptionNonThrowing({
                guard let snapshot = try? app.snapshot() else {
                    return "reason=\"\(reason)\" [diagnostic collection failed]"
                }
                let summary = GesturePerformer.boundedFocusDiagnostic(
                    root: snapshot,
                    children: { $0.children },
                    describe: { node in
                        let kind: String
                        switch node.elementType {
                        case .textField: kind = "textFields"
                        case .secureTextField: kind = "secureTextFields"
                        case .textView: kind = "textViews"
                        case .searchField: kind = "searchFields"
                        default: return nil
                        }
                        return FocusDiagnosticEntry(
                            kind: kind,
                            identifier: node.identifier,
                            hasFocus: node.hasFocus,
                            isSelected: node.isSelected,
                            valueLength: (node.value as? String)?.count ?? 0,
                            frame: node.frame
                        )
                    }
                )
                var parts: [String] = []
                parts.append("reason=\"\(reason)\"")
                parts.append("app.label=\"\(snapshot.label)\"")
                parts.append("app.identifier=\"\(snapshot.identifier)\"")

                for name in ["textFields", "secureTextFields", "textViews", "searchFields"] {
                    parts.append("\(name).count=\(summary.counts[name, default: 0])")
                    for (index, entry) in (summary.entries[name] ?? []).enumerated() {
                        let frame = entry.frame
                        parts.append(
                            "\(name)[\(index)]={id=\"\(entry.identifier)\",hasKeyboardFocus=unknown,hasFocus=\(entry.hasFocus),isSelected=\(entry.isSelected),isHittable=unknown,value.len=\(entry.valueLength),frame=\(ElementBounds.clampedInt(frame.origin.x)),\(ElementBounds.clampedInt(frame.origin.y)),\(ElementBounds.clampedInt(frame.size.width)),\(ElementBounds.clampedInt(frame.size.height))}"
                        )
                    }
                }

                // A single app snapshot cannot establish keyboard visibility or
                // SpringBoard state; preserve these diagnostic keys honestly.
                parts.append("app.keyboards.count=unknown")
                parts.append("springboard.keyboards.count=unknown")
                parts.append("snapshot.nodes=\(summary.visitedNodes)")
                parts.append("snapshot.truncated=\(summary.truncated)")
                return parts.joined(separator: " | ")
            }, fallback: "reason=\"\(reason)\" [diagnostic collection failed]")
        }

        public func setApplication(_ app: XCUIApplication) {
            ownedApplication = nil
            pinnedBundleId = nil
            application = app
        }

        /// Bundle id `application` was built for; nil when it was injected without one.
        private var pinnedBundleId: String?

        /// The application a coordinate gesture targets: the pinned app unless the locator's
        /// tracked foreground app has moved on (e.g. after `simctl launch`, #10858).
        private func gestureApplication() -> XCUIApplication? {
            gestureApplication(for: gestureApplicationTarget())
        }

        private func gestureApplicationTarget() -> GestureApplicationTarget {
            GestureApplicationTarget.resolve(
                pinnedBundleId: pinnedBundleId,
                trackedBundleId: elementLocator.foregroundBundleId
            )
        }

        private func gestureApplication(for target: GestureApplicationTarget) -> XCUIApplication? {
            switch target {
            case .keepPinned:
                return application
            case let .rebind(bundleId):
                updateApplication(bundleId: bundleId)
                return application
            }
        }

        /// Delivers a one-finger tap or swipe without an `XCUIApplication` when the foreground app
        /// was launched outside the runner (#10858); see `GestureDeliveryRoute`. Returns false when
        /// the route does not apply or the private synthesis symbols are unavailable, so the caller
        /// keeps its `XCUICoordinate` path. The pinned app is left as is, so a later `launchApp`
        /// still pins its app and returns gestures to the `XCUICoordinate` path.
        private func deliverToUnpinnedForegroundApp(
            target: GestureApplicationTarget, forced: TapCoordinateStrategy?,
            start: GesturePoint, end: GesturePoint, duration: TimeInterval
        )
            throws -> Bool
        {
            let route = GestureDeliveryRoute.resolve(
                target: target, forced: forced, geometry: elementLocator.gestureCoordinateGeometry
            )
            guard case let .synthesizedEventRecord(orientation) = route else { return false }
            return try catchingObjCException { () -> Bool in
                GesturePhaseDiagnostics.current?.begin("synthesizedGesture")
                defer { GesturePhaseDiagnostics.current?.begin("postGesture") }
                var errorMessage: NSString?
                var symbolsUnavailable: ObjCBool = false
                // A tap is a stationary path; 0.05 s is the synthesis helper's minimum contact.
                let succeeded = ObjCExceptionCatcher_synthesizeMultiFingerSwipe(
                    CGFloat(start.x), CGFloat(start.y), CGFloat(end.x), CGFloat(end.y),
                    1, 0, max(duration, 0.05), orientation, &symbolsUnavailable, &errorMessage
                )
                if succeeded {
                    logger.notice(
                        "gesture synthesized for unpinned foreground app orientation=\(orientation, privacy: .public)"
                    )
                    return true
                }
                guard symbolsUnavailable.boolValue else {
                    throw GestureError.gestureFailed(errorMessage as String? ?? "gesture synthesis failed")
                }
                logger.warning(
                    "gesture synthesis unavailable; using XCUICoordinate: \((errorMessage as String?) ?? "", privacy: .public)"
                )
                return false
            }
        }

        // MARK: - Tap Gestures

        public func tap(x: Double, y: Double, duration: TimeInterval = 0) throws {
            try tap(x: x, y: y, duration: duration, strategy: nil)
        }

        public func tap(x: Double, y: Double, duration: TimeInterval, strategy: String?) throws {
            _ = try performTap(x: x, y: y, duration: duration, requested: nil, forced: forcedTapStrategy(strategy))
        }

        private func forcedTapStrategy(_ value: String?) -> TapCoordinateStrategy? {
            guard let value else { return nil }
            let strategy = TapCoordinateStrategy(rawValue: value)
            if strategy == nil { logger.warning("Ignoring unknown tapStrategy: \(value, privacy: .public)") }
            return strategy
        }

        public func tapWithDiagnostics(x: Double, y: Double, durationMs: Int) throws -> TapDiagnostics {
            try tapWithDiagnostics(x: x, y: y, durationMs: durationMs, strategy: nil)
        }

        public func tapWithDiagnostics(
            x: Double, y: Double, durationMs: Int, strategy: String?
        )
            throws -> TapDiagnostics
        {
            // The requested value is always returned when delivery succeeds, even if every read fails.
            let requested = TapDiagnostics.Requested(x: x, y: y, durationMs: durationMs)
            return try performTap(
                x: x, y: y, duration: TimeInterval(durationMs) / 1000.0, requested: requested,
                forced: forcedTapStrategy(strategy)
            )
                ?? TapDiagnostics(requested: requested, sampleErrors: ["sampler: no sample returned"])
        }

        /// Cached observation geometry keeps the single-panel opt-out path free of new platform reads.
        private func performTap(
            x: Double, y: Double, duration: TimeInterval, requested: TapDiagnostics.Requested?,
            forced: TapCoordinateStrategy?
        )
            throws -> TapDiagnostics?
        {
            GesturePhaseDiagnostics.current?.begin("targetResolution")
            let target = gestureApplicationTarget()
            let point = GesturePoint(x: x, y: y)
            if try deliverToUnpinnedForegroundApp(
                target: target, forced: forced, start: point, end: point, duration: duration
            ) {
                return requested.map { requested in
                    TapDiagnostics(requested: .init(
                        x: requested.x, y: requested.y, durationMs: requested.durationMs,
                        coordinateConstruction: "synthesizedScreenPoint"
                    ))
                }
            }
            guard let app = gestureApplication(for: target) else {
                throw GestureError.noApplication
            }

            return try catchingObjCException {
                GesturePhaseDiagnostics.current?.begin("coordinateResolution")
                let provider = XCUIGestureCoordinateProvider(app: app, locator: elementLocator)
                let factory = try DisplayGestureFactory(provider: provider, forced: forced)
                var diagnostics: TapDiagnostics?
                defer { GesturePhaseDiagnostics.current?.begin("postGesture") }
                let delivery = try factory.deliver(
                    start: GesturePoint(x: x, y: y), press: duration, forced: forced
                ) { candidate in
                    if let requested {
                        let coordinate = candidate.coordinate
                        let selection = candidate.selection
                        let construction = candidate.route == .displayTargetedRecord ? "displayTargetedPoint" :
                            coordinate?.windowTranslation != nil ? "windowOriginPlusPointOffset" :
                            (selection.strategy == .legacy ? "appFrameOriginPlusPointOffset" : "appNormalizedOffset")
                        let requested = TapDiagnostics.Requested(
                            x: requested.x, y: requested.y, durationMs: requested.durationMs,
                            coordinateConstruction: construction
                        )
                        diagnostics = tapDiagnosticsSampler.sample(requested: requested, reads: TapDiagnosticReads(
                            baseScreenPoint: { try coordinate.map { try Self.diagnosticPoint($0.base.screenPoint) } },
                            resolvedScreenPoint: {
                                try coordinate.map { try Self.diagnosticPoint($0.resolved.screenPoint) }
                            },
                            // Record synthesis does not construct an XCUICoordinate; its points are omitted.
                            application: {
                                try .init(frame: Self.diagnosticFrame(
                                    (coordinate?.application ?? provider.observedApplication).frame
                                ))
                            },
                            screen: {
                                let screen = UIScreen.main
                                guard screen.scale.isFinite, screen.nativeScale.isFinite else {
                                    throw GestureError.gestureFailed("non-finite diagnostic scale")
                                }
                                return try .init(
                                    bounds: Self.diagnosticFrame(screen.bounds),
                                    nativeBounds: Self.diagnosticFrame(screen.nativeBounds),
                                    scale: Double(screen.scale), nativeScale: Double(screen.nativeScale),
                                    source: "runnerProcessUIScreenMain"
                                )
                            },
                            deviceOrientation: { .device(rawValue: XCUIDevice.shared.orientation.rawValue) },
                            interfaceOrientation: { DeviceRotation.tapDiagnosticInterfaceOrientation() }
                        ))
                    }
                    GesturePhaseDiagnostics.current?.begin("xcuitestGesture")
                }
                if var sample = diagnostics {
                    factory.annotate(&sample, delivery: delivery)
                    diagnostics = sample
                    logger.warning("\(sample.logLine(), privacy: .public)")
                } else if delivery.selection.strategy != .legacy || (forced != nil && forced != .legacy) || factory
                    .mismatch
                {
                    var sample = TapDiagnostics(requested: .init(
                        x: x, y: y, durationMs: Self.diagnosticDurationMs(duration)
                    ))
                    factory.annotate(&sample, delivery: delivery)
                    logger.warning("\(sample.logLine(), privacy: .public)")
                }
                return diagnostics
            }
        }

        static func diagnosticDurationMs(_ duration: TimeInterval) -> Int {
            duration.isFinite && abs(duration * 1000) < Double(Int.max) ? Int(duration * 1000) : 0
        }

        private static func diagnosticPoint(_ point: CGPoint) throws -> TapDiagnostics.Point {
            guard point.x.isFinite,
                  point.y.isFinite else { throw GestureError.gestureFailed("non-finite diagnostic point") }
            return .init(x: Double(point.x), y: Double(point.y))
        }

        private static func diagnosticFrame(_ frame: CGRect) throws -> TapDiagnostics.Frame {
            guard frame.origin.x.isFinite, frame.origin.y.isFinite, frame.width.isFinite, frame.height.isFinite else {
                throw GestureError.gestureFailed("non-finite diagnostic frame")
            }
            return .init(
                x: Double(frame.origin.x),
                y: Double(frame.origin.y),
                width: Double(frame.width),
                height: Double(frame.height)
            )
        }

        private func logRelativeCoordinate(_ selection: GestureCoordinateSelection, gesture: String) {
            if selection.strategy != .legacy {
                logger.warning(
                    "tap_diagnostics gesture=\(gesture, privacy: .public) \(selection.logFields, privacy: .public)"
                )
            }
        }

        // MARK: - Swipe Gestures

        public func swipe(startX: Double, startY: Double, endX: Double, endY: Double, duration: TimeInterval) throws {
            GesturePhaseDiagnostics.current?.begin("targetResolution")
            let target = gestureApplicationTarget()
            if try deliverToUnpinnedForegroundApp(
                target: target, forced: nil, start: GesturePoint(x: startX, y: startY),
                end: GesturePoint(x: endX, y: endY), duration: duration
            ) {
                return
            }
            guard let app = gestureApplication(for: target) else {
                throw GestureError.noApplication
            }

            try catchingObjCException {
                GesturePhaseDiagnostics.current?.begin("coordinateResolution")
                let factory = try DisplayGestureFactory(
                    provider: XCUIGestureCoordinateProvider(app: app, locator: elementLocator)
                )
                let distance = hypot(endX - startX, endY - startY)
                let velocity = Self.swipeVelocity(distance: distance, duration: duration)

                defer { GesturePhaseDiagnostics.current?.begin("postGesture") }
                let delivery = try factory.deliver(
                    start: GesturePoint(x: startX, y: startY), end: GesturePoint(x: endX, y: endY),
                    press: 0.05, move: duration, velocity: velocity
                ) { _ in
                    GesturePhaseDiagnostics.current?.begin("xcuitestGesture")
                }
                if factory.mismatch {
                    // The line describes the swipe's start point; it is not a tap (#8379).
                    var sample = TapDiagnostics(requested: .init(
                        x: startX, y: startY, durationMs: Self.diagnosticDurationMs(duration), mode: "swipe"
                    ))
                    factory.annotate(&sample, delivery: delivery)
                    logger.warning("\(sample.logLine(gesture: "swipe"), privacy: .public)")
                }
            }
        }

        /// App-independent event delivery avoids stale-app activation and lock-screen idle waits.
        public func lockScreenSwipe(
            startX: Double, startY: Double, endX: Double, endY: Double, duration: TimeInterval
        )
            throws
        {
            GesturePhaseDiagnostics.current?.begin("targetResolution")
            // No XCUIApplication is resolved: the lock screen may leave the tracked app stale.
            let synthesized = try catchingObjCException { () -> Bool in
                GesturePhaseDiagnostics.current?.begin("coordinateResolution")
                let orientation = DeviceRotation.currentGestureInterfaceOrientation()
                var errorMessage: NSString?
                var symbolsUnavailable: ObjCBool = false
                GesturePhaseDiagnostics.current?.begin("synthesizedGesture")
                defer { GesturePhaseDiagnostics.current?.begin("postGesture") }
                let succeeded = ObjCExceptionCatcher_synthesizeMultiFingerSwipe(
                    CGFloat(startX), CGFloat(startY), CGFloat(endX), CGFloat(endY),
                    1, 0, duration, orientation.rawValue, &symbolsUnavailable, &errorMessage
                )
                guard !succeeded else { return true }
                guard symbolsUnavailable.boolValue else {
                    throw GestureError.gestureFailed(errorMessage as String? ?? "lock-screen swipe synthesis failed")
                }
                return false
            }
            if !synthesized {
                // Availability fallback retains the existing XCUITest behavior and phase name.
                try swipe(startX: startX, startY: startY, endX: endX, endY: endY, duration: duration)
            }
        }

        public func multiFingerSwipe(
            startX: Double,
            startY: Double,
            endX: Double,
            endY: Double,
            fingerCount: Int,
            fingerSpacing: Double,
            duration: TimeInterval
        )
            throws
        {
            guard application != nil else {
                throw GestureError.noApplication
            }

            try catchingObjCException {
                let orientation = DeviceRotation.currentGestureInterfaceOrientation()
                var errorMessage: NSString?
                var symbolsUnavailable: ObjCBool = false
                let succeeded = ObjCExceptionCatcher_synthesizeMultiFingerSwipe(
                    CGFloat(startX),
                    CGFloat(startY),
                    CGFloat(endX),
                    CGFloat(endY),
                    fingerCount,
                    CGFloat(fingerSpacing),
                    duration,
                    orientation.rawValue,
                    &symbolsUnavailable,
                    &errorMessage
                )

                if !succeeded {
                    // Unlike pinch (#2910) there is no public-API fallback to take
                    // here — for two or more fingers no XCUITest API delivers
                    // parallel simultaneous touch paths, and a single-finger
                    // substitute would be a different gesture. The availability
                    // signal therefore only distinguishes the failure message
                    // (#2952); see MultiFingerSwipeDiagnostics for the full
                    // rationale, including why the public `scroll(byDeltaX:deltaY:)`
                    // does not qualify despite being available on iOS.
                    throw GestureError.gestureFailed(
                        MultiFingerSwipeDiagnostics.failureMessage(
                            symbolsUnavailable: symbolsUnavailable.boolValue,
                            underlying: errorMessage as String? ?? "multi-finger swipe synthesis failed"
                        )
                    )
                }
            }
        }

        // MARK: - Drag Gestures

        public func drag(
            startX: Double, startY: Double,
            endX: Double, endY: Double,
            pressDuration: TimeInterval,
            dragDuration: TimeInterval,
            holdDuration: TimeInterval
        )
            throws
        {
            GesturePhaseDiagnostics.current?.begin("targetResolution")
            guard let app = gestureApplication() else {
                throw GestureError.noApplication
            }

            try catchingObjCException {
                GesturePhaseDiagnostics.current?.begin("coordinateResolution")
                // The display-targeted route reaches an unfolded iPhone Duo's inner panel, which
                // an XCUICoordinate drag synthesized against the main (cover) screen misses.
                let factory = try DisplayGestureFactory(
                    provider: XCUIGestureCoordinateProvider(app: app, locator: elementLocator)
                )

                // XCUICoordinate's drag API takes a velocity (points/second), not a duration,
                // so honor the caller's dragDuration by converting it into the velocity that
                // covers the source→target distance in that time. This gives iOS the same
                // drag-speed control Android has. Fall back to .default when the duration or
                // distance is non-positive (avoids divide-by-zero / infinite velocity).
                let distance = hypot(endX - startX, endY - startY)
                let velocity: Double? = (dragDuration > 0 && distance > 0) ? distance / dragDuration : nil

                // Press, drag, and hold
                defer { GesturePhaseDiagnostics.current?.begin("postGesture") }
                let delivery = try factory.deliver(
                    start: GesturePoint(x: startX, y: startY), end: GesturePoint(x: endX, y: endY),
                    press: pressDuration, move: dragDuration, hold: holdDuration, velocity: velocity
                ) { delivery in
                    logRelativeCoordinate(delivery.selection, gesture: "drag")
                    GesturePhaseDiagnostics.current?.begin("xcuitestGesture")
                }
                if factory.mismatch {
                    var sample = TapDiagnostics(requested: .init(
                        x: startX, y: startY, durationMs: Self.diagnosticDurationMs(dragDuration), mode: "drag"
                    ))
                    factory.annotate(&sample, delivery: delivery)
                    logger.warning("\(sample.logLine(gesture: "drag"), privacy: .public)")
                }
            }
        }

        // MARK: - Pinch Gestures

        @discardableResult
        public func pinch(
            centerX: Double,
            centerY: Double,
            distanceStart: Double,
            distanceEnd: Double,
            rotationDegrees: Double,
            duration: TimeInterval
        )
            throws -> PinchGesturePath
        {
            GesturePhaseDiagnostics.current?.begin("targetResolution")
            guard let app = gestureApplication() else {
                throw GestureError.noApplication
            }

            return try catchingObjCException {
                GesturePhaseDiagnostics.current?.begin("coordinateResolution")
                // An unfolded iPhone Duo shows the app on the inner panel, which a pinch synthesized
                // against the main (cover) screen misses; the display-targeted route reaches it.
                let factory = try DisplayGestureFactory(
                    provider: XCUIGestureCoordinateProvider(app: app, locator: elementLocator)
                )
                defer { GesturePhaseDiagnostics.current?.begin("postGesture") }
                let delivery = try factory.deliverPinch(
                    center: GesturePoint(x: centerX, y: centerY), distanceStart: distanceStart,
                    distanceEnd: distanceEnd, rotationDegrees: rotationDegrees, duration: duration
                ) { delivery in
                    logRelativeCoordinate(delivery.selection, gesture: "pinch")
                    GesturePhaseDiagnostics.current?.begin("xcuitestGesture")
                }
                if factory.mismatch {
                    var sample = TapDiagnostics(requested: .init(
                        x: centerX, y: centerY, durationMs: Self.diagnosticDurationMs(duration), mode: "pinch"
                    ))
                    factory.annotate(&sample, delivery: delivery)
                    logger.warning("\(sample.logLine(gesture: "pinch"), privacy: .public)")
                }
                if delivery.synthesizedPoint != nil { return .eventPath }

                let orientation = DeviceRotation.currentGestureInterfaceOrientation()
                var errorMessage: NSString?
                var symbolsUnavailable: ObjCBool = false
                GesturePhaseDiagnostics.current?.begin("xcuitestGesture")
                let succeeded = ObjCExceptionCatcher_synthesizePinch(
                    CGFloat(centerX),
                    CGFloat(centerY),
                    CGFloat(distanceStart),
                    CGFloat(distanceEnd),
                    CGFloat(rotationDegrees),
                    duration,
                    orientation.rawValue,
                    &symbolsUnavailable,
                    &errorMessage
                )

                if succeeded {
                    return .eventPath
                }

                // Only degrade to the public API when the private symbols are
                // genuinely absent. A real synthesis error still surfaces as a
                // structured failure (issue #2910).
                guard symbolsUnavailable.boolValue else {
                    throw GestureError.gestureFailed(errorMessage as String? ?? "pinch synthesis failed")
                }

                // Public element-anchored fallback: honors scale/velocity but
                // centers on the SpringBoard anchor, so it ignores centerX/centerY
                // and rotationDegrees (the public API has no center or rotation).
                //
                // This branch runs only on-device. Off-device coverage is split
                // across PinchFallbackTests (the scale/velocity math) and
                // ObjCExceptionBridgeTests (the symbolsUnavailable signal that
                // routes here); the live app.pinch call itself is device-only.
                let params = PinchFallback.parameters(
                    distanceStart: distanceStart,
                    distanceEnd: distanceEnd,
                    duration: duration
                )
                app.pinch(withScale: params.scale, velocity: params.velocity)
                return .elementAnchored
            }
        }

        // MARK: - Text Input

        private func fieldText(_ el: XCUIElement) -> String {
            do {
                let snapshot = try catchingObjCException { try el.snapshot() }
                return GesturePerformer.fieldText(
                    snapshotValue: snapshot.value as? String,
                    value: el.value as? String,
                    placeholderValue: snapshot.placeholderValue
                )
            } catch {
                // Text can still be read from the element when its snapshot is unavailable.
                logger.warning("Text field snapshot failed; reading element value: \(error)")
                let value = el.value as? String
                let placeholder = el.placeholderValue
                return value == placeholder ? "" : value ?? ""
            }
        }

        /// Resolve the XCUIApplication to use for text-input accessibility queries.
        ///
        /// Prefers the ElementLocator's tracked foreground bundle ID over the
        /// (possibly stale) self.application. See issue #1925: the MCP server
        /// launches apps via `simctl launch`, which updates ElementLocator's
        /// tracker (through the observe path) but does NOT reach CommandHandler's
        /// handleLaunchApp, so GesturePerformer.application stays pinned at
        /// whatever CtrlProxy.start() initialised it to (SpringBoard / the
        /// test host). That stale reference then returns zero textFields /
        /// zero keyboards, making every typeText fail with "No element has
        /// keyboard focus" — even when the app demonstrably has a focused
        /// text field and a visible keyboard.
        ///
        /// Coordinate-based gestures (tap/swipe/drag/pinch) deliberately use
        /// the SpringBoard anchor and do NOT go through this method.
        private func resolveTextInputApp() -> XCUIApplication? {
            if let bundleId = elementLocator.foregroundBundleId, !bundleId.isEmpty {
                return XCUIApplication(bundleIdentifier: bundleId)
            }
            return application
        }

        private func resolveNavigationApp() -> XCUIApplication? {
            if let bundleId = elementLocator.foregroundBundleId, !bundleId.isEmpty {
                return XCUIApplication(bundleIdentifier: bundleId)
            }
            return application
        }

        public func typeText(text: String) throws {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }

            try requireKeyboardFocus(app: app, context: "ensure a text field is focused before typing")

            try catchingObjCException {
                app.typeText(text)
            }
        }

        public func appendText(text: String) throws {
            try typeText(text: text)
        }

        public func setText(resourceId: String, text: String) async throws {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }
            guard let element = elementLocator.findElement(byResourceId: resourceId) as? XCUIElement else {
                throw GestureError.elementNotFound(resourceId)
            }

            try await tapAndAwaitKeyboardFocus(app: app, element: element, resourceId: resourceId)
            try catchingObjCException {
                GesturePerformer.clearFocusedText(app: app, element: element)
                app.typeText(text)
            }
        }

        public func clearText(resourceId: String? = nil) async throws {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }

            if let resourceId = resourceId {
                guard let element = elementLocator.findElement(byResourceId: resourceId) as? XCUIElement else {
                    throw GestureError.elementNotFound(resourceId)
                }
                try await tapAndAwaitKeyboardFocus(app: app, element: element, resourceId: resourceId)
                try catchingObjCException {
                    GesturePerformer.clearFocusedText(app: app, element: element)
                }
            } else {
                try requireKeyboardFocus(app: app, context: "ensure a text field is focused before clearing")
                let focused = resolveFocusedTextElement(app: app)
                try catchingObjCException {
                    if let focused = focused {
                        GesturePerformer.clearFocusedText(app: app, element: focused)
                    } else {
                        app.typeKey("a", modifierFlags: .command)
                        app.typeText(XCUIKeyboardKey.delete.rawValue)
                    }
                }
            }
        }

        /// Resolve the focused text-input element so we can check its type.
        /// Returns nil if no element can be identified (caller falls back to
        /// Cmd+A+Delete which works for native inputs).
        private func resolveFocusedTextElement(app: XCUIApplication) -> XCUIElement? {
            try? resolveFocusedTextElement(app: app, checkBudget: {})
        }

        private func resolveFocusedTextElement(
            app: XCUIApplication, checkBudget: () throws -> Void
        )
            throws -> XCUIElement?
        {
            try catchingObjCException {
                try checkBudget()
                let byPredicate = app.descendants(matching: .any)
                    .matching(NSPredicate(format: "hasKeyboardFocus == true"))
                    .firstMatch
                if byPredicate.exists {
                    return byPredicate
                }

                let queries: [XCUIElementQuery] = [
                    app.textFields,
                    app.secureTextFields,
                    app.textViews,
                    app.searchFields,
                ]
                for query in queries {
                    try checkBudget()
                    let candidates = query.allElementsBoundByIndex
                    if let focused = try Self.firstFocusedCandidate(
                        in: candidates, checkBudget: checkBudget,
                        hasFocus: { (try? $0.snapshot())?.hasFocus == true }
                    ) {
                        return focused
                    }
                }

                try checkBudget()
                let otherQuery = app.otherElements
                let otherCount = otherQuery.count
                return try Self.firstFocusedCandidate(
                    in: (0 ..< otherCount).lazy.map { otherQuery.element(boundBy: $0) },
                    checkBudget: checkBudget,
                    hasFocus: { candidate in
                        guard let snap = try? candidate.snapshot() else { return false }
                        return snap.hasFocus && GesturePerformer.snapshotLooksLikeTextInput(snap)
                    }
                )
            }
        }

        /// Clear text from a focused element, choosing the strategy based on
        /// element type. Native UIKit inputs use Cmd+A + Delete (O(1)). React
        /// Native wrappers (`.other`) use per-character deletes so RN's
        /// onChangeText JS bridge fires for each keystroke.
        private static func clearFocusedText(app: XCUIApplication, element: XCUIElement) {
            let type = element.elementType
            let isNativeTextInput = type == .textField
                || type == .textView
                || type == .secureTextField
                || type == .searchField

            if isNativeTextInput {
                app.typeKey("a", modifierFlags: .command)
                app.typeText(XCUIKeyboardKey.delete.rawValue)
            } else {
                clearViaDeletes(element: element)
            }
        }

        private static let clearViaDeletesBurstSize = 50
        private static let clearViaDeletesMaxIterations = 20

        /// Per-character delete loop for React Native TextInputs. RN's
        /// onChangeText bridge requires individual delete keystrokes —
        /// Cmd+A+Delete clears only the native buffer while JS state stays stale.
        /// No value-based progress check: RN wrappers can report a stable
        /// accessibility identifier as `value` regardless of actual content,
        /// so the loop runs the full count. Extra deletes on an empty field
        /// are harmless no-ops.
        private static func clearViaDeletes(element: XCUIElement) {
            for _ in 0 ..< clearViaDeletesMaxIterations {
                let current = (element.value as? String) ?? ""
                if current.isEmpty { break }
                element.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
                element.typeText(String(
                    repeating: XCUIKeyboardKey.delete.rawValue,
                    count: clearViaDeletesBurstSize
                ))
            }
        }

        public func selectAll() throws {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }

            try requireKeyboardFocus(app: app, context: "ensure a text field is focused before selecting")

            try catchingObjCException {
                app.typeKey("a", modifierFlags: .command)
            }
        }

        public func performImeAction(_ action: String) throws {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }

            try requireKeyboardFocus(
                app: app,
                context: "ensure a text field is focused before performing an IME action"
            )

            switch action.lowercased() {
            case "done", "go", "search", "send", "next":
                try catchingObjCException {
                    let keyboard = app.keyboards.firstMatch.exists
                        ? app.keyboards.firstMatch : self.springboard.keyboards.firstMatch
                    let keyboardVisible = keyboard.exists
                    let focusedField: ImeFocusedField
                    if let focused = resolveFocusedTextElement(app: app) {
                        focusedField = focused.elementType == .textView ? .multiline : .singleLine
                    } else {
                        focusedField = keyboardVisible ? .unresolved : .absent
                    }
                    let keys = keyboardVisible ? keyboard.buttons.matching(NSPredicate(
                        format: "identifier IN[c] %@ OR label IN[c] %@",
                        Self.submitButtonNames,
                        Self.submitButtonNames
                    )).allElementsBoundByIndex : []
                    let labels = keys.map { (label: $0.label, identifier: $0.identifier, isEnabled: $0.isEnabled) }
                    switch Self.imeActionDecision(
                        action: action,
                        focusedField: focusedField,
                        keyboardVisible: keyboardVisible,
                        keys: labels
                    ) {
                    case let .tapKey(index):
                        keys[index].tap()
                    case .typeReturn:
                        app.typeText("\n")
                    case let .notAvailable(reason):
                        throw GestureError.notSupported(reason)
                    }
                }
            case "previous":
                try catchingObjCException {
                    app.typeKey(.tab, modifierFlags: .shift)
                }
            default:
                throw GestureError.notSupported("IME action: \(action)")
            }
        }

        public func keyboard(action: String) async throws -> KeyboardActionResult {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }

            switch action.lowercased() {
            case "detect":
                return KeyboardActionResult(open: isKeyboardVisible(app: app))
            case "open":
                if isKeyboardVisible(app: app) {
                    return KeyboardActionResult(open: true)
                }
                guard let focused = resolveFocusedTextElement(app: app) else {
                    throw GestureError.notSupported("No focused text input to open keyboard")
                }
                try catchingObjCException {
                    focused.tap()
                }
                return try KeyboardActionResult(open: await waitForKeyboardVisibility(app: app, expected: true))
            case "close":
                return try await closeKeyboard(app: app, clock: keyboardClock)
            default:
                throw GestureError.notSupported("Keyboard action: \(action)")
            }
        }

        private func closeKeyboard<C: Clock>(app: XCUIApplication, clock: C)
            async throws -> KeyboardActionResult where C.Duration == Duration
        {
            let closeDeadline = clock.now.advanced(by: .milliseconds(3500))
            if !isKeyboardVisible(app: app) {
                return KeyboardActionResult(open: false)
            }

            // A focused text view treats Return as content, so only a hide key
            // or Escape may dismiss its keyboard without changing the field.
            let isMultiline: Bool
            do {
                isMultiline = try catchingObjCException {
                    let focused = app.descendants(matching: .any)
                        .matching(NSPredicate(format: "hasKeyboardFocus == true"))
                        .firstMatch
                    return focused.exists && focused.elementType == .textView
                }
            } catch {
                print("[GesturePerformer] keyboard close focus lookup failed: \(error)")
                isMultiline = true
            }

            var enabledKey: (element: XCUIElement, method: String)?
            var hasSubmitKey = false
            if !isMultiline {
                do {
                    hasSubmitKey = try catchingObjCException {
                        app.keyboards.buttons.matching(NSPredicate(
                            format: "identifier IN[c] %@ OR label IN[c] %@",
                            Self.submitButtonNames,
                            Self.submitButtonNames
                        )).firstMatch.exists
                    }
                } catch {
                    print("[GesturePerformer] keyboard close submit key lookup failed: \(error)")
                }
            }
            do {
                let keys = try catchingObjCException {
                    app.keyboards.buttons.matching(NSPredicate(
                        format: "identifier IN[c] %@ OR label IN[c] %@",
                        Self.closeButtonNames,
                        Self.closeButtonNames
                    )).allElementsBoundByIndex
                }
                var labels: [(label: String, identifier: String)] = []
                for key in keys {
                    guard clock.now < closeDeadline else { break }
                    try labels.append(catchingObjCException { (label: key.label, identifier: key.identifier) })
                }
                for candidate in Self.closeKeyCandidates(labels, isMultiline: isMultiline) {
                    guard clock.now < closeDeadline else { break }
                    let key = keys[candidate.index]
                    if try catchingObjCException({ key.isEnabled }) {
                        enabledKey = (element: key, method: candidate.method)
                        break
                    }
                }
            } catch {
                print("[GesturePerformer] keyboard close key lookup failed: \(error)")
            }

            for attempt in Self.closeAttemptOrder(
                hasEnabledMatch: enabledKey != nil,
                hasSubmitKey: hasSubmitKey,
                isMultiline: isMultiline
            ) {
                if !isKeyboardVisible(app: app) {
                    return KeyboardActionResult(open: false)
                }
                guard clock.now < closeDeadline else {
                    break
                }
                let method: String
                do {
                    switch attempt {
                    case .matchedButton:
                        guard let enabledKey else { continue }
                        method = enabledKey.method
                        try catchingObjCException { enabledKey.element.tap() }
                    case .newline:
                        method = "returnKey"
                        try catchingObjCException { app.typeText("\n") }
                    case .escape:
                        method = "escape"
                        try typeKeyboardKey(.escape, app: app)
                    }
                } catch {
                    print("[GesturePerformer] keyboard close \(attempt) failed: \(error)")
                }
                if try await waitForKeyboardClose(app: app, closeDeadline: closeDeadline, clock: clock) {
                    return KeyboardActionResult(open: false, method: method)
                }
            }
            let open = isKeyboardVisible(app: app)
            return KeyboardActionResult(
                open: open,
                error: open && isMultiline ? Self.multilineCloseError : nil
            )
        }

        @discardableResult
        public func pressKey(key: String, modifiers: [String]) async throws -> Bool? {
            try await pressKeyOutcome(key: key, modifiers: modifiers).verified
        }

        public func pressKeyOutcome(key: String, modifiers: [String]) async throws -> PressKeyOutcome {
            var warning: String?
            let verified = try await performPressKey(key: key, modifiers: modifiers, warning: &warning)
            return PressKeyOutcome(verified: verified, warning: warning)
        }

        private func performPressKey(key: String, modifiers: [String], warning: inout String?) async throws -> Bool? {
            let memo = consumeCaretMemo(key: key, modifiers: modifiers)
            let normalizedKey = key.lowercased()
            try GesturePerformer.validateDestructiveKeyModifiers(normalizedKey: normalizedKey, modifiers: modifiers)

            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }
            let bundleId = elementLocator.foregroundBundleId

            let keyboardKey: XCUIKeyboardKey
            switch normalizedKey {
            case "enter":
                keyboardKey = .return
            case "tab":
                keyboardKey = .tab
            case "escape":
                keyboardKey = .escape
            case "backspace":
                keyboardKey = .delete
            case "delete":
                keyboardKey = .forwardDelete
            case "arrow_up":
                keyboardKey = .upArrow
            case "arrow_down":
                keyboardKey = .downArrow
            case "arrow_left":
                keyboardKey = .leftArrow
            case "arrow_right":
                keyboardKey = .rightArrow
            default:
                throw GestureError.notSupported("Keyboard key: \(key)")
            }

            var modifierFlags: XCUIElement.KeyModifierFlags = []
            for modifier in Set(modifiers.map { $0.lowercased() }) {
                switch modifier {
                case "shift":
                    modifierFlags.formUnion(.shift)
                case "ctrl":
                    modifierFlags.formUnion(.control)
                case "alt":
                    modifierFlags.formUnion(.option)
                case "meta":
                    modifierFlags.formUnion(.command)
                default:
                    throw GestureError.notSupported("Keyboard modifier: \(modifier)")
                }
            }

            let isDestructiveKey = normalizedKey == "backspace" || normalizedKey == "delete"
            let isHorizontalArrow = normalizedKey == "arrow_left" || normalizedKey == "arrow_right"
            let isPlainHorizontalArrow = isHorizontalArrow && modifierFlags.isEmpty
            if isPlainHorizontalArrow {
                return try GesturePerformer.performHorizontalArrow(
                    clock: keyboardClock, key: normalizedKey,
                    requireFocus: {
                        GesturePhaseDiagnostics.current?.begin("focusCheck")
                        try self.requireKeyboardFocus(
                            app: app, context: "ensure a text field is focused before pressing a key", forKeyPress: true
                        )
                    },
                    resolveInput: { checkBudget in
                        GesturePhaseDiagnostics.current?.begin("elementResolution")
                        let element = try self.resolveFocusedTextElement(app: app, checkBudget: checkBudget)
                        try checkBudget()
                        GesturePhaseDiagnostics.current?.begin("valueRead")
                        let original = try element.map { element in
                            try catchingObjCException { self.fieldText(element) }
                        }
                        return (element, original)
                    },
                    probeCaret: { element, original in
                        GesturePhaseDiagnostics.current?.begin("caretProbe")
                        return try self.probeCaretIndex(app: app, focusedElement: element, original: original)
                    },
                    sendKey: {
                        GesturePhaseDiagnostics.current?.begin("keyDelivery")
                        try catchingObjCException { app.typeKey(keyboardKey, modifierFlags: []) }
                    },
                    retryKey: { element in
                        GesturePhaseDiagnostics.current?.begin("keyDelivery")
                        try catchingObjCException { element.typeKey(keyboardKey, modifierFlags: []) }
                    },
                    readValue: { element in
                        GesturePhaseDiagnostics.current?.begin("outcomeConfirmation")
                        return try catchingObjCException { self.fieldText(element) }
                    },
                    restoreValue: { element, original in
                        try self.restoreForwardDeleteProbe(
                            app: app, focusedElement: element, original: original, marker: ""
                        )
                    },
                    knownCaret: { memo?.caret(bundleId: bundleId, value: $0) },
                    verifiedCaret: { self.rememberCaret(bundleId: bundleId, value: $0, index: $1) }
                )
            }

            GesturePhaseDiagnostics.current?.begin("focusCheck")
            try requireKeyboardFocus(
                app: app, context: "ensure a text field is focused before pressing a key", forKeyPress: true
            )

            GesturePhaseDiagnostics.current?.begin("elementResolution")
            let focusedElement = isDestructiveKey ? resolveFocusedTextElement(app: app) : nil
            let focusedKind = try focusedElement.map { element in
                try catchingObjCException { GesturePerformer.focusedElementKind(element.elementType) }
            }
            GesturePhaseDiagnostics.current?.begin("valueRead")
            let valueBeforeKeyPress = try focusedElement.map { element in
                try catchingObjCException { fieldText(element) }
            }
            let caretBefore: Int?
            if normalizedKey == "delete", let focusedElement {
                GesturePhaseDiagnostics.current?.begin("caretProbe")
                caretBefore = try probeCaretIndex(
                    app: app, focusedElement: focusedElement, original: valueBeforeKeyPress
                )
            } else {
                caretBefore = nil
            }

            if isDestructiveKey, !GesturePerformer.canVerifyDestructiveKey(focusedValue: valueBeforeKeyPress) {
                throw GestureError.gestureFailed(
                    "Key '\(key)' was not delivered: focused field could not be observed"
                )
            }

            let expectedForwardDelete: String?
            if normalizedKey == "delete", let original = valueBeforeKeyPress, !original.isEmpty {
                guard let caretBefore else {
                    throw GestureError.gestureFailed(
                        "Forward delete unavailable: could not verify the caret position; use text replacement instead"
                    )
                }
                guard let expected = GesturePerformer.forwardDeleteResult(original: original, caretIndex: caretBefore)
                else {
                    throw GestureError.gestureFailed(
                        "Forward delete has no following character at the caret; move the caret left first"
                    )
                }
                expectedForwardDelete = expected
            } else {
                expectedForwardDelete = nil
            }

            GesturePhaseDiagnostics.current?.begin("keyDelivery")
            try catchingObjCException {
                if normalizedKey == "backspace" {
                    // Backspace uses text insertion on the focused field because app-level
                    // key delivery has not reliably reached it.
                    guard let focusedElement else {
                        throw GestureError.gestureFailed(
                            "Key '\(key)' was not delivered: focused field could not be observed"
                        )
                    }
                    focusedElement.typeText(keyboardKey.rawValue)
                } else if normalizedKey == "delete" {
                    // XCUI forward delete is a no-op on the simulator; use the
                    // verified Right Arrow + Backspace path below there.
                    #if !targetEnvironment(simulator)
                        app.typeKey(keyboardKey, modifierFlags: [])
                    #endif
                } else {
                    app.typeKey(keyboardKey, modifierFlags: modifierFlags)
                }
            }

            if isHorizontalArrow { return false }

            guard isDestructiveKey else {
                return nil
            }
            guard let focusedElement, let valueBeforeKeyPress else {
                throw GestureError.gestureFailed(
                    "Key '\(key)' was not delivered: focused field could not be observed"
                )
            }
            if GesturePerformer.destructiveKeyOutcome(before: valueBeforeKeyPress, after: valueBeforeKeyPress)
                == .boundaryNoOp
            {
                return nil
            }

            if normalizedKey == "delete" {
                GesturePhaseDiagnostics.current?.begin("outcomeConfirmation")
                let valueBeforeFallback = try catchingObjCException { fieldText(focusedElement) }
                if valueBeforeFallback == expectedForwardDelete { return nil }
                if valueBeforeFallback == valueBeforeKeyPress, let caretBefore {
                    try emulateForwardDelete(
                        app: app, focusedElement: focusedElement, original: valueBeforeKeyPress,
                        caretBefore: caretBefore
                    )
                } else {
                    throw GestureError.gestureFailed(
                        "Forward delete changed a different character; use text replacement instead"
                    )
                }
            }

            var valueAfterKeyPress = valueBeforeKeyPress
            GesturePhaseDiagnostics.current?.begin("postCondition")
            let satisfied = try await KeyboardWait.destructivePostCondition(clock: keyboardClock) {
                guard try catchingObjCException({ focusedElement.exists }) else {
                    if normalizedKey == "delete" {
                        throw GestureError.gestureFailed(
                            "Forward delete unavailable: focused field disappeared; use text replacement instead"
                        )
                    }
                    return true
                }
                valueAfterKeyPress = try catchingObjCException { self.fieldText(focusedElement) }
                if normalizedKey == "delete", valueAfterKeyPress == expectedForwardDelete {
                    return true
                }
                return normalizedKey == "backspace"
                    && GesturePerformer.destructiveKeyOutcome(
                        before: valueBeforeKeyPress, after: valueAfterKeyPress
                    ) == .deleted
            }
            if satisfied { return nil }

            if normalizedKey == "delete" {
                throw GestureError.gestureFailed(
                    "Forward delete did not remove the character after the caret: expected length \(expectedForwardDelete?.count ?? 0), observed \(valueAfterKeyPress.count); use text replacement instead"
                )
            }
            switch GesturePerformer.destructiveKeyPostCondition(
                kind: focusedKind ?? .unsupported, before: valueBeforeKeyPress, after: valueAfterKeyPress
            ) {
            case .failed:
                throw GestureError.gestureFailed(
                    "Key '\(key)' did not decrease text length: before \(valueBeforeKeyPress.count), observed \(valueAfterKeyPress.count)"
                )
            case .deliveredWithWarning:
                warning = GesturePerformer.destructiveKeyWarning(key: key)
                return nil
            case .delivered, .boundaryNoOp:
                return nil
            }
        }

        private func probeCaretIndex(
            app: XCUIApplication, focusedElement: XCUIElement, original: String?
        )
            throws -> Int?
        {
            guard let original, let marker = GesturePerformer.forwardDeleteMarker(for: original) else { return nil }
            do {
                let index = try catchingObjCException { () -> Int? in
                    focusedElement.typeText(marker)
                    let probed = fieldText(focusedElement)
                    guard let index = GesturePerformer.forwardDeleteMarkerIndex(
                        original: original, probed: probed, marker: marker
                    )
                    else { return nil }
                    focusedElement.typeText(XCUIKeyboardKey.delete.rawValue)
                    guard fieldText(focusedElement) == original else { return nil }
                    return index
                }
                if index != nil { return index }
            } catch {
                try restoreForwardDeleteProbe(
                    app: app, focusedElement: focusedElement, original: original, marker: marker
                )
                return nil
            }
            try restoreForwardDeleteProbe(
                app: app, focusedElement: focusedElement, original: original, marker: marker
            )
            return nil
        }

        private func emulateForwardDelete(
            app: XCUIApplication, focusedElement: XCUIElement, original: String, caretBefore: Int
        )
            throws
        {
            // The native forward-delete key is a no-op on some simulator runtimes. Move
            // one character right and backspace only after observing that movement.
            GesturePhaseDiagnostics.current?.begin("keyDelivery")
            try catchingObjCException { app.typeKey(.rightArrow, modifierFlags: []) }
            GesturePhaseDiagnostics.current?.begin("caretProbe")
            var caretAfter = try probeCaretIndex(app: app, focusedElement: focusedElement, original: original)
            if caretAfter == caretBefore {
                GesturePhaseDiagnostics.current?.begin("keyDelivery")
                try catchingObjCException { focusedElement.typeKey(.rightArrow, modifierFlags: []) }
                GesturePhaseDiagnostics.current?.begin("caretProbe")
                caretAfter = try probeCaretIndex(app: app, focusedElement: focusedElement, original: original)
            }
            guard caretAfter == caretBefore + 1 else {
                throw GestureError.gestureFailed(
                    "Forward delete unavailable: Right Arrow did not move the caret one character; use text replacement instead"
                )
            }
            GesturePhaseDiagnostics.current?.begin("keyDelivery")
            try catchingObjCException { focusedElement.typeText(XCUIKeyboardKey.delete.rawValue) }
        }

        private func restoreForwardDeleteProbe(
            app: XCUIApplication, focusedElement: XCUIElement, original: String, marker: String
        )
            throws
        {
            if (try? catchingObjCException({ fieldText(focusedElement) })) == original { return }

            if !marker.isEmpty,
               (try? catchingObjCException({ fieldText(focusedElement) }))?.contains(marker) == true
            {
                try? catchingObjCException {
                    focusedElement.typeText(XCUIKeyboardKey.delete.rawValue)
                }
                if (try? catchingObjCException({ fieldText(focusedElement) })) == original { return }
            }

            do {
                try catchingObjCException {
                    app.typeKey("a", modifierFlags: .command)
                    if original.isEmpty {
                        focusedElement.typeText(XCUIKeyboardKey.delete.rawValue)
                    } else {
                        focusedElement.typeText(original)
                    }
                }
            } catch {
                throw GestureError.gestureFailed("Forward-delete probe recovery failed: \(error)")
            }
            guard (try? catchingObjCException({ fieldText(focusedElement) })) == original else {
                throw GestureError.gestureFailed("Forward-delete probe recovery could not confirm the original text")
            }
        }

        private func waitForKeyboardVisibility(
            app: XCUIApplication,
            expected: Bool,
            timeout: TimeInterval = 1.0,
            interval: TimeInterval = 0.05
        )
            async throws -> Bool
        {
            try await KeyboardWait.visibility(
                clock: keyboardClock,
                expected: expected,
                timeout: .seconds(timeout),
                interval: .seconds(interval),
                probe: { self.isKeyboardVisible(app: app) }
            )
        }

        private func waitForKeyboardClose<C: Clock>(
            app: XCUIApplication, closeDeadline: C.Instant, clock: C
        )
            async throws -> Bool where C.Duration == Duration
        {
            try await KeyboardWait.close(clock: clock, closeDeadline: closeDeadline) {
                self.isKeyboardVisible(app: app)
            }
        }

        private func isKeyboardVisible(app: XCUIApplication) -> Bool {
            catchingObjCExceptionNonThrowing({
                app.keyboards.firstMatch.exists || self.springboard.keyboards.firstMatch.exists
            }, fallback: false)
        }

        private func typeKeyboardKey(_ key: XCUIKeyboardKey, app: XCUIApplication) throws {
            try catchingObjCException {
                app.typeKey(key, modifierFlags: [])
            }
        }

        // MARK: - Actions

        public func performAction(
            _ action: String, resourceId: String? = nil, label: String? = nil,
            bounds: ElementBounds? = nil, duration: Int? = nil
        )
            throws
        {
            if action.caseInsensitiveCompare("system_alert_accept") == .orderedSame {
                try catchingObjCException {
                    // iOS 26.5 can render a SpringBoard confirmation that is
                    // absent even from a fresh SpringBoard snapshot. Query the
                    // live alert/sheet only for this explicit system action.
                    // Select its final button by accessibility order so
                    // localized Open labels do not affect acceptance.
                    guard let button = self.systemAlertAcceptanceButton() else {
                        throw GestureError.elementNotFound("system alert acceptance button")
                    }
                    button.tap()
                }
                return
            }

            var element: XCUIElement?
            if let resourceId = resourceId {
                element = elementLocator.findElement(byResourceId: resourceId) as? XCUIElement
            }
            if element == nil, let label = label {
                if let bounds {
                    element = elementLocator.findElement(byText: label, bounds: bounds) as? XCUIElement
                    if element == nil {
                        element = elementLocator.findElement(byText: label) as? XCUIElement
                    }
                } else {
                    element = elementLocator.findElement(byText: label) as? XCUIElement
                }
            }
            guard let found = element else {
                throw GestureError.elementNotFound(resourceId ?? label ?? "unknown")
            }

            try catchingObjCException {
                switch action.lowercased() {
                case "click", "tap", "activate":
                    // "activate" is the VoiceOver activation gesture (issue #2857); for an
                    // element located by label it resolves to a tap, matching "click"/"tap".
                    found.tap()
                case "long_click", "long_press":
                    found.press(forDuration: Self.longPressDuration(duration))
                case "double_tap", "double_click":
                    found.doubleTap()
                case "scroll_forward":
                    found.swipeUp()
                case "scroll_backward":
                    found.swipeDown()
                case "focus":
                    found.tap()
                default:
                    throw GestureError.notSupported("Action: \(action)")
                }
            }
        }

        private func systemAlertAcceptanceButton() -> XCUIElement? {
            let systemDialogs = [
                springboard.alerts.firstMatch,
                springboard.sheets.firstMatch,
            ]
            for dialog in systemDialogs {
                guard dialog.exists || dialog.waitForExistence(timeout: 0.5) else {
                    continue
                }
                let buttons = dialog.buttons.allElementsBoundByIndex.filter {
                    $0.exists && $0.isHittable && !$0.frame.isEmpty
                }
                // The custom-URL confirmation has Cancel then the affirmative
                // action. Refuse another system dialog shape rather than
                // guessing which control is safe to activate.
                guard buttons.count == 2 else {
                    continue
                }
                return buttons.last
            }
            return nil
        }

        /// Activates the zero-based case-insensitive matching link within its owner.
        /// Scoped candidates include the owner's link descendants and the owner itself
        /// when it is a link. Without an owner, only occurrence 0 is supported: tap the
        /// first matching hittable app link, since XCUITest exposes no owner grouping.
        public func activateAccessibilityLink(
            text: String,
            occurrence: Int,
            ownerResourceId: String?
        )
            throws
        {
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, occurrence >= 0 else {
                throw GestureError.gestureFailed("Semantic link text must be non-blank and occurrence non-negative")
            }
            try Self.validateSemanticLinkFallback(occurrence: occurrence, ownerResourceId: ownerResourceId)
            guard let app = resolveNavigationApp() else {
                throw GestureError.noApplication
            }
            try catchingObjCException {
                let links: [XCUIElement]
                if let ownerResourceId {
                    let owners = app.descendants(matching: .any).allElementsBoundByIndex.filter {
                        $0.identifier == ownerResourceId &&
                            $0.exists &&
                            $0.isHittable &&
                            !$0.frame.isEmpty
                    }
                    guard owners.count == 1 else {
                        throw GestureError.gestureFailed(
                            "Semantic link owner '\(ownerResourceId)' is missing, not actionable, or ambiguous"
                        )
                    }
                    let owner = owners[0]
                    links = Self.scopedLinkCandidates(
                        owner: owner,
                        ownerIsLink: owner.elementType == .link,
                        descendants: owner.descendants(matching: .link).allElementsBoundByIndex
                    )
                } else {
                    links = app.links.allElementsBoundByIndex
                }
                let matches = links.filter {
                    $0.label.caseInsensitiveCompare(text) == .orderedSame &&
                        $0.exists &&
                        $0.isHittable &&
                        !$0.frame.isEmpty
                }
                guard matches.indices.contains(occurrence) else {
                    throw GestureError.elementNotFound("semantic link '\(text)' occurrence \(occurrence)")
                }
                let link = matches[occurrence]
                guard link.exists, link.isHittable, !link.frame.isEmpty else {
                    throw GestureError.gestureFailed(
                        "Semantic link '\(text)' occurrence \(occurrence) is no longer hittable"
                    )
                }
                link.tap()
            }
        }

        // MARK: - Screenshots

        public func getScreenshot() throws -> Data {
            return try catchingObjCException {
                let screenshot = XCUIScreen.main.screenshot()
                return try self.nativeSizedPNGRepresentation(screenshot)
            }
        }

        public func getScreenshotCapture() throws -> ScreenshotCapture {
            return try catchingObjCException {
                let capture = DeviceRotation.capture { XCUIScreen.main.screenshot() }
                return try ScreenshotCapture(
                    data: self.nativeSizedPNGRepresentation(capture.value),
                    rotation: capture.rotation
                )
            }
        }

        private func nativeSizedPNGRepresentation(_ screenshot: XCUIScreenshot) throws -> Data {
            let original = screenshot.pngRepresentation
            guard let source = Self.pngDimensions(original) else {
                throw GestureError.gestureFailed("XCUITest returned an invalid PNG screenshot")
            }

            // XCUITest rounds odd native widths down by one pixel (#7384), and
            // UIScreen.nativeBounds carries the same truncated width. Derive the
            // framebuffer dimensions from SpringBoard's point-space frame and
            // nativeScale, then re-encode only when that exposes the mismatch.
            let frame = springboard.frame
            let nativeScale = UIScreen.main.nativeScale
            var target = (
                width: ElementBounds.clampedInt((frame.width * nativeScale).rounded()),
                height: ElementBounds.clampedInt((frame.height * nativeScale).rounded())
            )
            guard target.width > 0, target.height > 0 else {
                return original
            }
            if (source.width > source.height) != (target.width > target.height) {
                target = (width: target.height, height: target.width)
            }
            guard source != target else {
                return original
            }
            let widthDelta = target.width - source.width
            let heightDelta = target.height - source.height
            guard (widthDelta == 1 && heightDelta == 0) || (widthDelta == 0 && heightDelta == 1) else {
                throw GestureError.gestureFailed(
                    "XCUITest screenshot dimensions \(source.width)x\(source.height) do not match " +
                        "the native framebuffer \(target.width)x\(target.height); refusing to rescale an unexpected mismatch"
                )
            }

            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            let targetSize = CGSize(width: target.width, height: target.height)
            let correctedImage = UIGraphicsImageRenderer(size: targetSize, format: format).image { _ in
                screenshot.image.draw(in: CGRect(origin: .zero, size: targetSize))
            }
            guard let corrected = correctedImage.pngData(),
                  let correctedDimensions = Self.pngDimensions(corrected),
                  correctedDimensions == target
            else {
                throw GestureError.gestureFailed(
                    "Failed to encode screenshot at native dimensions \(target.width)x\(target.height)"
                )
            }
            return corrected
        }

        private static func pngDimensions(_ data: Data) -> (width: Int, height: Int)? {
            let signature = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
            guard data.count >= 24, data.prefix(signature.count) == signature else {
                return nil
            }
            func uint32(at offset: Int) -> Int {
                data[offset ..< offset + 4].reduce(0) { ($0 << 8) | Int($1) }
            }
            return (width: uint32(at: 16), height: uint32(at: 20))
        }

        // MARK: - Device Control

        public func setOrientation(_ orientation: String) throws {
            try catchingObjCException {
                let device = XCUIDevice.shared

                switch orientation.lowercased() {
                case "portrait":
                    device.orientation = .portrait
                case "portrait_upside_down", "portraitupsidedown":
                    device.orientation = .portraitUpsideDown
                case "landscape_left", "landscapeleft":
                    device.orientation = .landscapeLeft
                case "landscape_right", "landscaperight":
                    device.orientation = .landscapeRight
                default:
                    throw GestureError.gestureFailed("Unknown orientation: \(orientation)")
                }
            }
        }

        public func getOrientation() -> String {
            catchingObjCExceptionNonThrowing({
                let device = XCUIDevice.shared

                switch device.orientation {
                case .portrait: return "portrait"
                case .portraitUpsideDown: return "portrait_upside_down"
                case .landscapeLeft: return "landscape_left"
                case .landscapeRight: return "landscape_right"
                default: return "unknown"
                }
            }, fallback: "unknown")
        }

        public func getDisplayRotation() -> Int? {
            catchingObjCExceptionNonThrowing({ DeviceRotation.current() }, fallback: nil)
        }

        // MARK: - Clipboard

        /// Shadow of the most recent value this runner wrote via `copy` (or
        /// cleared via `clear`). No longer read: `get` reports an unreadable
        /// pasteboard as unavailable and `paste` sends Cmd+V without the text
        /// (#10083), since iOS's privacy-gated read on a UI-test runner can
        /// hang on a `Paste from <app>` system alert nobody can dismiss.
        ///
        /// The reference guarded this with a dedicated `clipboardShadowQueue`
        /// because `copy` (writer) and `get`/`paste` (readers) could run on
        /// different threads. Under `@MainActor` every `clipboard(action:)`
        /// path runs on the main actor, so the queue is gone and the shadow is
        /// plain main-actor state.
        private static var clipboardShadow: String?

        private static func writeShadow(_ value: String?) {
            clipboardShadow = value
        }

        /// Read `UIPasteboard.general.string` with a bounded timeout. The
        /// pasteboard read can deadlock the runner on iOS 16+ when a
        /// privacy alert is presented but no user is available to dismiss
        /// it. Returns `.unavailable` on timeout instead of blocking forever.
        private static func readPasteboardWithTimeout(_ timeout: DispatchTimeInterval) -> ClipboardReadResult {
            // Skip the read entirely if there are no strings — `hasStrings`
            // is a non-prompting synchronous check.
            guard UIPasteboard.general.hasStrings else { return .empty }
            let semaphore = DispatchSemaphore(value: 0)
            let box = ClipboardReadBox()
            DispatchQueue.global(qos: .userInitiated).async {
                box.text = UIPasteboard.general.string
                semaphore.signal()
            }
            if semaphore.wait(timeout: .now() + timeout) == .timedOut {
                return .unavailable
            }
            guard let text = box.text else { return .unavailable }
            return .value(text)
        }

        /// `@unchecked Sendable`: the `semaphore.signal()`/`wait()` pair in
        /// `readPasteboardWithTimeout` establishes a happens-before edge between the
        /// write on the global queue and the read on the caller, so the single mutable
        /// `text` needs no lock. Required because `DispatchQueue.async`'s closure is
        /// `@Sendable` and captures the box.
        private final class ClipboardReadBox: @unchecked Sendable {
            var text: String?
        }

        public func clipboard(action: String, text: String?) throws -> String? {
            switch action {
            case "get":
                let readResult = GesturePerformer.readPasteboardWithTimeout(.milliseconds(500))
                return try GesturePerformer.resolveClipboardGet(readResult: readResult)

            case "copy":
                guard let text = text else {
                    throw GestureError.missingParameter("text required for copy")
                }
                try catchingObjCException {
                    UIPasteboard.general.string = text
                }
                GesturePerformer.writeShadow(text)
                return nil

            case "clear":
                try catchingObjCException {
                    UIPasteboard.general.items = []
                }
                GesturePerformer.writeShadow(nil)
                return nil

            case "paste":
                // Use foreground-app resolution (#1925) — the clipboard paste
                // path also needs to query the correct app for hasKeyboardFocus.
                guard let app = resolveTextInputApp() else {
                    throw GestureError.noApplication
                }
                // Bounded read; an unreadable pasteboard still pastes and the host verifies the field.
                try GesturePerformer.resolveClipboardPaste(
                    readResult: GesturePerformer.readPasteboardWithTimeout(.milliseconds(500))
                )

                try requireKeyboardFocus(app: app, context: "ensure a text field is focused before pasting")

                // Use Cmd+V for real paste — handles emoji, Unicode, and is a single operation
                try catchingObjCException {
                    app.typeKey("v", modifierFlags: .command)
                }

                // iOS 16+ may show a paste-permission system alert; match known
                // UIKitCore allow labels across locales without selecting deny actions.
                try handlePasteAlert()
                return nil

            default:
                throw GestureError.unsupportedAction(action)
            }
        }

        /// Handle iOS 16+ "Allow Paste" system alert that appears when pasting
        /// content set by another process. Checks SpringBoard for the alert button
        /// and taps it if present. No-op on iOS 15 or if already permitted.
        private func handlePasteAlert() throws {
            try catchingObjCException {
                let allowButton = self.springboard.buttons["Allow Paste"]
                // Quick existence check avoids full 0.5s wait when no alert is present
                if allowButton.exists || allowButton.waitForExistence(timeout: 0.3) {
                    allowButton.tap()
                    return
                }
                // Immediate fallback: no additional wait when the English check misses.
                if let localizedAllowButton = self.springboard.buttons.allElementsBoundByIndex.first(where: {
                    PasteAlertLabelMatcher.isAllowPasteLabel($0.label)
                }) {
                    localizedAllowButton.tap()
                }
            }
        }

        public func pressHome() throws {
            try catchingObjCException {
                XCUIDevice.shared.press(.home)
            }
        }

        public func shake() throws {
            try catchingObjCException {
                let notificationName = CFNotificationName("com.apple.UIKit.SimulatorShake" as CFString)
                CFNotificationCenterPostNotification(
                    CFNotificationCenterGetDarwinNotifyCenter(),
                    notificationName,
                    nil,
                    nil,
                    true
                )
            }
        }

        public func pressBack() throws {
            guard let app = resolveNavigationApp() else {
                throw GestureError.noApplication
            }

            try catchingObjCException {
                if self.tapExplicitNavigationBarBackButton(in: app) {
                    return
                }
                try self.swipeFromLeftEdge(in: app)
            }
        }

        private func tapExplicitNavigationBarBackButton(in app: XCUIApplication) -> Bool {
            for navigationBar in app.navigationBars.allElementsBoundByIndex where navigationBar.exists {
                let midpoint = navigationBar.frame.midX
                for button in navigationBar.buttons.allElementsBoundByIndex where button.exists && button.isHittable {
                    if button.frame.midX <= midpoint && self.isExplicitBackButton(button) {
                        button.tap()
                        return true
                    }
                }
            }
            return false
        }

        private func isExplicitBackButton(_ button: XCUIElement) -> Bool {
            let candidates = [button.label, button.identifier]
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
                .filter { !$0.isEmpty }
            return candidates.contains { value in
                value == "back" || value.contains("back button") || value.contains("go back")
            }
        }

        private func swipeFromLeftEdge(in app: XCUIApplication) throws {
            let frame = app.frame
            guard frame.width > 0, frame.height > 0 else {
                throw GestureError.gestureFailed("Cannot determine application frame for back gesture")
            }

            let start = app.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: 2, dy: frame.height / 2))
            let end = app.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: min(frame.width * 0.75, frame.width - 2), dy: frame.height / 2))
            start.press(
                forDuration: 0.05,
                thenDragTo: end,
                withVelocity: .default,
                thenHoldForDuration: 0
            )
        }

        public func pressButton(_ button: String) throws {
            switch button.lowercased() {
            case "home":
                try pressHome()
            case "recent":
                guard try openRecentApps() else {
                    throw GestureError.gestureFailed("iOS App Switcher did not appear after recent apps invocation")
                }
            case "back":
                try pressBack()
            case "volume_up", "volume_down":
                #if targetEnvironment(simulator)
                    try pressConsumerKeyViaHID(
                        usage: Self.consumerUsage(for: button.lowercased()),
                        button: button
                    )
                #else
                    try catchingObjCException {
                        let deviceButton: XCUIDevice.Button
                        if button.lowercased() == "volume_up" {
                            deviceButton = .volumeUp
                        } else {
                            deviceButton = .volumeDown
                        }
                        XCUIDevice.shared.press(deviceButton)
                    }
                #endif
            case "power":
                try pressConsumerKeyViaHID(usage: Self.consumerUsage(for: "power"), button: button)
            case "menu":
                throw GestureError.notSupported("iOS has no menu hardware button")
            default:
                throw GestureError.notSupported("Button: \(button)")
            }
        }

        private typealias IOHIDEventRef = CFTypeRef
        private typealias IOHIDEventSystemClientRef = CFTypeRef
        private typealias IOHIDEventCreateKeyboardEventFn = @convention(c) (
            CFAllocator?,
            UInt64,
            UInt32,
            UInt32,
            Bool,
            UInt32
        )
            -> Unmanaged<IOHIDEventRef>?
        private typealias IOHIDEventSystemClientCreateFn = @convention(c) (
            CFAllocator?
        )
            -> Unmanaged<IOHIDEventSystemClientRef>?
        private typealias IOHIDEventSystemClientDispatchEventFn = @convention(c) (
            IOHIDEventSystemClientRef,
            IOHIDEventRef
        )
            -> Void

        private func pressConsumerKeyViaHID(usage: UInt32, button: String) throws {
            guard let handle = openIOKitHandle() else {
                throw GestureError.notSupported("\(button) HID support unavailable")
            }
            defer { dlclose(handle) }

            let createEventSymbol = dlsym(handle, "IOHIDEventCreateKeyboardEvent")
            let createClientSymbol = dlsym(handle, "IOHIDEventSystemClientCreate")
            let dispatchEventSymbol = dlsym(handle, "IOHIDEventSystemClientDispatchEvent")

            guard let createEventSymbol, let createClientSymbol, let dispatchEventSymbol else {
                throw GestureError.notSupported("\(button) HID symbols unavailable")
            }

            let createKeyboardEvent = unsafeBitCast(
                createEventSymbol,
                to: IOHIDEventCreateKeyboardEventFn.self
            )
            let createSystemClient = unsafeBitCast(
                createClientSymbol,
                to: IOHIDEventSystemClientCreateFn.self
            )
            let dispatchEvent = unsafeBitCast(
                dispatchEventSymbol,
                to: IOHIDEventSystemClientDispatchEventFn.self
            )

            guard let retainedClient = createSystemClient(nil) else {
                throw GestureError.notSupported("\(button) HID client unavailable")
            }
            let client = retainedClient.takeRetainedValue()

            let consumerUsagePage: UInt32 = 0x0C
            let eventTimestamp: UInt64 = 0
            let eventOptions: UInt32 = 0

            guard let retainedKeyDown = createKeyboardEvent(
                nil,
                eventTimestamp,
                consumerUsagePage,
                usage,
                true,
                eventOptions
            ) else {
                throw GestureError.notSupported("\(button) HID key-down event unavailable")
            }
            let keyDown = retainedKeyDown.takeRetainedValue()

            guard let retainedKeyUp = createKeyboardEvent(
                nil,
                eventTimestamp,
                consumerUsagePage,
                usage,
                false,
                eventOptions
            ) else {
                throw GestureError.notSupported("\(button) HID key-up event unavailable")
            }
            let keyUp = retainedKeyUp.takeRetainedValue()

            dispatchEvent(client, keyDown)
            dispatchEvent(client, keyUp)
        }

        private func openIOKitHandle() -> UnsafeMutableRawPointer? {
            let paths = [
                "/System/Library/Frameworks/IOKit.framework/IOKit",
                "/System/Library/PrivateFrameworks/IOKit.framework/IOKit",
            ]
            for path in paths {
                if let handle = dlopen(path, RTLD_NOW) {
                    return handle
                }
            }
            return nil
        }

        public func openRecentApps() throws -> Bool {
            guard let app = resolveNavigationApp() else {
                throw GestureError.noApplication
            }

            try catchingObjCException {
                let frame = app.frame
                guard frame.width > 0, frame.height > 0 else {
                    throw GestureError.gestureFailed("Cannot determine application frame for recent apps gesture")
                }

                let startCoordinate = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: frame.width / 2, dy: frame.height - 1))
                let endCoordinate = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: frame.width / 2, dy: frame.height * 0.58))
                let distance = abs((frame.height - 1) - (frame.height * 0.58))
                let velocity = XCUIGestureVelocity(distance / 0.6)

                startCoordinate.press(
                    forDuration: 0.35,
                    thenDragTo: endCoordinate,
                    withVelocity: velocity,
                    thenHoldForDuration: 0.8
                )
            }

            return catchingObjCExceptionNonThrowing({
                AppSwitcherDetector.isVisible(in: springboard)
            }, fallback: false)
        }

        // MARK: - App Control

        public func launchApp(bundleId: String) throws {
            try catchingObjCException {
                let app = XCUIApplication(bundleIdentifier: bundleId)
                app.launch()
            }
        }

        public func terminateApp(bundleId: String) throws {
            try catchingObjCException {
                let app = XCUIApplication(bundleIdentifier: bundleId)
                app.terminate()
            }
        }

        public func activateApp(bundleId: String) throws {
            try catchingObjCException {
                let app = XCUIApplication(bundleIdentifier: bundleId)
                app.activate()
            }
        }

        public func updateApplication(bundleId: String) {
            catchingObjCExceptionNonThrowing({
                let app = XCUIApplication(bundleIdentifier: bundleId)
                self.ownedApplication = app
                self.pinnedBundleId = bundleId
                self.application = app
            }, fallback: ())
        }

        // MARK: - App Privacy Permissions

        /// Reset each named resource's authorization to not-determined on the target
        /// app. `resetAuthorizationStatus(for:)` (Xcode 11.4+) works on real devices,
        /// not just simulators — the whole point of #2491. An AutoMobile permission
        /// with no `XCUIProtectedResource` equivalent (e.g. `siri`, `motion`) throws
        /// `invalidParameter` so the caller reports it as a per-permission failure.
        /// The aggregate `all` keyword expands to every unique resettable
        /// `XCUIProtectedResource` value before calling XCTest.
        public func resetAuthorizations(bundleId: String, resources: [String]) throws {
            // Throws on the first unmapped resource, so a mixed batch applies the
            // resets before it and then fails as a whole. The TS client sends one
            // permission per request, so each is isolated and accounted per-permission;
            // this only matters for a hypothetical multi-resource single request.
            try catchingObjCException {
                let app = XCUIApplication(bundleIdentifier: bundleId)
                var resetResourceNames = Set<String>()
                for raw in resources {
                    guard let resettableResourceNames = Self.expandedPrivacyResourceNames(for: raw) else {
                        throw CommandError.invalidParameter("permission", raw)
                    }
                    for resettableResourceName in resettableResourceNames {
                        let canonicalResourceName = Self.canonicalPrivacyResourceName(for: resettableResourceName)
                        if resetResourceNames.contains(canonicalResourceName) {
                            continue
                        }
                        guard let resource = Self.protectedResource(for: resettableResourceName) else {
                            throw CommandError.invalidParameter("permission", resettableResourceName)
                        }
                        resetResourceNames.insert(canonicalResourceName)
                        app.resetAuthorizationStatus(for: resource)
                    }
                }
            }
        }

        /// Map an AutoMobile permission name to the `XCUIProtectedResource` the
        /// runner can reset. Names without an XCUITest equivalent return nil (the
        /// support matrix is advertised honestly — see issue #2491). The mapping is
        /// authoritative here rather than duplicated on the TS host, since
        /// `XCUIProtectedResource` only exists in this process.
        static func protectedResource(for name: String) -> XCUIProtectedResource? {
            switch name {
            case "camera": return .camera
            case "photos", "photos-add": return .photos
            case "microphone": return .microphone
            case "contacts", "contacts-limited": return .contacts
            case "location", "location-always": return .location
            case "calendar": return .calendar
            case "reminders": return .reminders
            case "media-library": return .mediaLibrary
            case "homekit": return .homeKit
            case "focus": return .focus
            case "bluetooth": return .bluetooth
            case "keyboard-network": return .keyboardNetwork
            case "health": return .health
            case "user-tracking": return .userTracking
            case "local-network":
                // `XCUIProtectedResourceLocalNetwork` is iOS 15.4+ only. Below that
                // OS version there is no resettable equivalent, so return nil and let
                // the caller surface an honest per-permission failure instead of
                // silently skipping it.
                if #available(iOS 15.4, *) {
                    return .localNetwork
                }
                return nil
            default: return nil
            }
        }

    #else
        /// Non-iOS stub implementation
        private let elementLocator: ElementLocating

        public init(
            elementLocator: ElementLocating,
            keyboardClock: any Clock<Duration> = ContinuousClock()
        ) {
            self.elementLocator = elementLocator
            self.keyboardClock = keyboardClock
        }

        public func tap(x _: Double, y _: Double, duration _: TimeInterval = 0) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func swipe(
            startX _: Double,
            startY _: Double,
            endX _: Double,
            endY _: Double,
            duration _: TimeInterval
        )
            throws
        {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func multiFingerSwipe(
            startX _: Double,
            startY _: Double,
            endX _: Double,
            endY _: Double,
            fingerCount _: Int,
            fingerSpacing _: Double,
            duration _: TimeInterval
        )
            throws
        {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func drag(
            startX _: Double,
            startY _: Double,
            endX _: Double,
            endY _: Double,
            pressDuration _: TimeInterval,
            dragDuration _: TimeInterval,
            holdDuration _: TimeInterval
        )
            throws
        {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        @discardableResult
        public func pinch(
            centerX _: Double,
            centerY _: Double,
            distanceStart _: Double,
            distanceEnd _: Double,
            rotationDegrees _: Double,
            duration _: TimeInterval
        )
            throws -> PinchGesturePath
        {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func typeText(text _: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func appendText(text _: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func setText(resourceId _: String, text _: String) async throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func clearText(resourceId _: String?) async throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func selectAll() throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func performImeAction(_: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        @discardableResult
        public func pressKey(key _: String, modifiers _: [String]) async throws -> Bool? {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func keyboard(action _: String) async throws -> KeyboardActionResult {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func performAction(
            _: String,
            resourceId _: String?,
            label _: String?,
            bounds _: ElementBounds?,
            duration _: Int?
        )
            throws
        {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func activateAccessibilityLink(text _: String, occurrence _: Int, ownerResourceId _: String?) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func getScreenshot() throws -> Data {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func setOrientation(_: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func getOrientation() -> String {
            return "unknown"
        }

        public func getDisplayRotation() -> Int? {
            nil
        }

        public func clipboard(action _: String, text _: String?) throws -> String? {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func pressHome() throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func pressBack() throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func shake() throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func pressButton(_: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func openRecentApps() throws -> Bool {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func launchApp(bundleId _: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func terminateApp(bundleId _: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func activateApp(bundleId _: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func updateApplication(bundleId _: String) {
            // no-op on non-iOS
        }

        public func resetAuthorizations(bundleId _: String, resources _: [String]) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }
    #endif

    nonisolated static func longPressDuration(_ milliseconds: Int?) -> TimeInterval {
        TimeInterval(milliseconds ?? 1000) / 1000.0
    }
}
