import Foundation
import ObjCExceptionCatcher
#if canImport(os)
    import os
#endif
#if os(iOS)
    import UIKit
#endif
#if canImport(XCTest) && os(iOS)
    import XCTest
#endif

/// Logger for text-input focus diagnostics.
/// See `Logging.swift` for the log-level contract shared across CtrlProxy.
private let gestureLog = Logger(subsystem: ctrlProxyLogSubsystem, category: "GesturePerformer")

/// The orientation and its monotonic device-orientation-change generation at a capture boundary.
/// Equal endpoint orientations with different generations represent an A→B→A transition.
struct RotationCaptureSample: Equatable {
    let rotation: Int?
    let generation: UInt64

    static func stableRotation(
        between before: RotationCaptureSample,
        and after: RotationCaptureSample
    ) -> Int? {
        before.rotation == after.rotation && before.generation == after.generation
            ? after.rotation
            : nil
    }
}

/// Tracks device-orientation notifications independently of capture endpoint samples.
///
/// The counter intentionally advances for every notification: even an A→B→A cycle must make
/// in-flight hierarchy and screenshot geometry untrusted, though their endpoint rotations match.
final class RotationChangeGeneration {
    private let lock = NSLock()
    private var generation: UInt64 = 0

    func captureSample(rotation: Int?) -> RotationCaptureSample {
        lock.lock()
        defer { lock.unlock() }
        return RotationCaptureSample(rotation: rotation, generation: generation)
    }

    func recordOrientationChange() {
        lock.lock()
        generation &+= 1
        lock.unlock()
    }
}

protocol RotationSampling {
    func currentRotation() -> Int?
}

protocol RotationChangeSignaling: AnyObject {
    func startObserving(_ handler: @escaping () -> Void)
}

/// Keeps a process-lifetime rotation epoch separate from synchronous XCUI capture work.
final class RotationChangeMonitor {
    private let changeGeneration = RotationChangeGeneration()
    private let signal: RotationChangeSignaling

    init(signal: RotationChangeSignaling) {
        self.signal = signal
        signal.startObserving { [weak self] in
            self?.changeGeneration.recordOrientationChange()
        }
    }

    func captureSample(using sampler: RotationSampling) -> RotationCaptureSample {
        changeGeneration.captureSample(rotation: sampler.currentRotation())
    }

    func capture<T>(
        using sampler: RotationSampling,
        _ operation: () throws -> T
    ) rethrows -> (value: T, rotation: Int?) {
        let beforeCapture = captureSample(using: sampler)
        let value = try operation()
        let afterCapture = captureSample(using: sampler)
        return (
            value,
            RotationCaptureSample.stableRotation(between: beforeCapture, and: afterCapture)
        )
    }
}

/// Maps platform orientation observations to the rotation epoch shared by hierarchy and screenshot
/// frames. A value is intentionally absent when the platform cannot identify an interface rotation.
enum DeviceRotation {
    static func fromOrientationName(_ orientation: String) -> Int? {
        switch orientation {
        case "portrait": return 0
        case "landscape_left": return 1
        case "portrait_upside_down": return 2
        case "landscape_right": return 3
        default: return nil
        }
    }

    #if canImport(XCTest) && os(iOS)
        private final class DeviceOrientationChangeSignal: RotationChangeSignaling {
            private let deliveryQueue: OperationQueue = {
                let queue = OperationQueue()
                queue.name = "dev.jasonpearson.automobile.ctrlproxy.device-orientation"
                queue.maxConcurrentOperationCount = 1
                return queue
            }()
            private var observer: NSObjectProtocol?

            init() {
                UIDevice.current.beginGeneratingDeviceOrientationNotifications()
            }

            func startObserving(_ handler: @escaping () -> Void) {
                observer = NotificationCenter.default.addObserver(
                    forName: UIDevice.orientationDidChangeNotification,
                    object: UIDevice.current,
                    queue: deliveryQueue
                ) { _ in
                    handler()
                }
            }

            deinit {
                if let observer {
                    NotificationCenter.default.removeObserver(observer)
                }
                UIDevice.current.endGeneratingDeviceOrientationNotifications()
            }
        }

        private final class XCUIDeviceRotationSampler: RotationSampling {
            func currentRotation() -> Int? {
                switch XCUIDevice.shared.orientation {
                case .portrait: return 0
                case .landscapeLeft: return 1
                case .portraitUpsideDown: return 2
                case .landscapeRight: return 3
                default: return nil
                }
            }
        }

        private static let rotationSampler = XCUIDeviceRotationSampler()
        private static let changeMonitor = RotationChangeMonitor(signal: DeviceOrientationChangeSignal())

        /// Must be called while constructing the capture owners, before any synchronous XCUI work
        /// can block the runner's main thread.
        static func startMonitoring() {
            _ = changeMonitor
        }

        static func capture<T>(_ operation: () throws -> T) rethrows -> (value: T, rotation: Int?) {
            try changeMonitor.capture(using: rotationSampler, operation)
        }

        static func captureSample() -> RotationCaptureSample {
            changeMonitor.captureSample(using: rotationSampler)
        }

        static func current() -> Int? {
            rotationSampler.currentRotation()
        }

    #endif

    #if os(iOS)
        static func currentGestureInterfaceOrientation() -> UIInterfaceOrientation {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            let activeSceneOrientation = scenes.first(where: {
                $0.activationState == .foregroundActive && isCardinalInterfaceOrientation($0.interfaceOrientation)
            })?.interfaceOrientation
            let sceneOrientation = scenes.first(where: {
                isCardinalInterfaceOrientation($0.interfaceOrientation)
            })?.interfaceOrientation

            return gestureInterfaceOrientation(
                activeSceneOrientation: activeSceneOrientation,
                sceneOrientation: sceneOrientation,
                deviceOrientation: UIDevice.current.orientation
            )
        }

        static func gestureInterfaceOrientation(
            activeSceneOrientation: UIInterfaceOrientation?,
            sceneOrientation: UIInterfaceOrientation?,
            deviceOrientation: UIDeviceOrientation
        ) -> UIInterfaceOrientation {
            if let activeSceneOrientation, isCardinalInterfaceOrientation(activeSceneOrientation) {
                return activeSceneOrientation
            }
            if let sceneOrientation, isCardinalInterfaceOrientation(sceneOrientation) {
                return sceneOrientation
            }

            switch deviceOrientation {
            case .portrait: return .portrait
            case .portraitUpsideDown: return .portraitUpsideDown
            case .landscapeLeft: return .landscapeLeft
            case .landscapeRight: return .landscapeRight
            default: return .portrait
            }
        }

        private static func isCardinalInterfaceOrientation(_ orientation: UIInterfaceOrientation) -> Bool {
            switch orientation {
            case .portrait, .landscapeLeft, .portraitUpsideDown, .landscapeRight:
                return true
            default:
                return false
            }
        }
    #endif
}

/// Performs gestures and interactions using XCUITest APIs
public class GesturePerformer: GesturePerforming {
    public enum GestureError: LocalizedError {
        case noApplication
        case elementNotFound(String)
        case gestureFailed(String)
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

    static func resolveClipboardGet(readResult: ClipboardReadResult) throws -> String? {
        switch readResult {
        case let .value(text):
            return text.isEmpty ? nil : text
        case .empty:
            return nil
        case .unavailable:
            throw GestureError.clipboardReadUnavailable
        }
    }

    /// Every AutoMobile permission name that maps to a resettable iOS
    /// `XCUIProtectedResource` (Xcode 26.3 header). The `all` keyword expands to
    /// this list; the TS host list in `IosPhysicalPermissions.ts`
    /// (`IOS_PHYSICAL_RESET_ALL_PERMISSIONS`) must stay in lock-step so the public
    /// tool path and the direct runner path reset the identical set.
    /// `local-network` is iOS 15.4+ only; below that OS version
    /// `protectedResource(for:)` returns nil so it fails honestly per-permission
    /// rather than being silently skipped.
    static let allResettablePrivacyResourceNames = [
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

    private static let resettablePrivacyResourceAliases = Set(
        allResettablePrivacyResourceNames + [
            "photos-add",
            "contacts-limited",
            "location-always",
        ]
    )

    static func canonicalPrivacyResourceName(for name: String) -> String {
        switch name {
        case "photos-add": return "photos"
        case "contacts-limited": return "contacts"
        case "location-always": return "location"
        default: return name
        }
    }

    static func expandedPrivacyResourceNames(for name: String) -> [String]? {
        if name == "all" {
            return allResettablePrivacyResourceNames
        }
        if resettablePrivacyResourceAliases.contains(name) {
            return [name]
        }
        return nil
    }

    #if canImport(XCTest) && os(iOS)
        private weak var application: XCUIApplication?
        /// Strong reference to keep the application alive when set via updateApplication.
        /// Without this, the weak `application` property would immediately deallocate
        /// freshly created XCUIApplication instances that have no other strong owner.
        private var ownedApplication: XCUIApplication?
        private let elementLocator: ElementLocating

        /// Cached SpringBoard app reference for system alert handling.
        private lazy var springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

        public init(application: XCUIApplication? = nil, elementLocator: ElementLocating) {
            DeviceRotation.startMonitoring()
            self.application = application
            self.elementLocator = elementLocator
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
        private static func snapshotHasTextInputWithFocus(
            _ snapshot: XCUIElementSnapshot,
            depth: Int = 0
        )
            -> Bool
        {
            if depth > 64 { return false }

            let type = snapshot.elementType
            let isKnownTextInput = type == .textField
                || type == .textView
                || type == .secureTextField
            let isTextLikeOther = type == .other && snapshotLooksLikeTextInput(snapshot)

            if (isKnownTextInput || isTextLikeOther) && snapshot.hasFocus {
                return true
            }
            for child in snapshot.children where snapshotHasTextInputWithFocus(child, depth: depth + 1) {
                return true
            }
            return false
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
        /// won. Query runs on the main thread.
        private func detectKeyboardFocus(app: XCUIApplication) throws -> (Bool, String) {
            return try runOnMainThread { [springboard] in
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
                if app.identifier != "com.apple.springboard" {
                    if let snapshot = try? app.snapshot(),
                       GesturePerformer.snapshotHasTextInputWithFocus(snapshot)
                    {
                        return (true, "snapshot.hasFocus")
                    }
                }

                // Strategy 3: keyboard-visibility probe. Covers the case
                // where neither the predicate nor the snapshot picks up
                // focus (e.g., unknown/stale foreground bundle ID) but the
                // user-visible keyboard proves something owns first responder.
                if springboard.keyboards.firstMatch.exists || app.keyboards.firstMatch.exists {
                    return (true, "keyboard-visibility")
                }

                return (false, "none")
            }
        }

        /// Check that some element in the app has keyboard focus.
        /// Throws with a contextual error message if no focus is detected.
        /// On failure, the thrown error embeds a focus-diagnostic summary so
        /// it surfaces in the MCP response — not just in device logs.
        private func requireKeyboardFocus(app: XCUIApplication, context: String) throws {
            let queryStart = Date()
            let (hasFocus, strategy) = try detectKeyboardFocus(app: app)
            let elapsedMs = Int(Date().timeIntervalSince(queryStart) * 1000)
            let appLabel = runOnMainThreadNonThrowing({ app.label }, fallback: "unknown")
            gestureLog
                .debug(
                    "requireKeyboardFocus hasFocus=\(hasFocus, privacy: .public) strategy=\(strategy, privacy: .public) context=\"\(context, privacy: .public)\" elapsedMs=\(elapsedMs, privacy: .public) appLabel=\(appLabel, privacy: .public)"
                )

            guard hasFocus else {
                let diag = buildFocusDiagnostic(app: app, reason: "requireKeyboardFocus: \(context)")
                gestureLog.error("\(diag, privacy: .public)")
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
            throws
        {
            let tapStart = Date()
            gestureLog
                .debug(
                    "tapAndAwaitKeyboardFocus begin resourceId=\(resourceId, privacy: .public) exists=\(element.exists, privacy: .public) isHittable=\(element.isHittable, privacy: .public) type=\(element.elementType.rawValue, privacy: .public)"
                )
            element.tap()

            let deadline = Date().addingTimeInterval(0.5)
            var hasFocus = false
            var strategy = "none"
            var iterations = 0
            while !hasFocus, Date() < deadline {
                let result = try detectKeyboardFocus(app: app)
                hasFocus = result.0
                strategy = result.1
                iterations += 1
                if !hasFocus {
                    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
                }
            }
            let elapsedMs = Int(Date().timeIntervalSince(tapStart) * 1000)
            gestureLog
                .debug(
                    "tapAndAwaitKeyboardFocus done resourceId=\(resourceId, privacy: .public) hasFocus=\(hasFocus, privacy: .public) strategy=\(strategy, privacy: .public) iterations=\(iterations, privacy: .public) elapsedMs=\(elapsedMs, privacy: .public)"
                )

            guard hasFocus else {
                let diag = buildFocusDiagnostic(app: app, reason: "tapAndAwaitKeyboardFocus: \(resourceId)")
                gestureLog.error("\(diag, privacy: .public)")
                throw GestureError.gestureFailed(
                    "Element '\(resourceId)' did not receive keyboard focus after tap. Diagnostic: \(diag)"
                )
            }
        }

        /// Build a compact diagnostic string enumerating candidate text-entry
        /// elements and their focus state, for #1925-style "no keyboard focus"
        /// failures. Returned as a single line so it fits in a WebSocket error.
        private func buildFocusDiagnostic(app: XCUIApplication, reason: String) -> String {
            return runOnMainThreadNonThrowing({ [springboard] in
                var parts: [String] = []
                parts.append("reason=\"\(reason)\"")
                parts.append("app.label=\"\(app.label)\"")
                parts.append("app.identifier=\"\(app.identifier)\"")

                let typesToProbe: [(String, XCUIElement.ElementType)] = [
                    ("textFields", .textField),
                    ("secureTextFields", .secureTextField),
                    ("textViews", .textView),
                    ("searchFields", .searchField),
                ]

                for (name, type) in typesToProbe {
                    let query = app.descendants(matching: type)
                    let count = query.count
                    parts.append("\(name).count=\(count)")

                    // Only introspect a small number to avoid heavy XPC.
                    let cap = min(count, 5)
                    if cap > 0 {
                        for i in 0 ..< cap {
                            let el = query.element(boundBy: i)
                            let hasFocus = (el.value(forKey: "hasKeyboardFocus") as? Bool) ?? false
                            let identifier = el.identifier
                            let value = (el.value as? String) ?? ""
                            let isSelected = el.isSelected
                            let isHittable = el.isHittable
                            let frame = el.frame
                            parts
                                .append(
                                    "\(name)[\(i)]={id=\"\(identifier)\",hasKeyboardFocus=\(hasFocus),isSelected=\(isSelected),isHittable=\(isHittable),value.len=\(value.count),frame=\(Int(frame.origin.x)),\(Int(frame.origin.y)),\(Int(frame.size.width)),\(Int(frame.size.height))}"
                                )
                        }
                    }
                }

                parts.append("app.keyboards.count=\(app.keyboards.count)")
                parts.append("springboard.keyboards.count=\(springboard.keyboards.count)")
                return parts.joined(separator: " | ")
            }, fallback: "reason=\"\(reason)\" [diagnostic collection failed]")
        }

        public func setApplication(_ app: XCUIApplication) {
            ownedApplication = nil
            application = app
        }

        // MARK: - Tap Gestures

        public func tap(x: Double, y: Double, duration: TimeInterval = 0) throws {
            guard let app = application else {
                throw GestureError.noApplication
            }

            try runOnMainThread {
                let coordinate = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: x, dy: y))

                if duration > 0 {
                    coordinate.press(forDuration: duration)
                } else {
                    coordinate.tap()
                }
            }
        }

        public func doubleTap(x: Double, y: Double) throws {
            guard let app = application else {
                throw GestureError.noApplication
            }

            try runOnMainThread {
                let coordinate = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: x, dy: y))
                coordinate.doubleTap()
            }
        }

        public func longPress(x: Double, y: Double, duration: TimeInterval) throws {
            guard let app = application else {
                throw GestureError.noApplication
            }

            try runOnMainThread {
                let coordinate = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: x, dy: y))
                coordinate.press(forDuration: duration)
            }
        }

        // MARK: - Swipe Gestures

        public func swipe(startX: Double, startY: Double, endX: Double, endY: Double, duration _: TimeInterval) throws {
            guard let app = application else {
                throw GestureError.noApplication
            }

            try runOnMainThread {
                let startCoordinate = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: startX, dy: startY))
                let endCoordinate = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: endX, dy: endY))

                startCoordinate.press(
                    forDuration: 0.05,
                    thenDragTo: endCoordinate,
                    withVelocity: .default,
                    thenHoldForDuration: 0
                )
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

            try runOnMainThread {
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
            guard let app = application else {
                throw GestureError.noApplication
            }

            try runOnMainThread {
                let startCoordinate = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: startX, dy: startY))
                let endCoordinate = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: endX, dy: endY))

                // XCUICoordinate's drag API takes a velocity (points/second), not a duration,
                // so honor the caller's dragDuration by converting it into the velocity that
                // covers the source→target distance in that time. This gives iOS the same
                // drag-speed control Android has. Fall back to .default when the duration or
                // distance is non-positive (avoids divide-by-zero / infinite velocity).
                let distance = hypot(endX - startX, endY - startY)
                let velocity: XCUIGestureVelocity = (dragDuration > 0 && distance > 0)
                    ? XCUIGestureVelocity(distance / dragDuration)
                    : .default

                // Press, drag, and hold
                startCoordinate.press(
                    forDuration: pressDuration,
                    thenDragTo: endCoordinate,
                    withVelocity: velocity,
                    thenHoldForDuration: holdDuration
                )
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
            guard let app = application else {
                throw GestureError.noApplication
            }

            return try runOnMainThread {
                let orientation = DeviceRotation.currentGestureInterfaceOrientation()
                var errorMessage: NSString?
                var symbolsUnavailable: ObjCBool = false
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

            try runOnMainThread {
                app.typeText(text)
            }
        }

        public func appendText(text: String) throws {
            try typeText(text: text)
        }

        public func setText(resourceId: String, text: String) throws {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }
            guard let element = elementLocator.findElement(byResourceId: resourceId) as? XCUIElement else {
                throw GestureError.elementNotFound(resourceId)
            }

            try runOnMainThread {
                try self.tapAndAwaitKeyboardFocus(app: app, element: element, resourceId: resourceId)
                GesturePerformer.clearFocusedText(app: app, element: element)
                app.typeText(text)
            }
        }

        public func clearText(resourceId: String? = nil) throws {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }

            if let resourceId = resourceId {
                guard let element = elementLocator.findElement(byResourceId: resourceId) as? XCUIElement else {
                    throw GestureError.elementNotFound(resourceId)
                }
                try runOnMainThread {
                    try self.tapAndAwaitKeyboardFocus(app: app, element: element, resourceId: resourceId)
                    GesturePerformer.clearFocusedText(app: app, element: element)
                }
            } else {
                try requireKeyboardFocus(app: app, context: "ensure a text field is focused before clearing")
                let focused = resolveFocusedTextElement(app: app)
                try runOnMainThread {
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
            return (try? runOnMainThread {
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
                    let candidates = query.allElementsBoundByIndex
                    guard !candidates.isEmpty else { continue }
                    for candidate in candidates {
                        guard let snap = try? candidate.snapshot() else { continue }
                        if snap.hasFocus { return candidate }
                    }
                }

                let otherQuery = app.otherElements
                let otherCount = otherQuery.count
                for i in 0 ..< otherCount {
                    let candidate = otherQuery.element(boundBy: i)
                    guard let snap = try? candidate.snapshot() else { continue }
                    if snap.hasFocus, GesturePerformer.snapshotLooksLikeTextInput(snap) {
                        return candidate
                    }
                }

                return nil
            }) ?? nil
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

            try runOnMainThread {
                app.typeKey("a", modifierFlags: .command)
            }
        }

        public func performImeAction(_ action: String) throws {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }

            switch action.lowercased() {
            case "done", "go", "search", "send", "next":
                try runOnMainThread {
                    app.typeText("\n")
                }
            case "previous":
                try runOnMainThread {
                    app.typeKey(.tab, modifierFlags: .shift)
                }
            default:
                throw GestureError.notSupported("IME action: \(action)")
            }
        }

        public func keyboard(action: String) throws -> Bool {
            guard let app = resolveTextInputApp() else {
                throw GestureError.noApplication
            }

            switch action.lowercased() {
            case "detect":
                return isKeyboardVisible(app: app)
            case "open":
                if isKeyboardVisible(app: app) {
                    return true
                }
                guard let focused = resolveFocusedTextElement(app: app) else {
                    throw GestureError.notSupported("No focused text input to open keyboard")
                }
                try runOnMainThread {
                    focused.tap()
                }
                return waitForKeyboardVisibility(app: app, expected: true)
            case "close":
                if !isKeyboardVisible(app: app) {
                    return false
                }
                try typeKeyboardKey(.escape, app: app)
                return waitForKeyboardVisibility(app: app, expected: false)
            default:
                throw GestureError.notSupported("Keyboard action: \(action)")
            }
        }

        private func waitForKeyboardVisibility(
            app: XCUIApplication,
            expected: Bool,
            timeout: TimeInterval = 1.0,
            interval: TimeInterval = 0.05
        )
            -> Bool
        {
            let deadline = Date().addingTimeInterval(timeout)
            var visible = isKeyboardVisible(app: app)
            while visible != expected && Date() < deadline {
                RunLoop.current.run(until: Date().addingTimeInterval(interval))
                visible = isKeyboardVisible(app: app)
            }
            return visible
        }

        private func isKeyboardVisible(app: XCUIApplication) -> Bool {
            return (try? runOnMainThread {
                app.keyboards.firstMatch.exists || self.springboard.keyboards.firstMatch.exists
            }) ?? false
        }

        private func typeKeyboardKey(_ key: XCUIKeyboardKey, app: XCUIApplication) throws {
            try runOnMainThread {
                app.typeKey(key, modifierFlags: [])
            }
        }

        // MARK: - Actions

        public func performAction(_ action: String, resourceId: String? = nil, label: String? = nil) throws {
            var element: XCUIElement? = nil
            if let resourceId = resourceId {
                element = elementLocator.findElement(byResourceId: resourceId) as? XCUIElement
            }
            if element == nil, let label = label {
                element = elementLocator.findElement(byText: label) as? XCUIElement
            }
            guard let found = element else {
                throw GestureError.elementNotFound(resourceId ?? label ?? "unknown")
            }

            try runOnMainThread {
                switch action.lowercased() {
                case "click", "tap", "activate":
                    // "activate" is the VoiceOver activation gesture (issue #2857); for an
                    // element located by label it resolves to a tap, matching "click"/"tap".
                    found.tap()
                case "long_click", "long_press":
                    found.press(forDuration: 1.0)
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

        public func activateAccessibilityLink(
            text: String,
            occurrence: Int,
            ownerResourceId: String?
        ) throws {
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, occurrence >= 0 else {
                throw GestureError.gestureFailed("Semantic link text must be non-blank and occurrence non-negative")
            }
            guard let app = resolveNavigationApp() else {
                throw GestureError.noApplication
            }
            try runOnMainThread {
                let links: [XCUIElement]
                if let ownerResourceId {
                    guard let owner = self.elementLocator.findElement(byResourceId: ownerResourceId) as? XCUIElement,
                          owner.exists
                    else {
                        throw GestureError.elementNotFound(ownerResourceId)
                    }
                    links = owner.descendants(matching: .link).allElementsBoundByIndex
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
            guard let app = application else {
                throw GestureError.noApplication
            }

            return try runOnMainThread {
                let screenshot = app.screenshot()
                return screenshot.pngRepresentation
            }
        }

        public func getScreenshotCapture() throws -> ScreenshotCapture {
            guard let app = application else {
                throw GestureError.noApplication
            }

            return try runOnMainThread {
                let capture = DeviceRotation.capture { app.screenshot() }
                return ScreenshotCapture(data: capture.value.pngRepresentation, rotation: capture.rotation)
            }
        }

        // MARK: - Device Control

        public func setOrientation(_ orientation: String) throws {
            try runOnMainThread {
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
            return runOnMainThreadNonThrowing({
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
            runOnMainThreadNonThrowing({ DeviceRotation.current() }, fallback: nil)
        }

        // MARK: - Clipboard

        /// Shadow of the most recent value this runner wrote via `copy` (or
        /// cleared via `clear`). Used as a fallback for `get` and `paste`
        /// when iOS's privacy-gated pasteboard read on a UI-test runner
        /// hangs on a `Paste from <app>` system alert that no user is
        /// available to dismiss. Without this, `runOnMainThread`'s
        /// `DispatchQueue.main.sync` blocks indefinitely.
        private static var clipboardShadow: String?
        private static let clipboardShadowQueue = DispatchQueue(label: "com.automobile.ctrlproxy.clipboard-shadow")

        private static func readShadow() -> String? {
            clipboardShadowQueue.sync { clipboardShadow }
        }

        private static func writeShadow(_ value: String?) {
            clipboardShadowQueue.sync { clipboardShadow = value }
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

        private final class ClipboardReadBox {
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
                try runOnMainThread {
                    UIPasteboard.general.string = text
                }
                GesturePerformer.writeShadow(text)
                return nil

            case "clear":
                try runOnMainThread {
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
                // Use bounded read; fall back to shadow if iOS gates the read.
                let pasteboardLive = GesturePerformer.readPasteboardWithTimeout(.milliseconds(500))
                let clipboardText: String?
                switch pasteboardLive {
                case let .value(text):
                    clipboardText = text
                case .empty:
                    clipboardText = nil
                case .unavailable:
                    clipboardText = GesturePerformer.readShadow()
                }
                guard let pasteText = clipboardText, !pasteText.isEmpty else {
                    throw GestureError.clipboardEmpty
                }
                _ = pasteText

                try requireKeyboardFocus(app: app, context: "ensure a text field is focused before pasting")

                // Use Cmd+V for real paste — handles emoji, Unicode, and is a single operation
                try runOnMainThread {
                    app.typeKey("v", modifierFlags: .command)
                }

                // iOS 16+ may show "Allow Paste" system alert (label is English-only;
                // no reliable cross-locale alternative exists without button index)
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
            try runOnMainThread {
                let allowButton = self.springboard.buttons["Allow Paste"]
                // Quick existence check avoids full 0.5s wait when no alert is present
                if allowButton.exists || allowButton.waitForExistence(timeout: 0.3) {
                    allowButton.tap()
                }
            }
        }

        public func pressHome() throws {
            try runOnMainThread {
                XCUIDevice.shared.press(.home)
            }
        }

        public func shake() throws {
            try runOnMainThread {
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

            try runOnMainThread {
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
                    throw GestureError.notSupported("Volume buttons are unavailable on the iOS simulator: \(button)")
                #else
                    try runOnMainThread {
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
                #if targetEnvironment(simulator)
                    throw GestureError.notSupported("Power/lock button is unavailable on the iOS simulator")
                #else
                    try pressPowerViaHID()
                #endif
            case "menu":
                throw GestureError.notSupported("iOS has no menu hardware button")
            default:
                throw GestureError.notSupported("Button: \(button)")
            }
        }

        #if !targetEnvironment(simulator)
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
                -> IOHIDEventRef?
            private typealias IOHIDEventSystemClientCreateFn = @convention(c) (
                CFAllocator?
            )
                -> IOHIDEventSystemClientRef?
            private typealias IOHIDEventSystemClientDispatchEventFn = @convention(c) (
                IOHIDEventSystemClientRef,
                IOHIDEventRef
            )
                -> Void

            private func pressPowerViaHID() throws {
                guard let handle = openIOKitHandle() else {
                    throw GestureError.notSupported("Power/lock button HID support unavailable")
                }
                defer { dlclose(handle) }

                let createEventSymbol = dlsym(handle, "IOHIDEventCreateKeyboardEvent")
                let createClientSymbol = dlsym(handle, "IOHIDEventSystemClientCreate")
                let dispatchEventSymbol = dlsym(handle, "IOHIDEventSystemClientDispatchEvent")

                guard let createEventSymbol, let createClientSymbol, let dispatchEventSymbol else {
                    throw GestureError.notSupported("Power/lock button HID symbols unavailable")
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

                guard let client = createSystemClient(nil) else {
                    throw GestureError.notSupported("Power/lock button HID client unavailable")
                }
                defer { CFRelease(client) }

                let consumerUsagePage: UInt32 = 0x0C
                let powerUsage: UInt32 = 0x30
                let eventTimestamp: UInt64 = 0
                let eventOptions: UInt32 = 0

                guard let keyDown = createKeyboardEvent(
                    nil,
                    eventTimestamp,
                    consumerUsagePage,
                    powerUsage,
                    true,
                    eventOptions
                ) else {
                    throw GestureError.notSupported("Power/lock button HID key-down event unavailable")
                }
                defer { CFRelease(keyDown) }

                guard let keyUp = createKeyboardEvent(
                    nil,
                    eventTimestamp,
                    consumerUsagePage,
                    powerUsage,
                    false,
                    eventOptions
                ) else {
                    throw GestureError.notSupported("Power/lock button HID key-up event unavailable")
                }
                defer { CFRelease(keyUp) }

                dispatchEvent(client, keyDown)
                dispatchEvent(client, keyUp)
            }

            private func openIOKitHandle() -> UnsafeMutableRawPointer? {
                [
                    "/System/Library/Frameworks/IOKit.framework/IOKit",
                    "/System/Library/PrivateFrameworks/IOKit.framework/IOKit",
                ].lazy.compactMap { dlopen($0, RTLD_NOW) }.first
            }
        #endif

        public func openRecentApps() throws -> Bool {
            guard let app = resolveNavigationApp() else {
                throw GestureError.noApplication
            }

            try runOnMainThread {
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

            return isAppSwitcherVisible()
        }

        private func isAppSwitcherVisible() -> Bool {
            runOnMainThreadNonThrowing({
                let candidates = [
                    self.springboard.otherElements["AppSwitcher"],
                    self.springboard.otherElements["App Switcher"],
                    self.springboard.otherElements["AppSwitcherContentView"],
                    self.springboard.collectionViews["AppSwitcher"],
                    self.springboard.scrollViews["AppSwitcher"],
                ]

                for candidate in candidates where candidate.waitForExistence(timeout: 0.2) {
                    return true
                }

                let appSwitcherPredicate = NSPredicate(
                    format: "identifier CONTAINS[c] %@ OR label CONTAINS[c] %@",
                    "AppSwitcher",
                    "App Switcher"
                )
                return self.springboard.descendants(matching: .any)
                    .matching(appSwitcherPredicate)
                    .firstMatch
                    .waitForExistence(timeout: 0.5)
            }, fallback: false)
        }

        // MARK: - App Control

        public func launchApp(bundleId: String) throws {
            try runOnMainThread {
                let app = XCUIApplication(bundleIdentifier: bundleId)
                app.launch()
            }
        }

        public func terminateApp(bundleId: String) throws {
            try runOnMainThread {
                let app = XCUIApplication(bundleIdentifier: bundleId)
                app.terminate()
            }
        }

        public func activateApp(bundleId: String) throws {
            try runOnMainThread {
                let app = XCUIApplication(bundleIdentifier: bundleId)
                app.activate()
            }
        }

        public func updateApplication(bundleId: String) {
            runOnMainThreadNonThrowing({
                let app = XCUIApplication(bundleIdentifier: bundleId)
                self.ownedApplication = app
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
            try runOnMainThread {
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

        public init(elementLocator: ElementLocating) {
            self.elementLocator = elementLocator
        }

        public func tap(x _: Double, y _: Double, duration _: TimeInterval = 0) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func doubleTap(x _: Double, y _: Double) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func longPress(x _: Double, y _: Double, duration _: TimeInterval) throws {
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

        public func setText(resourceId _: String, text _: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func clearText(resourceId _: String?) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func selectAll() throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func performImeAction(_: String) throws {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func keyboard(action _: String) throws -> Bool {
            throw GestureError.notSupported("XCUITest only available on iOS")
        }

        public func performAction(_: String, resourceId _: String?, label _: String?) throws {
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
}
