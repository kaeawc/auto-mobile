import Foundation
#if canImport(XCTest) && os(iOS)
    import os
    import UIKit
    import XCTest
#endif

/// Locates elements via XCUITest and returns the Android-compatible hierarchy, applying
/// filtering similar to Android's `ViewHierarchyExtractor` to reduce hierarchy size.
///
/// Rewrite archetype — `@MainActor`. Everything here ultimately drives XCUITest on the main
/// thread. The reference hopped onto main per operation with `DispatchQueue.main.sync`
/// (`runOnMainThread`); isolating the whole class to the main actor makes each public method
/// run there without hops, and makes `getViewHierarchy`'s multi-step capture (app snapshot →
/// SpringBoard snapshot → screen metrics) a single main-actor transaction. That closes race
/// #1: the reference's non-atomic capture, where a mid-capture UI change could interleave
/// between the separate `main.sync` hops. The process-lifetime rotation epoch
/// (`DeviceRotation` / `RotationChangeMonitor`) is retained as defensive ABA-rotation
/// detection — a background orientation-notification queue can still advance it during a
/// capture — so its cross-phase agreement check is unchanged.
///
/// What the port drops (all reference-only concurrency scaffolding no longer needed inside a
/// single isolation domain): the lock-guarded `ThreadSafeCache` (the element cache is a plain
/// `[String: XCUIElement]`), the lock-guarded `ForegroundTracker` class (now a main-actor
/// `struct` value), the dead `LocatorError` enum, and the unused `getCachedElement`.
///
/// `catchingObjCException` replaces `runOnMainThread`: under `@MainActor` the thread-hop is
/// gone, but XCUITest can still raise `NSException`s that Swift `try`/`catch` cannot catch,
/// so the ObjC guard survives. Perf timing is injected as `any PerfTracking` and bracketed by
/// the private `tracked(_:_:)` helper (`serial` + `defer end()`), the rewrite's expression of
/// the reference `PerfProvider.track`.
@MainActor
public final class ElementLocator: ElementLocating, HierarchyExtracting {
    #if canImport(XCTest) && os(iOS)
        private let logger = Logger(subsystem: "dev.jasonpearson.automobile", category: "ElementLocator")

        private struct ScreenMetrics {
            let scale: Float
            let nativeScale: Double
            let fallbackWidth: Int
            let fallbackHeight: Int
            let rotation: Int?
        }

        // MARK: - Filtering Constants

        /// Maximum depth to traverse (prevent infinite recursion)
        static let maxDepth = 30

        /// Generic class names that are typically structural wrappers
        static let structuralClassNames: Set<String> = [
            "UIView",
            "UIImageView",
            "UIWindow",
        ]

        /// Element types whose internal UIKit subviews produce same-type nested children
        /// in the XCUITest accessibility tree. These are collapsed during hierarchy building
        /// to avoid exposing non-interactive internal subviews (e.g. _UITextFieldRoundedRectBackgroundViewNeue).
        static let textInputElementTypes: [XCUIElement.ElementType] = [
            .textField, // UITextField internal subviews
            .secureTextField, // Same internals as UITextField with isSecureTextEntry
            .textView, // TextKit 2 internal views (_UITextLayoutCanvasView)
            .searchField, // UISearchTextField inside UISearchBar (iOS 16+)
        ]

        /// Foreground-app tracking state (tracked app, bundle id, observed bundle ids,
        /// SpringBoard-fallback flag, last-switch time). A main-actor `struct` value — the
        /// reference's cross-thread lock is unnecessary inside a single isolation domain.
        var tracker = ForegroundTracker()
        var appSwitcherMayBeVisible = false
        private var gestureGeometryBundleId: String?
        private var gestureGeometry: GestureCoordinateGeometry?

        /// Reuse the last completed observation without XCUI reads on the legacy gesture path.
        var observedGestureGeometry: GestureCoordinateGeometry? {
            gestureGeometryBundleId == foregroundBundleId ? gestureGeometry : nil
        }

        /// Recent apps is SpringBoard UI even while its cards report their apps as foreground.
        func noteAppSwitcherOpened() {
            appSwitcherMayBeVisible = true
        }

        func clearAppSwitcherHint() {
            appSwitcherMayBeVisible = false
        }

        /// Bundle id of the app currently being observed.
        public var foregroundBundleId: String? { tracker.bundleId }

        public func refreshForegroundBundleId() -> String? {
            ensureForegroundApp()
            return tracker.bundleId
        }

        /// Springboard app for detecting foreground app - always kept
        lazy var springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

        static let spotlightBundleId = "com.apple.Spotlight"

        /// Cache of resource IDs to XCUIElements. A plain dictionary: main-actor confinement,
        /// not a lock, keeps it consistent (the reference's `ThreadSafeCache` guarded against
        /// concurrent server-queue/main-thread mutation, issue #3614, which cannot occur here).
        var elementCache: [String: XCUIElement] = [:]

        /// Injected performance tracking (Phase 6 wires the concrete provider).
        private let perf: any PerfTracking

        // `internal`, not `public`: this init injects the internal `PerfTracking` seam, so a
        // `public` init would expose an internal type (a first-time iOS-compile error the host
        // `#else` stub hid). `ElementLocator` is only ever constructed inside this module — the
        // shipped entry point is `CtrlProxy`, and the rewrite's cross-module tests use fakes —
        // so internal construction is sufficient. (The reference could declare this `public`
        // only because its `perfProvider` default was the now-dropped public `PerfProvider`
        // singleton; see STATUS §6.)
        init(
            application: XCUIApplication? = nil,
            perf: any PerfTracking
        ) {
            DeviceRotation.startMonitoring()
            tracker.setApplication(application, bundleId: nil, observe: false)
            self.perf = perf
        }

        /// Bracket a perf scope around `block` — the rewrite's expression of the reference
        /// `PerfProvider.track` (`serial` opens the scope, `end` closes it in `defer`).
        @discardableResult
        func tracked<T>(_ name: String, _ block: () throws -> T) rethrows -> T {
            perf.serial(name)
            defer { perf.end() }
            return try block()
        }

        /// `catchingObjCException` for protocol methods that cannot propagate errors: a caught
        /// `NSException` is logged and `fallback` returned. Under `@MainActor` the reference's
        /// `main.sync` thread-hop is gone (we already run on main); only the XCUITest
        /// `NSException` guard `runOnMainThreadNonThrowing` also provided remains necessary.
        func catchingObjCExceptionNonThrowing<T>(_ block: () -> T, fallback: T) -> T {
            do {
                return try catchingObjCException(block)
            } catch {
                print("[ElementLocator] ObjC exception in non-throwing context: \(error)")
                return fallback
            }
        }

        public func setApplication(_ app: XCUIApplication) {
            tracker.setApplication(app, bundleId: nil, observe: false)
            elementCache.removeAll()
            gestureGeometry = nil
        }

        public func trackObservedBundleId(_ bundleId: String) {
            guard bundleId != "com.apple.springboard" else { return }
            tracker.trackObserved(bundleId)
        }

        /// Set the application to observe with its bundle ID
        public func setApplication(_ app: XCUIApplication, bundleId: String) {
            tracker.setApplication(app, bundleId: bundleId, observe: bundleId != "com.apple.springboard")
            elementCache.removeAll()
            gestureGeometry = nil
        }

        /// Explicitly switch the tracked foreground app to the given bundle ID, clearing caches.
        /// Called by CommandHandler after state-changing operations (launch, terminate, home).
        public func switchForegroundApp(bundleId: String) {
            clearAppSwitcherHint()
            let isSpringboard = bundleId == "com.apple.springboard"
            let app: XCUIApplication = isSpringboard ? springboard : XCUIApplication(bundleIdentifier: bundleId)
            let previousBundleId = tracker.switchForeground(
                app: app,
                bundleId: bundleId,
                observe: !isSpringboard,
                now: DispatchTime.now().uptimeNanoseconds
            )
            elementCache.removeAll()
            if previousBundleId != bundleId {
                gestureGeometry = nil
                print("[ElementLocator] Foreground app changed: \(previousBundleId ?? "nil") -> \(bundleId)")
            }
        }

        public func getAppState(bundleId: String) -> ObservedAppState {
            let stateRaw: UInt = catchingObjCExceptionNonThrowing({
                XCUIApplication(bundleIdentifier: bundleId).state.rawValue
            }, fallback: 0)
            switch stateRaw {
            case 0: return .unknown
            case 1: return .notRunning
            case 2: return .runningBackgroundSuspended
            case 3: return .runningBackground
            default: return .runningForeground // rawValue >= 4
            }
        }

        public func awaitAppState(bundleId: String, expectedState: AppStateExpectation) -> Bool {
            for _ in 0 ..< 10 {
                let stateRaw: UInt = catchingObjCExceptionNonThrowing({
                    XCUIApplication(bundleIdentifier: bundleId).state.rawValue
                }, fallback: 0)
                let matched: Bool
                switch expectedState {
                case .foreground:
                    matched = stateRaw >= 4
                case .notRunning:
                    matched = stateRaw <= 1
                case .background:
                    matched = stateRaw == 3
                }
                if matched { return true }
                Thread.sleep(forTimeInterval: 0.05)
            }
            return false
        }

        /// Whether SpringBoard hosts a keyboard the app's own tree omits, using the same
        /// non-waiting `exists` query as `GesturePerformer.isKeyboardVisible`.
        private func springBoardKeyboardVisible() -> Bool {
            catchingObjCExceptionNonThrowing({
                springboard.keyboards.firstMatch.exists
            }, fallback: false)
        }

        // MARK: - View Hierarchy

        /// Detect a usable keyboard in the captured tree without additional IPC.
        private static func keyboardVisibleInSnapshot(_ snapshot: XCUIElementSnapshot) -> Bool {
            keyboardVisibleInSnapshot(
                snapshot,
                isKeyboard: { $0.elementType == .keyboard },
                frame: { $0.frame },
                children: { $0.children }
            )
        }

        public func getViewHierarchy(disableAllFiltering: Bool = false) throws -> ViewHierarchy {
            perf.serial("getViewHierarchy")
            defer { perf.end() }

            // First, ensure we're observing the foreground app
            tracked("ensureForegroundApp") {
                ensureForegroundApp()
            }

            elementCache.removeAll()
            gestureGeometry = nil

            // Use the observed app's bundle identifier for packageName
            let bundleId = foregroundBundleId ?? "com.apple.springboard"

            // Keep one monitor interval around every hierarchy-producing operation. The app and
            // SpringBoard snapshots can each be internally stable while an A→B→A transition
            // happens between them.
            let beforeHierarchyCapture = try catchingObjCException { DeviceRotation.captureSample() }

            // Use snapshot() for fast hierarchy extraction - single IPC call captures everything
            // snapshot() captures all element data in ONE IPC call (fast!)
            // vs accessing properties individually which is extremely slow
            // IMPORTANT: Create a FRESH XCUIApplication instance for each snapshot to avoid
            // stale accessibility cache. Cached instances may not reflect system-presented
            // alerts like permission dialogs.
            let (snapshot, typedTextInputSnapshots, keyboardFocus, screenMetrics) = try tracked("snapshot") {
                try catchingObjCException {
                    let capture = try DeviceRotation.capture {
                        let freshApp = XCUIApplication(bundleIdentifier: bundleId)
                        let snap = try freshApp.snapshot()
                        // Derive text-input candidates by walking the already-captured
                        // snapshot tree instead of issuing fresh live
                        // descendants(matching:).allElementsBoundByIndex + per-candidate
                        // snapshot() queries, each of which is a main-thread IPC round
                        // trip that re-serializes the app's accessibility tree (issue #5474).
                        let typedInputs = Self.collectTextInputSnapshots(from: snap)

                        // Prefer focus from the captured tree; keep the predicate fallback
                        // only when a captured keyboard is visible but no usable input reports focus.
                        let focus: KeyboardFocus?
                        switch Self.keyboardFocusDecision(
                            textInputCandidates: typedInputs.map { (frame: $0.frame, hasFocus: $0.hasFocus) },
                            keyboardVisibleInSnapshot: Self.keyboardVisibleInSnapshot(snap),
                            keyboardVisibleInSpringBoard: bundleId != "com.apple.springboard"
                                && self.springBoardKeyboardVisible()
                        ) {
                        case .skip:
                            focus = nil
                        case let .useSnapshotFrame(frame):
                            focus = KeyboardFocus(frame: frame, source: .snapshot)
                        case .liveQuery:
                            do {
                                focus = try catchingObjCException { () -> KeyboardFocus? in
                                    guard freshApp.state == .runningForeground else { return nil }
                                    let focused = freshApp.descendants(matching: .any)
                                        .matching(NSPredicate(format: "hasKeyboardFocus == true"))
                                        .firstMatch
                                    // A missing firstMatch snapshot can wait for ~60 s after backgrounding.
                                    guard focused.exists else { return nil }
                                    // Resolve the frame once after the no-wait existence check.
                                    return try KeyboardFocus(frame: focused.snapshot().frame, source: .liveQuery)
                                }
                            } catch {
                                // Missing focus safely falls back to snapshot.hasFocus when building the hierarchy.
                                logger.debug("Keyboard focus snapshot unavailable: \(error)")
                                focus = nil
                            }
                        }
                        return (snap, typedInputs, focus, UIScreen.main.bounds)
                    }

                    return (
                        capture.value.0,
                        capture.value.1,
                        capture.value.2,
                        ScreenMetrics(
                            scale: Float(UIScreen.main.scale),
                            nativeScale: Double(UIScreen.main.nativeScale),
                            fallbackWidth: ElementBounds.clampedInt(capture.value.3.width),
                            fallbackHeight: ElementBounds.clampedInt(capture.value.3.height),
                            rotation: capture.rotation
                        )
                    )
                }
            }

            // Get screen bounds for offscreen filtering
            let screenBounds = snapshot.frame

            // Build hierarchy from snapshot (no more IPC calls - all data is local)
            var truncationReasons: Set<String> = []
            let rawElement = tracked("buildHierarchy") {
                buildElementInfoFromSnapshot(
                    snapshot,
                    depth: 0,
                    screenBounds: screenBounds,
                    truncationReasons: &truncationReasons,
                    keyboardFocus: keyboardFocus,
                    disableAllFiltering: disableAllFiltering
                )
            }

            let hierarchyWithTypedTextInputs = tracked("mergeTypedTextInputs") {
                let candidates = typedTextInputSnapshots.enumerated().map { index, textInputSnapshot in
                    buildElementInfoFromSnapshot(
                        textInputSnapshot,
                        depth: 1,
                        screenBounds: screenBounds,
                        truncationReasons: &truncationReasons,
                        parentPath: "typed-text-input",
                        childIndex: index,
                        keyboardFocus: keyboardFocus,
                        disableAllFiltering: disableAllFiltering
                    )
                }
                return ElementLocator.mergeMissingTextInputCandidates(
                    into: rawElement,
                    candidates: candidates
                )
            }

            // Apply optimization - flatten structural wrappers and filter empty nodes
            // Skip optimization when disableAllFiltering is true (for raw hierarchy debugging)
            let rootElement: UIElementInfo
            if disableAllFiltering {
                rootElement = hierarchyWithTypedTextInputs
            } else {
                rootElement = tracked("optimize") {
                    let optimizedElements = optimizeHierarchy(hierarchyWithTypedTextInputs, isRoot: true)
                    return optimizedElements.first ?? hierarchyWithTypedTextInputs
                }
            }

            // Get window info from snapshot
            let frame = snapshot.frame
            let windowInfo = WindowInfo(
                id: 0,
                type: 1, // Application window
                isActive: true,
                isFocused: true,
                bounds: ElementBounds(clamping: frame)
            )

            // Check for system alerts from multiple sources:
            // 1. Alerts in the app's own snapshot tree (permission dialogs presented within the app)
            // 2. Alerts in SpringBoard's tree (system dialogs managed by SpringBoard)
            // System permission dialogs may appear in either location depending on iOS version.
            let systemAlertCapture = try tracked("systemAlerts") {
                try getSystemAlerts(
                    appSnapshot: snapshot,
                    truncationReasons: &truncationReasons,
                    keyboardFocus: keyboardFocus
                )
            }

            // If there are system alerts, include them in the hierarchy
            let finalHierarchy: UIElementInfo
            if !systemAlertCapture.alerts.isEmpty {
                // Create a wrapper that contains both the app hierarchy and alerts
                var children = rootElement.node ?? []
                children.append(contentsOf: systemAlertCapture.alerts)
                finalHierarchy = UIElementInfo(
                    text: rootElement.text,
                    resourceId: rootElement.resourceId,
                    className: rootElement.className,
                    bounds: rootElement.bounds,
                    clickable: rootElement.clickable,
                    focused: rootElement.focused,
                    scrollable: rootElement.scrollable,
                    selected: rootElement.selected,
                    role: rootElement.role,
                    node: children
                )
            } else {
                finalHierarchy = rootElement
            }

            // Get screen scale and dimensions for coordinate conversion
            // iOS reports bounds in points, but screenshots are in pixels
            // screenScale converts: pixels = points * screenScale
            //
            // The runner's UIScreen.main.bounds can be a stale 320x480 compatibility
            // value (issue #2683), so prefer the foreground app's root frame and only
            // fall back to UIScreen.main.bounds.
            // nativeScale (not scale) is what converts point bounds to screenshot pixels:
            // Display Zoom changes nativeScale while scale stays put, and
            // XCUIScreenshot.pngRepresentation renders at native scale (#4548). screenScale
            // (UIScreen.scale) is still reported unchanged for backward compatibility.
            let (currentScreenMetrics, afterHierarchyCapture): (ScreenMetrics, RotationCaptureSample) =
                try catchingObjCException {
                    let scale = Float(UIScreen.main.scale)
                    let nativeScale = Double(UIScreen.main.nativeScale)
                    let bounds = UIScreen.main.bounds
                    let captureSample = DeviceRotation.captureSample()
                    return (
                        ScreenMetrics(
                            scale: scale,
                            nativeScale: nativeScale,
                            fallbackWidth: ElementBounds.clampedInt(bounds.width),
                            fallbackHeight: ElementBounds.clampedInt(bounds.height),
                            rotation: captureSample.rotation
                        ),
                        captureSample
                    )
                }
            // SpringBoard contributes alert bounds through a second XCUI snapshot. Require each
            // capture's rotation and the process-lifetime epoch to agree across the complete
            // hierarchy assembly.
            let hierarchyRotation: Int?
            if screenMetrics.rotation == systemAlertCapture.rotation,
               screenMetrics.rotation == currentScreenMetrics.rotation,
               screenMetrics.rotation == RotationCaptureSample.stableRotation(
                   between: beforeHierarchyCapture,
                   and: afterHierarchyCapture
               )
            {
                hierarchyRotation = screenMetrics.rotation
            } else {
                hierarchyRotation = nil
            }
            let (screenWidth, screenHeight) = ElementLocator.resolveScreenDimensions(
                rootBounds: finalHierarchy.bounds,
                fallbackWidth: currentScreenMetrics.fallbackWidth,
                fallbackHeight: currentScreenMetrics.fallbackHeight,
                elements: finalHierarchy.node ?? []
            )
            let pixelDimensions = ElementLocator.computePixelDimensions(
                pointWidth: screenWidth,
                pointHeight: screenHeight,
                nativeScale: currentScreenMetrics.nativeScale
            )

            let observationSize = GestureSize(width: Double(screenWidth), height: Double(screenHeight))
            gestureGeometry = GestureCoordinateGeometry(
                app: GestureSize(width: Double(snapshot.frame.width), height: Double(snapshot.frame.height)),
                screen: GestureSize(
                    width: Double(currentScreenMetrics.fallbackWidth),
                    height: Double(currentScreenMetrics.fallbackHeight)
                ),
                observation: observationSize,
                rotation: GestureCoordinateGeometry.observationRotation(hierarchyRotation, size: observationSize)
            )
            gestureGeometryBundleId = bundleId

            return ViewHierarchy(
                packageName: bundleId,
                hierarchy: finalHierarchy,
                windowInfo: windowInfo,
                windows: [windowInfo],
                screenScale: currentScreenMetrics.scale,
                screenWidth: screenWidth,
                screenHeight: screenHeight,
                nativeScale: pixelDimensions == nil ? nil : currentScreenMetrics.nativeScale,
                pixelWidth: pixelDimensions?.pixelWidth,
                pixelHeight: pixelDimensions?.pixelHeight,
                rotation: hierarchyRotation,
                fallbackToSpringboard: tracker.didFallbackToSpringboard ? true : nil,
                truncationReasons: truncationReasons.sorted()
            )
        }

    #else
        /// Non-iOS stub implementation
        public init() {}

        var observedGestureGeometry: GestureCoordinateGeometry? { nil }

        func noteAppSwitcherOpened() {}
        func clearAppSwitcherHint() {}

        public func getViewHierarchy(disableAllFiltering _: Bool = false) throws -> ViewHierarchy {
            return ViewHierarchy(
                packageName: nil,
                hierarchy: nil,
                windowInfo: nil,
                windows: nil,
                error: "XCUITest only available on iOS"
            )
        }

        public func findElement(byResourceId _: String) -> Any? {
            return nil
        }

        public func findElement(byText _: String) -> Any? {
            return nil
        }

        public func findElement(byText _: String, bounds _: ElementBounds) -> Any? {
            return nil
        }

        public func trackObservedBundleId(_: String) {
            // no-op on non-iOS
        }

        public func switchForegroundApp(bundleId _: String) {
            // no-op on non-iOS
        }

        public func getAppState(bundleId _: String) -> ObservedAppState {
            return .unknown
        }

        public func awaitAppState(bundleId _: String, expectedState _: AppStateExpectation) -> Bool {
            return true
        }

        public var foregroundBundleId: String? { nil }
        public func refreshForegroundBundleId() -> String? { nil }
    #endif
}
