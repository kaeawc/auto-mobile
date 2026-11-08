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

    private let app: XCUIApplication
    private let failureCoordinator: CommandFailureCoordinator

    init(app: XCUIApplication, failureCoordinator: CommandFailureCoordinator) {
        self.app = app
        self.failureCoordinator = failureCoordinator
    }

    func snapshot() throws -> SdkViewHierarchy {
        // XCTest can retain this app's tree after Home even though the watch face is visible.
        guard app.state == .runningForeground else {
            throw WatchCommandError.appNotForeground
        }
        let root = try app.snapshot()
        // XCUITest frames and gesture coordinates are points. No pixel scale is inferred.
        return SdkViewHierarchy(
            screenScale: 1, screenWidth: Int(root.frame.width), screenHeight: Int(root.frame.height),
            root: node(root)
        )
    }

    private func node(_ snapshot: any XCUIElementSnapshot) -> SdkViewNode {
        let frame = snapshot.frame
        let bounds = SdkBounds(
            left: Int(frame.minX), top: Int(frame.minY), right: Int(frame.maxX), bottom: Int(frame.maxY)
        )
        let className = "XCUIElementType(\(snapshot.elementType.rawValue))"
        var children = snapshot.children.map { node($0) }
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

    func tap(x: Double, y: Double) throws {
        try performGesture {
            app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y)).tap()
        }
    }

    func tap(identifier: String) throws {
        try performGesture {
            let element = app.descendants(matching: .any).matching(identifier: identifier).firstMatch
            guard element.exists else {
                throw WatchCommandError.commandFailed("No watchOS element with identifier '\(identifier)'")
            }
            element.tap()
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
        try watchVerifiedCrownRotation(snapshots: self, wake: {
            try self.performGesture {
                // Touch the app's top-left margin, away from its crown-receiving controls.
                self.app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.1)).tap()
            }
        }, rotate: {
            try self.rotateFocusedCrown(delta: delta, velocity: velocity)
        })
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

/// Stabilizes the baseline, then retries an unchanged rotation once after a neutral touch wakes crown
/// routing. Missing snapshots skip verification: an unverified rotation may already have taken effect
/// and must not be repeated.
@MainActor
func watchVerifiedCrownRotation(
    snapshots: any WatchSnapshotSource, wake: () throws -> Void, rotate: () throws -> Void
)
    throws
{
    func baseline() -> SdkViewHierarchy? {
        guard var previous = try? snapshots.snapshot() else { return nil }
        for _ in 0 ..< 2 {
            guard let current = try? snapshots.snapshot() else { return nil }
            if !watchCrownChangedHierarchy(before: previous, after: current) { return current }
            previous = current
        }
        return previous
    }

    let before = baseline()
    try rotate()
    guard let before, let after = try? snapshots.snapshot(),
          !watchCrownChangedHierarchy(before: before, after: after)
    else {
        return
    }

    try wake()
    let retryBefore = baseline()
    try rotate()
    guard let retryBefore, let retryAfter = try? snapshots.snapshot(),
          !watchCrownChangedHierarchy(before: retryBefore, after: retryAfter)
    else {
        return
    }
    throw WatchCommandError.commandFailed(
        "rotateCrown changed nothing the accessibility tree shows, even after retrying once after a neutral touch: "
            + "no view may hold crown focus, or the "
            + "scrolled content is already at its limit. Tap the view that should receive the crown, then "
            + "observe to confirm."
    )
}
