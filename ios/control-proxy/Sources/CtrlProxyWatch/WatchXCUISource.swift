import AutoMobileSdkWire
import Foundation
import XCTest

@MainActor
final class WatchXCUISource: WatchSnapshotSource, WatchGesturePerformer {
    typealias CommandFailureCoordinator = WatchCommandFailureCoordinator

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
