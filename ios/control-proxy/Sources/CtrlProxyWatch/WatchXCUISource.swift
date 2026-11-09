import AutoMobileSdkWire
import Foundation
import os
import XCTest

@MainActor
final class WatchXCUISource: WatchSnapshotSource, WatchGesturePerformer {
    /// XCTest may record gesture failures without throwing. Deflect only while a gesture runs.
    final class CommandFailureCoordinator: Sendable {
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

    private lazy var clockface = XCUIApplication(bundleIdentifier: "com.apple.clockface")
    private let app: XCUIApplication
    private let system: XCUIApplication
    private let failureCoordinator: CommandFailureCoordinator

    init(
        app: XCUIApplication, failureCoordinator: CommandFailureCoordinator,
        system: XCUIApplication = XCUIApplication(bundleIdentifier: "com.apple.Carousel")
    ) {
        self.app = app
        self.system = system
        self.failureCoordinator = failureCoordinator
    }

    func snapshot() throws -> SdkViewHierarchy {
        let alerts = systemAlerts()
        let root: any XCUIElementSnapshot
        let children: [SdkViewNode]?
        if app.state == .runningForeground {
            root = try app.snapshot()
            children = alerts.isEmpty ? nil : alerts.map { node($0) } + root.children.map { node($0) }
        } else {
            // XCTest can retain the host tree after Home. Only system alerts are valid then.
            guard !alerts.isEmpty, let systemRoot = try? system.snapshot() else {
                throw WatchCommandError.appNotForeground
            }
            root = systemRoot
            children = alerts.map { node($0) }
        }
        // XCUITest frames and gesture coordinates are points. No pixel scale is inferred.
        return SdkViewHierarchy(
            screenScale: 1, screenWidth: Int(root.frame.width), screenHeight: Int(root.frame.height),
            root: node(root, children: children)
        )
    }

    /// `system.snapshot()` returns only the frontmost window on watchOS, so the permission prompt and
    /// notification looks are read through the alert query, one element snapshot each.
    private func systemAlerts() -> [any XCUIElementSnapshot] {
        let trees = system.alerts.allElementsBoundByIndex
            .compactMap { try? $0.snapshot() }
            .map { alertTree($0) }
        return watchSystemAlerts(in: trees)
    }

    private func alertTree(_ snapshot: any XCUIElementSnapshot) -> WatchAlertTree<any XCUIElementSnapshot> {
        WatchAlertTree(
            element: snapshot, elementType: snapshot.elementType.rawValue, frame: snapshot.frame,
            label: snapshot.label, identifier: snapshot.identifier,
            children: snapshot.children.map { alertTree($0) }
        )
    }

    private func node(_ snapshot: any XCUIElementSnapshot, children: [SdkViewNode]? = nil) -> SdkViewNode {
        let frame = snapshot.frame
        let bounds = SdkBounds(
            left: Int(frame.minX), top: Int(frame.minY), right: Int(frame.maxX), bottom: Int(frame.maxY)
        )
        let className = "XCUIElementType(\(snapshot.elementType.rawValue))"
        var children = children ?? snapshot.children.map { node($0) }
        if let value = watchTextValueChild(
            elementType: snapshot.elementType.rawValue, label: snapshot.label, value: snapshot.value as? String
        ) {
            children.append(SdkViewNode(
                className: className, bounds: bounds, accessibilityLabel: value,
                accessibilityIdentifier: snapshot.identifier, isUserInteractionEnabled: snapshot.isEnabled
            ))
        }
        return SdkViewNode(
            // Preserve the XCUITest raw element type without claiming an in-app SwiftUI class.
            className: className,
            bounds: bounds,
            accessibilityLabel: watchAccessibilityLabel(
                elementType: snapshot.elementType.rawValue, label: snapshot.label,
                value: snapshot.value as? String, placeholder: snapshot.placeholderValue
            ),
            accessibilityIdentifier: snapshot.identifier,
            isUserInteractionEnabled: snapshot.isEnabled,
            children: children
        )
    }

    func faceTap(x: Double, y: Double) throws {
        try performGesture {
            clockface.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)).tap()
        }
    }

    func faceDrag(fromX: Double, fromY: Double, toX: Double, toY: Double) throws {
        try performGesture {
            clockface.coordinate(withNormalizedOffset: CGVector(dx: fromX, dy: fromY)).press(
                forDuration: 0.1,
                thenDragTo: clockface.coordinate(withNormalizedOffset: CGVector(dx: toX, dy: toY))
            )
        }
    }

    func faceSwipe(_ direction: WatchSwipeDirection) throws {
        try performGesture {
            switch direction {
            case .up: clockface.swipeUp()
            case .down: clockface.swipeDown()
            case .left: clockface.swipeLeft()
            case .right: clockface.swipeRight()
            }
        }
    }

    func faceDump() throws -> String {
        var text = ""
        try performGesture { text = clockface.debugDescription }
        return text
    }

    func tap(x: Double, y: Double) throws {
        try performGesture {
            let target = systemAlerts().isEmpty ? app : system
            target.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y)).tap()
        }
    }

    func tap(identifier: String) throws {
        try performGesture {
            let element = app.descendants(matching: .any).matching(identifier: identifier).firstMatch
            if element.exists {
                element.tap()
                return
            }
            let systemElement = system.descendants(matching: .any).matching(NSPredicate(
                format: "identifier == %@ OR label == %@", identifier, identifier
            )).firstMatch
            guard systemElement.exists else {
                throw WatchCommandError.commandFailed("No watchOS element with identifier '\(identifier)'")
            }
            systemElement.tap()
        }
    }

    func swipe(_ direction: WatchSwipeDirection, distance: Double?) throws {
        try performGesture {
            if let distance {
                // The default swipe scrolls about two screens on a watch. A partial drag moves the
                // content by a fraction of the screen so consecutive lookFor reads overlap.
                let half = distance / 2
                let (from, to): (CGVector, CGVector) = switch direction {
                case .up: (CGVector(dx: 0.5, dy: 0.5 + half), CGVector(dx: 0.5, dy: 0.5 - half))
                case .down: (CGVector(dx: 0.5, dy: 0.5 - half), CGVector(dx: 0.5, dy: 0.5 + half))
                case .left: (CGVector(dx: 0.5 + half, dy: 0.5), CGVector(dx: 0.5 - half, dy: 0.5))
                case .right: (CGVector(dx: 0.5 - half, dy: 0.5), CGVector(dx: 0.5 + half, dy: 0.5))
                }
                // A slow drag that holds before release ends without fling momentum.
                app.coordinate(withNormalizedOffset: from).press(
                    forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: to),
                    withVelocity: .slow, thenHoldForDuration: 0.3
                )
                return
            }
            switch direction {
            case .up: app.swipeUp()
            case .down: app.swipeDown()
            case .left: app.swipeLeft()
            case .right: app.swipeRight()
            }
        }
    }

    func typeText(_ text: String) throws {
        try performGesture {
            let field = app.descendants(matching: .any).matching(NSPredicate(
                format: "(elementType == %d OR elementType == %d OR elementType == %d) AND hasKeyboardFocus == true",
                XCUIElement.ElementType.textField.rawValue,
                XCUIElement.ElementType.secureTextField.rawValue,
                XCUIElement.ElementType.searchField.rawValue
            )).firstMatch
            if field.exists {
                field.typeText(text)
                return
            }
            // watchOS presents a focused text field's input as a keyboard sheet that hides the field,
            // so the field is no longer in the keyboard-focus query. Type into the presented keyboard.
            guard app.keyboards.firstMatch.exists else {
                throw WatchCommandError.commandFailed("No focused text field; tap the field first")
            }
            app.typeText(text)
        }
    }

    func home() throws {
        try performGesture { XCUIDevice.shared.press(.home) }
    }

    func rotateCrown(delta: Double, velocity: Double) throws {
        try watchVerifiedCrownRotation(snapshots: self, focusedValue: {
            try self.focusedCrownValue()
        }, wake: { point in
            try self.performGesture {
                self.app.coordinate(withNormalizedOffset: point).tap()
            }
        }, rotate: {
            try self.rotateFocusedCrown(delta: delta, velocity: velocity)
        })
    }

    private func focusedCrownValue() throws -> WatchCrownValue? {
        guard app.state == .runningForeground, systemAlerts().isEmpty else { return nil }
        let focused = app.descendants(matching: .any).matching(NSPredicate(format: "hasFocus == true"))
        guard focused.count == 1 else { return nil }
        let snapshot = try focused.element(boundBy: 0).snapshot()
        let value = (snapshot.value as? String) ?? (snapshot.value as? NSNumber)?.stringValue
        guard snapshot.isEnabled, let value, !value.isEmpty else { return nil }
        return WatchCrownValue(
            elementType: snapshot.elementType.rawValue, identifier: snapshot.identifier,
            frame: snapshot.frame, value: value
        )
    }

    private func rotateFocusedCrown(delta: Double, velocity: Double) throws {
        try performGesture {
            // Rotate the currently focused control using a private selector with unboxed Double arguments.
            let device = XCUIDevice.shared
            let selector = NSSelectorFromString("rotateDigitalCrownByDelta:withVelocity:")
            guard device.responds(to: selector) else {
                throw WatchCommandError.unsupported("crown")
            }
            let rotate = unsafeBitCast(
                device.method(for: selector),
                to: (@convention(c) (AnyObject, Selector, Double, Double) -> Void).self
            )
            rotate(device, selector, delta, velocity)
        }
    }

    private func performGesture(_ gesture: () throws -> Void) throws {
        failureCoordinator.begin()
        let result = Result { try gesture() }
        let failures = failureCoordinator.finish()
        if !failures.isEmpty {
            throw WatchCommandError.commandFailed(failures.joined(separator: "\n"))
        }
        try result.get()
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
/// Failing to find a point is preferable to tapping a control or guessing at an unreadable screen.
func watchCrownWakePoint(in hierarchy: SdkViewHierarchy) -> CGVector? {
    guard hierarchy.screenWidth > 0, hierarchy.screenHeight > 0, let root = hierarchy.root,
          root.bounds.left == 0, root.bounds.top == 0,
          root.bounds.right == hierarchy.screenWidth, root.bounds.bottom == hierarchy.screenHeight
    else { return nil }
    let controlClasses = Set(watchTapElementTypes.union([21, 25]).map { "XCUIElementType(\($0))" })
    func blocked(_ node: SdkViewNode, x: Double, y: Double) -> Bool {
        let bounds = node.bounds
        // Application/window labels describe the whole screen, not a tappable content element.
        let labeledContent = !["XCUIElementType(2)", "XCUIElementType(4)"].contains(node.className)
            && !(node.accessibilityLabel ?? "").isEmpty
        let activates = controlClasses.contains(node.className)
            || (node.isUserInteractionEnabled && (node.hasTapTarget || labeledContent))
        if activates, bounds.right > bounds.left, bounds.bottom > bounds.top,
           x >= Double(bounds.left) - 8, x <= Double(bounds.right) + 8,
           y >= Double(bounds.top) - 8, y <= Double(bounds.bottom) + 8
        { return true }
        return (node.children ?? []).contains { blocked($0, x: x, y: y) }
    }
    for y in [0.5, 0.65, 0.8, 0.4] {
        for x in [0.5, 0.65, 0.8, 0.35] where !blocked(
            root, x: x * Double(hierarchy.screenWidth), y: y * Double(hierarchy.screenHeight)
        ) {
            return CGVector(dx: x, dy: y)
        }
    }
    return nil
}

/// A stable screen without a focused value can receive a neutral wake before rotation.
/// An unchanged tree alone cannot justify repeating a delta. Retry only when the same focused
/// accessible value is unchanged, and the safe wake has not changed the screen or focused control.
/// Missing snapshots skip verification because the rotation may already have taken effect.
@MainActor
func watchVerifiedCrownRotation(
    snapshots: any WatchSnapshotSource, focusedValue: () throws -> WatchCrownValue?,
    wake: (CGVector) throws -> Void, rotate: () throws -> Void
)
    throws
{
    func observation() throws -> (hierarchy: SdkViewHierarchy, value: WatchCrownValue?) {
        let hierarchy = try snapshots.snapshot()
        return (hierarchy, try? focusedValue())
    }
    func baseline() -> (hierarchy: SdkViewHierarchy, value: WatchCrownValue?)? {
        guard var previous = try? observation() else { return nil }
        for _ in 0 ..< 2 {
            guard let current = try? observation() else { return nil }
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
    func unchanged() -> WatchCommandError {
        .commandFailed(
            "rotateCrown changed nothing verifiable. A safe retry requires an unchanged "
                + "focused accessibility value and a neutral wake point. No view may hold crown focus, or "
                + "the scrolled content is already at its limit. Tap the crown target (for example "
                + "tapOn ctrlproxy-crown), then retry rotateCrown."
        )
    }

    var before = baseline()
    var proactivelyWoke = false
    if let initial = before, initial.value == nil, let point = watchCrownWakePoint(in: initial.hierarchy) {
        try wake(point)
        proactivelyWoke = true
        before = baseline()
    }
    try rotate()
    guard let before, let after = try? observation(), !changed(before, after) else { return }
    // A cold wake already prepared routing; without comparable values, never repeat this delta.
    if proactivelyWoke, before.value == nil || after.value == nil { throw unchanged() }
    guard let point = watchCrownWakePoint(in: before.hierarchy) else { throw unchanged() }

    try wake(point)
    // Without a readable value, wake routing for the next command but never repeat this delta.
    guard let value = before.value, after.value == value,
          let retryBefore = baseline(), retryBefore.value == value,
          !watchCrownChangedHierarchy(before: after.hierarchy, after: retryBefore.hierarchy)
    else { throw unchanged() }
    try rotate()
    guard let retryAfter = try? observation(), !changed(retryBefore, retryAfter) else { return }
    throw unchanged()
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
