import AutoMobileSdkWire
import CoreGraphics
import Foundation
import os

/// XCTest may record gesture failures without throwing. Deflect only while a gesture runs.
final class WatchCommandFailureCoordinator: Sendable {
    static let maxFailures = 16
    static let maxDescriptionBytes = 4096
    private static let truncationIndicator = "Additional command failures truncated"

    private struct Window: Sendable {
        var failures: [String] = []
        var descriptionBytes = 0
        var truncated = false
    }

    private let window = OSAllocatedUnfairLock<Window?>(initialState: nil)

    func begin() {
        window.withLock { $0 = Window() }
    }

    func recordDeflectedFailure(_ description: String) -> Bool {
        window.withLock { state in
            guard var command = state else { return false }
            if !command.truncated {
                let remaining = Self.maxDescriptionBytes - Self.truncationIndicator.utf8.count
                    - command.descriptionBytes
                if command.failures.count == Self.maxFailures || description.utf8.count > remaining {
                    if remaining > 0, command.failures.count < Self.maxFailures {
                        var prefix = ""
                        var prefixBytes = 0
                        for scalar in description.unicodeScalars {
                            let scalarBytes = String(scalar).utf8.count
                            if prefixBytes + scalarBytes > remaining { break }
                            prefix.unicodeScalars.append(scalar)
                            prefixBytes += scalarBytes
                        }
                        if !prefix.isEmpty {
                            command.failures.append(prefix)
                            command.descriptionBytes += prefixBytes
                        }
                    }
                    command.failures.append(Self.truncationIndicator)
                    command.truncated = true
                } else {
                    command.failures.append(description)
                    command.descriptionBytes += description.utf8.count
                }
            }
            state = command
            return true
        }
    }

    func finish() -> [String] {
        window.withLock { state in
            let failures = state?.failures ?? []
            state = nil
            return failures
        }
    }
}

/// True when the rotation changed anything observable. Compares the node tree only: the wrapper's
/// timestamp changes on every snapshot.
func watchCrownChangedHierarchy(before: SdkViewHierarchy, after: SdkViewHierarchy) -> Bool {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    guard let old = try? encoder.encode(before.root), let new = try? encoder.encode(after.root) else {
        return true
    }
    return old != new
}

/// A focused value is read separately because the wire hierarchy does not carry XCUI's value attribute.
struct WatchCrownValue: Equatable {
    let elementType: UInt
    let identifier: String
    let frame: CGRect
    let value: String
}

/// XCUI raw types for controls that a touch can activate, including notification action cells.
private let watchTapElementTypes: Set<UInt> = [
    9, 10, 11, 12, 13, 14, 15, 16, 17, 19, 20, 22, 23, 24, 27, 30, 33, 34, 37, 38, 39, 40, 41, 42,
    45, 47, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 62, 67, 75, 78, 79, 80, 81, 82,
]

/// Search a small interior grid, leaving the top navigation band and left/back area untouched.
/// Stay eight points clear of descendant frames except application/window containers and .other nodes
/// with no label or identifier that have children and are non-actionable, or are non-interactive leaves.
/// Enabled nodes with traits, custom actions, or a tap target are actionable. Always inspect children.
func watchCrownWakePoint(in hierarchy: SdkViewHierarchy) -> CGVector? {
    guard hierarchy.screenWidth > 0, hierarchy.screenHeight > 0, let root = hierarchy.root,
          root.bounds.left == 0, root.bounds.top == 0,
          root.bounds.right == hierarchy.screenWidth, root.bounds.bottom == hierarchy.screenHeight
    else { return nil }
    func blocked(_ node: SdkViewNode, x: Double, y: Double) -> Bool {
        let bounds = node.bounds
        let children = node.children ?? []
        let unlabeled = (node.accessibilityLabel ?? "").isEmpty && (node.accessibilityIdentifier ?? "").isEmpty
        let actionable = node.isUserInteractionEnabled
            && (!node.accessibilityTraits.isEmpty || !node.accessibilityCustomActions.isEmpty || node.hasTapTarget)
        let structuralOther = node.className == "XCUIElementType(1)" && unlabeled && !actionable
            && (!children.isEmpty || !node.isUserInteractionEnabled)
        let container = ["XCUIElementType(2)", "XCUIElementType(4)"].contains(node.className) || structuralOther
        if !container, bounds.right > bounds.left, bounds.bottom > bounds.top,
           x >= Double(bounds.left) - 8, x <= Double(bounds.right) + 8,
           y >= Double(bounds.top) - 8, y <= Double(bounds.bottom) + 8
        { return true }
        return children.contains { blocked($0, x: x, y: y) }
    }
    for y in [0.5, 0.65, 0.8, 0.4] {
        for x in [0.5, 0.65, 0.8, 0.35] where !(root.children ?? []).contains(where: {
            blocked($0, x: x * Double(hierarchy.screenWidth), y: y * Double(hierarchy.screenHeight))
        }) {
            return CGVector(dx: x, dy: y)
        }
    }
    return nil
}

/// The runner cannot read a control's range, so a readable focused value that did not move names
/// both causes (too small a turn, or the limit) and the value itself; the caller can tell from the
/// value which applies. Without a readable focused value, the cause is no crown focus or a scroll limit.
func watchCrownUnchangedMessage(focused: WatchCrownValue?) -> String {
    guard let focused else {
        return "rotateCrown changed nothing verifiable. No focused control exposes a readable value: "
            + "no view may hold crown focus, or the scrolled content is already at its limit. "
            + "Tap the control that should respond to the Digital Crown, then retry rotateCrown."
    }
    return "rotateCrown changed nothing verifiable. The focused control's value stayed \"\(focused.value)\": "
        + "the turn was too small to reach its next step, or the control is already at its limit. "
        + "It is at its limit only if the value is already at the end this turn heads toward; "
        + "otherwise retry rotateCrown with a larger delta in the same direction."
}

/// A stable screen without a focused value can receive a neutral wake before rotation.
/// An unchanged tree alone cannot justify repeating a delta. Retry only when the same focused
/// accessible value is unchanged, and the safe wake has not changed the screen or focused control.
/// Without a stable baseline, compare only the last baseline observation's focused value; never wake or retry.
/// If the hierarchy changes while that value is unchanged, allow one more observation before rejecting the turn.
/// Missing comparable values or post-rotation snapshots skip this check because the turn may have taken effect.
@MainActor
func watchVerifiedCrownRotation(
    snapshots: any WatchSnapshotSource, focusedValue: () throws -> WatchCrownValue?,
    wake: (CGVector) throws -> Void, rotate: () throws -> Void
)
    throws
{
    var lastBaselineObservation: (hierarchy: SdkViewHierarchy, value: WatchCrownValue?)?
    func observation() throws -> (hierarchy: SdkViewHierarchy, value: WatchCrownValue?) {
        let hierarchy = try snapshots.snapshot()
        return (hierarchy, try? focusedValue())
    }
    func baseline() -> (hierarchy: SdkViewHierarchy, value: WatchCrownValue?)? {
        guard var previous = try? observation() else { return nil }
        lastBaselineObservation = previous
        for _ in 0 ..< 2 {
            guard let current = try? observation() else { return nil }
            lastBaselineObservation = current
            if !watchCrownChangedHierarchy(before: previous.hierarchy, after: current.hierarchy),
               previous.value == current.value
            { return current }
            previous = current
        }
        return nil
    }
    func changed(
        _ before: (hierarchy: SdkViewHierarchy, value: WatchCrownValue?),
        _ after: (hierarchy: SdkViewHierarchy, value: WatchCrownValue?)
    )
        -> Bool
    {
        if let old = before.value, let new = after.value,
           old.elementType == new.elementType, old.identifier == new.identifier
        { return old.value != new.value }
        return watchCrownChangedHierarchy(before: before.hierarchy, after: after.hierarchy)
            || (before.value != nil && after.value != nil && before.value != after.value)
    }
    func unchanged(_ focused: WatchCrownValue?) -> WatchCommandError {
        .commandFailed(watchCrownUnchangedMessage(focused: focused))
    }
    /// The focused value shared by both observations, or nil when either is unreadable or they differ.
    func stuckValue(_ old: WatchCrownValue?, _ new: WatchCrownValue?) -> WatchCrownValue? {
        old == new ? old : nil
    }
    func rotationObservation(
        after before: (hierarchy: SdkViewHierarchy, value: WatchCrownValue?)
    )
        -> (hierarchy: SdkViewHierarchy, value: WatchCrownValue?)?
    {
        guard let after = try? observation() else { return nil }
        if let old = before.value, let new = after.value,
           old.elementType == new.elementType, old.identifier == new.identifier, old.value == new.value,
           watchCrownChangedHierarchy(before: before.hierarchy, after: after.hierarchy)
        {
            // The separate focused-value query can lag the changed tree. Read once more, without rotating.
            return (try? observation()) ?? after
        }
        return after
    }

    var before = baseline()
    var proactivelyWoke = false
    if let initial = before, initial.value == nil, let point = watchCrownWakePoint(in: initial.hierarchy) {
        try wake(point)
        proactivelyWoke = true
        before = baseline()
    }
    try rotate()
    guard let before else {
        if let lastBaselineObservation, let old = lastBaselineObservation.value,
           let after = rotationObservation(after: lastBaselineObservation), let new = after.value,
           old.elementType == new.elementType, old.identifier == new.identifier, old.value == new.value
        { throw unchanged(new) }
        return
    }
    guard let after = rotationObservation(after: before), !changed(before, after) else { return }
    // A cold wake already prepared routing; without comparable values, never repeat this delta.
    if proactivelyWoke, before.value == nil || after.value == nil { throw unchanged(nil) }
    guard let point = watchCrownWakePoint(in: before.hierarchy) else {
        throw unchanged(stuckValue(before.value, after.value))
    }

    try wake(point)
    guard let value = before.value, after.value == value,
          let retryBefore = baseline(), retryBefore.value == value,
          !watchCrownChangedHierarchy(before: after.hierarchy, after: retryBefore.hierarchy)
    else { throw unchanged(nil) }
    try rotate()
    guard let retryAfter = rotationObservation(after: retryBefore), !changed(retryBefore, retryAfter) else { return }
    throw unchanged(stuckValue(retryBefore.value, retryAfter.value))
}

/// A value tree keeps alert selection independent of XCTest queries and simulator state.
struct WatchAlertTree<Element> {
    let element: Element
    var elementType: UInt = 1
    var frame: CGRect = .zero
    var label = ""
    var identifier = ""
    var children: [WatchAlertTree<Element>] = []

    var hasContent: Bool {
        // Container identifiers and status images do not make an alert capture coordinate taps.
        // Short looks have static text but no buttons; permission choices may be below the screen.
        if elementType == 25 { return false }
        let contentType = elementType == 7 || elementType == 48 || watchTapElementTypes.contains(elementType)
        return (contentType && (!label.isEmpty || !identifier.isEmpty)) || children.contains { $0.hasContent }
    }

    func matches(_ other: WatchAlertTree<Element>) -> Bool {
        elementType == other.elementType && frame == other.frame && label == other.label
            && identifier == other.identifier && children.count == other.children.count
            && zip(children, other.children).allSatisfy { $0.0.matches($0.1) }
    }

    func containsAlert(_ alert: WatchAlertTree<Element>) -> Bool {
        (elementType == 7 && matches(alert)) || children.contains { $0.containsAlert(alert) }
    }

    var outermostAlerts: [WatchAlertTree<Element>] {
        if elementType == 7 { return hasContent ? [self] : [] }
        return children.flatMap { $0.outermostAlerts }
    }
}

/// Alert queries form a forest: a nested alert can also appear as a separate query result.
/// Compare captured structure, not snapshot object identity, which differs between query results.
func watchSystemAlerts<Element>(in trees: [WatchAlertTree<Element>]) -> [Element] {
    let alerts = trees.flatMap { $0.outermostAlerts }
    return alerts.filter { alert in
        !alerts.contains { other in other.children.contains { $0.containsAlert(alert) } }
    }.map(\.element)
}

func watchSystemAlerts<Element>(in tree: WatchAlertTree<Element>) -> [Element] {
    watchSystemAlerts(in: [tree])
}
