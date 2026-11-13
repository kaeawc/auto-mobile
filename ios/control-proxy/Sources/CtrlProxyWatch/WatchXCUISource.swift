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
            let route = try watchTapRoute(
                x: x, y: y, hasAlerts: !systemAlerts().isEmpty,
                appForeground: app.state == .runningForeground, clockfaceFrame: { clockface.frame }
            )
            switch route {
            case let .clockface(offset):
                clockface.coordinate(withNormalizedOffset: offset).tap()
            case .systemAlert:
                system.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y)).tap()
            case .app:
                app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y)).tap()
            }
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
            let hasAlerts = !systemAlerts().isEmpty
            let appForeground = app.state == .runningForeground
            let route = watchSwipeRoute(
                hasAlerts: hasAlerts, appForeground: appForeground,
                clockfaceForeground: !hasAlerts && !appForeground && clockface.state == .runningForeground
            )
            let target: XCUIApplication = switch route {
            case .app, .systemAlert: app
            case .clockface: clockface
            case .system: system
            }
            if let distance {
                // The default swipe scrolls about two screens on a watch. A partial drag moves the
                // content by a fraction of the screen so consecutive lookFor reads overlap.
                let (from, to) = watchSwipeVectors(direction: direction, distance: distance)
                // A slow drag that holds before release ends without fling momentum.
                target.coordinate(withNormalizedOffset: from).press(
                    forDuration: 0.05, thenDragTo: target.coordinate(withNormalizedOffset: to),
                    withVelocity: .slow, thenHoldForDuration: 0.3
                )
                return
            }
            switch route {
            case .app, .systemAlert:
                switch direction {
                case .up: app.swipeUp()
                case .down: app.swipeDown()
                case .left: app.swipeLeft()
                case .right: app.swipeRight()
                }
            case .clockface, .system:
                // Element swipes can block while resolving the clockface or system snapshot.
                let (from, to) = watchSwipeVectors(direction: direction, distance: nil)
                target.coordinate(withNormalizedOffset: from).press(
                    forDuration: 0.05, thenDragTo: target.coordinate(withNormalizedOffset: to),
                    withVelocity: .default, thenHoldForDuration: 0
                )
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
            // A background-app coordinate tap can block every subsequent runner command.
            guard self.app.state == .runningForeground else { return }
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
        let count = focused.count
        // SwiftUI's digitalCrownRotation does not set XCUI hasFocus (device-checked on watchOS 26.5,
        // #17549), so with no focused element the app's single readable non-scrolling value is the target.
        if count == 0 {
            return watchCrownFocusedValue([crownCandidate(try app.snapshot())])
        }
        // A larger set is not a single crown target; skip the per-element snapshots.
        guard (1 ... 8).contains(count) else { return nil }
        let candidates = try (0 ..< count).map { try crownCandidate(focused.element(boundBy: $0).snapshot()) }
        return watchCrownFocusedValue(candidates)
    }

    private func crownCandidate(_ snapshot: any XCUIElementSnapshot) -> WatchCrownCandidate {
        WatchCrownCandidate(
            elementType: snapshot.elementType.rawValue, identifier: snapshot.identifier, frame: snapshot.frame,
            value: (snapshot.value as? String) ?? (snapshot.value as? NSNumber)?.stringValue,
            isEnabled: snapshot.isEnabled, children: snapshot.children.map { crownCandidate($0) }
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
