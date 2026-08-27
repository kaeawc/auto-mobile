import CryptoKit
import Foundation
#if canImport(XCTest) && os(iOS)
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
        private struct ScreenMetrics {
            let scale: Float
            let nativeScale: Double
            let fallbackWidth: Int
            let fallbackHeight: Int
            let rotation: Int?
        }

        // MARK: - Filtering Constants

        /// Maximum depth to traverse (prevent infinite recursion)
        private static let maxDepth = 30

        /// Generic class names that are typically structural wrappers
        private static let structuralClassNames: Set<String> = [
            "UIView",
            "UIImageView",
            "UIWindow",
        ]

        /// Element types whose internal UIKit subviews produce same-type nested children
        /// in the XCUITest accessibility tree. These are collapsed during hierarchy building
        /// to avoid exposing non-interactive internal subviews (e.g. _UITextFieldRoundedRectBackgroundViewNeue).
        private static let textInputElementTypes: [XCUIElement.ElementType] = [
            .textField,        // UITextField internal subviews
            .secureTextField,  // Same internals as UITextField with isSecureTextEntry
            .textView,         // TextKit 2 internal views (_UITextLayoutCanvasView)
            .searchField,      // UISearchTextField inside UISearchBar (iOS 16+)
        ]

        /// Foreground-app tracking state (tracked app, bundle id, observed bundle ids,
        /// SpringBoard-fallback flag, last-switch time). A main-actor `struct` value — the
        /// reference's cross-thread lock is unnecessary inside a single isolation domain.
        private var tracker = ForegroundTracker()

        /// Bundle id of the app currently being observed.
        public var foregroundBundleId: String? { tracker.bundleId }

        /// Springboard app for detecting foreground app - always kept
        private lazy var springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

        /// Cache of resource IDs to XCUIElements. A plain dictionary: main-actor confinement,
        /// not a lock, keeps it consistent (the reference's `ThreadSafeCache` guarded against
        /// concurrent server-queue/main-thread mutation, issue #3614, which cannot occur here).
        private var elementCache: [String: XCUIElement] = [:]

        /// Injected performance tracking (Phase 6 wires the concrete provider).
        private let perf: any PerfTracking

        public init(
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
        private func tracked<T>(_ name: String, _ block: () throws -> T) rethrows -> T {
            perf.serial(name)
            defer { perf.end() }
            return try block()
        }

        /// `catchingObjCException` for protocol methods that cannot propagate errors: a caught
        /// `NSException` is logged and `fallback` returned. Under `@MainActor` the reference's
        /// `main.sync` thread-hop is gone (we already run on main); only the XCUITest
        /// `NSException` guard `runOnMainThreadNonThrowing` also provided remains necessary.
        private func catchingObjCExceptionNonThrowing<T>(_ block: () -> T, fallback: T) -> T {
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
        }

        public func trackObservedBundleId(_ bundleId: String) {
            guard bundleId != "com.apple.springboard" else { return }
            tracker.trackObserved(bundleId)
        }

        /// Set the application to observe with its bundle ID
        public func setApplication(_ app: XCUIApplication, bundleId: String) {
            tracker.setApplication(app, bundleId: bundleId, observe: bundleId != "com.apple.springboard")
            elementCache.removeAll()
        }

        /// Explicitly switch the tracked foreground app to the given bundle ID, clearing caches.
        /// Called by CommandHandler after state-changing operations (launch, terminate, home).
        public func switchForegroundApp(bundleId: String) {
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
            default: return .runningForeground  // rawValue >= 4
            }
        }

        public func awaitAppState(bundleId: String, expectedState: AppStateExpectation) -> Bool {
            for _ in 0..<10 {
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

        /// Safety-net detection: re-detect the foreground app if the current tracking seems stale.
        /// With explicit transitions via switchForegroundApp, this should rarely fire.
        private func ensureForegroundApp() {
            // If we recently did an explicit switch, trust it — the caller already set the right app
            let nsSinceSwitch = DispatchTime.now().uptimeNanoseconds - tracker.lastSwitchTime
            let msSinceSwitch = nsSinceSwitch / 1_000_000
            if msSinceSwitch < 200 {
                return
            }

            // Snapshot the tracked bundle id once.
            let trackedBundleId = tracker.bundleId

            // IMPORTANT: Create fresh XCUIApplication instances to check state, because
            // cached instances may return stale state values
            let stateInfo: (springboardState: UInt, currentAppState: UInt?, currentBundleId: String?) =
                tracked("checkState") {
                    catchingObjCExceptionNonThrowing({
                        let sbState = self.springboard.state.rawValue
                        let freshAppState: UInt? = trackedBundleId.map { bundleId in
                            XCUIApplication(bundleIdentifier: bundleId).state.rawValue
                        }
                        return (sbState, freshAppState, trackedBundleId)
                    }, fallback: (0, nil, trackedBundleId))
                }

            let isCurrentAppInForeground = (stateInfo.currentAppState ?? 0) >=
                4 // .runningForeground only (3 = .runningBackground)
            let isCurrentAppSpringboard = stateInfo.currentBundleId == "com.apple.springboard"

            // Springboard reports as foreground even when another app is on top,
            // so we always re-detect unless a non-springboard app is confirmed foreground
            if isCurrentAppInForeground && !isCurrentAppSpringboard {
                tracker.didFallbackToSpringboard = false
                return
            }

            if let detectedBundleId = tracked("detectForeground", { detectForegroundAppBundleId() }) {
                if detectedBundleId != tracker.bundleId {
                    switchForegroundApp(bundleId: detectedBundleId)
                }
                tracker.didFallbackToSpringboard = false
            } else if !isCurrentAppInForeground {
                if tracker.bundleId != "com.apple.springboard" {
                    switchForegroundApp(bundleId: "com.apple.springboard")
                    tracker.didFallbackToSpringboard = true
                }
            }
        }

        /// Get the current application to observe
        /// Returns foreground app if available and in foreground, otherwise springboard
        private var currentApplication: XCUIApplication {
            let appObject = tracker.app
            let trackedBundleId = tracker.bundleId
            let trackedApp = appObject as? XCUIApplication
            // Check state on main thread using fresh instance (cached instances return stale state)
            let freshState: UInt? = catchingObjCExceptionNonThrowing({
                trackedBundleId.map { bundleId in
                    XCUIApplication(bundleIdentifier: bundleId).state.rawValue
                }
            }, fallback: nil)
            let foregroundAppInForeground = (freshState ?? 0) >= 4 // .runningForeground only
            if let app = trackedApp, foregroundAppInForeground {
                return app
            }
            return springboard
        }

        /// Common system apps to check when detecting foreground app
        /// These are apps that might be launched by the user during testing
        private static let commonSystemApps: [String] = [
            "com.apple.Preferences", // Settings
            "com.apple.mobilesafari", // Safari
            "com.apple.MobileAddressBook", // Contacts
            "com.apple.mobilephone", // Phone
            "com.apple.MobileSMS", // Messages
            "com.apple.mobileslideshow", // Photos
            "com.apple.camera", // Camera
            "com.apple.AppStore", // App Store
            "com.apple.Maps", // Maps
            "com.apple.Health", // Health
            "com.apple.Fitness", // Fitness
            "com.apple.weather", // Weather
            "com.apple.mobilenotes", // Notes
            "com.apple.reminders", // Reminders
            "com.apple.mobilecal", // Calendar
            "com.apple.mobilemail", // Mail
            "com.apple.Music", // Music
            "com.apple.Podcasts", // Podcasts
            "com.apple.TV", // TV
            "com.apple.news", // News
            "com.apple.stocks", // Stocks
            "com.apple.tips", // Tips
            "com.apple.iBooks", // Books
            "com.apple.DocumentsApp", // Files
            "com.apple.calculator", // Calculator
            "com.apple.VoiceMemos", // Voice Memos
            "com.apple.compass", // Compass
            "com.apple.measure", // Measure
            "com.apple.facetime", // FaceTime
            "com.apple.Home", // Home
            "com.apple.shortcuts", // Shortcuts
            "com.apple.Translate", // Translate
            "com.apple.Magnifier", // Magnifier
            "com.apple.clock", // Clock
            "com.apple.findmy", // Find My
            "com.apple.Passbook", // Wallet
            "dev.jasonpearson.automobile.Playground", // AutoMobile Playground app
        ]

        /// Detect the bundle ID of the foreground app
        /// Returns nil if detection fails or springboard is in front
        private func detectForegroundAppBundleId() -> String? {
            // Snapshot the foreground/observed state once so the loops iterate a stable copy.
            let currentBundleId = tracker.bundleId
            let observedBundleIds = tracker.observedBundleIds

            // First, try to find bundle IDs from springboard's element tree
            // This can work when apps embed their bundle ID in element identifiers
            let snapshot: XCUIElementSnapshot? = tracked("springboardSnapshot") {
                catchingObjCExceptionNonThrowing({
                    try? self.springboard.snapshot()
                }, fallback: nil)
            }

            if let snapshot = snapshot {
                let result: String? = tracked("checkCandidates") {
                    var candidateBundleIds: [String] = []
                    collectBundleIdsFromElement(snapshot, into: &candidateBundleIds)

                    for bundleId in candidateBundleIds {
                        if bundleId == "com.apple.springboard" {
                            continue
                        }

                        let stateRawValue: UInt = catchingObjCExceptionNonThrowing({
                            let testApp = XCUIApplication(bundleIdentifier: bundleId)
                            return testApp.state.rawValue
                        }, fallback: 0)
                        if stateRawValue >= 4 { // .runningForeground only
                            return bundleId
                        }
                    }
                    return nil
                }
                if let foundBundleId = result {
                    return foundBundleId
                }
            } else {
                print("[ElementLocator] Failed to snapshot springboard while detecting foreground app")
            }

            // Fallback: Check observed bundle IDs first (apps we've seen before)
            let observedResult: String? = tracked("checkObserved") {
                for bundleId in observedBundleIds {
                    // Skip current app (we already know it's not in foreground)
                    if bundleId == currentBundleId {
                        continue
                    }

                    let stateRawValue: UInt = catchingObjCExceptionNonThrowing({
                        let testApp = XCUIApplication(bundleIdentifier: bundleId)
                        return testApp.state.rawValue
                    }, fallback: 0)
                    if stateRawValue >= 4 { // .runningForeground only
                        return bundleId
                    }
                }
                return nil
            }
            if let found = observedResult {
                return found
            }

            // Fallback: Check common system apps directly
            // This is necessary because when another app is in foreground,
            // springboard's element tree may not contain that app's bundle ID.
            //
            // This is the last-resort path: the SpringBoard card tree and the
            // observed bundle ids above are the primary candidates. Walking all
            // ~40 static ids is ~40 sequential state IPCs on the app's main
            // thread, so a recent miss is cached briefly to avoid repeating the
            // full fan-out on every extraction (issue #5474).
            return tracked("checkSystemApps") {
                let now = DispatchTime.now().uptimeNanoseconds
                guard Self.shouldRunSystemAppSweep(
                    now: now,
                    lastMissTime: tracker.lastSystemAppSweepMiss,
                    ttlNanos: Self.systemAppSweepMissTtlNanos
                ) else {
                    return nil
                }

                for bundleId in Self.commonSystemApps {
                    // Skip current app (we already know it's not in foreground)
                    if bundleId == currentBundleId {
                        continue
                    }
                    // Skip already checked in observedBundleIds
                    if observedBundleIds.contains(bundleId) {
                        continue
                    }

                    let stateRawValue: UInt = catchingObjCExceptionNonThrowing({
                        let testApp = XCUIApplication(bundleIdentifier: bundleId)
                        return testApp.state.rawValue
                    }, fallback: 0)
                    if stateRawValue >= 4 { // .runningForeground only
                        return bundleId
                    }
                }
                // No foreground system app found — cache this negative result so
                // the next extraction within the TTL skips the full sweep.
                tracker.lastSystemAppSweepMiss = now
                return nil
            }
        }

        /// TTL for the `checkSystemApps` negative-result cache (issue #5474).
        /// The hierarchy debouncer runs regularly, so bounding the miss path to at
        /// most one full sweep per second dampens the ~40-IPC fan-out without
        /// meaningfully delaying detection of a genuine foreground change (which
        /// also resets the cache via `switchForegroundApp`).
        private static let systemAppSweepMissTtlNanos: UInt64 = 1_000_000_000

        /// Collect all potential bundle IDs from springboard element tree
        private func collectBundleIdsFromElement(
            _ element: XCUIElementSnapshot,
            into bundleIds: inout [String],
            depth: Int = 0
        ) {
            let identifier = element.identifier

            // Springboard elements use "card:<bundleId>:sceneID:<sceneId>" format
            // e.g., "card:com.tinyspeck.chatlyio:sceneID:com.tinyspeck.chatlyio-default"
            // Also seen: "@card:<bundleId>:sceneID:..." and suffixes like "-window", "-sceneID"
            if !identifier.isEmpty {
                var cleanId = identifier

                // Handle @card:*:sceneID:* and card:*:sceneID:* formats
                if identifier.hasPrefix("@card:") {
                    cleanId = String(identifier.dropFirst(6)) // Remove "@card:"
                    if let colonIndex = cleanId.firstIndex(of: ":") {
                        cleanId = String(cleanId[..<colonIndex])
                    }
                } else if identifier.hasPrefix("card:") {
                    cleanId = String(identifier.dropFirst(5)) // Remove "card:"
                    if let colonIndex = cleanId.firstIndex(of: ":") {
                        cleanId = String(cleanId[..<colonIndex])
                    }
                }

                // Clean up common suffixes
                cleanId = cleanId.replacingOccurrences(of: "-window", with: "")
                    .replacingOccurrences(of: "-sceneID", with: "")
                    .replacingOccurrences(of: "-SceneWindow", with: "")

                // Check if it looks like a bundle ID
                if cleanId.contains(".") && !cleanId.contains(" ") {
                    if cleanId.hasPrefix("com.") || cleanId.hasPrefix("io.") || cleanId.hasPrefix("org.") ||
                        cleanId.hasPrefix("net.") || cleanId.hasPrefix("me.") || cleanId.hasPrefix("dev.")
                    {
                        if !bundleIds.contains(cleanId) {
                            bundleIds.append(cleanId)
                        }
                    }
                }
            }

            // Recursively check children
            for child in element.children {
                collectBundleIdsFromElement(child, into: &bundleIds, depth: depth + 1)
            }
        }

        // MARK: - View Hierarchy

        public func getViewHierarchy(disableAllFiltering: Bool = false) throws -> ViewHierarchy {
            perf.serial("getViewHierarchy")
            defer { perf.end() }

            // First, ensure we're observing the foreground app
            tracked("ensureForegroundApp") {
                ensureForegroundApp()
            }

            elementCache.removeAll()

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
            let (snapshot, typedTextInputSnapshots, keyboardFocusFrame, screenMetrics) = try tracked("snapshot") {
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

                        // Query keyboard focus via predicate — snapshot.hasFocus reflects
                        // UIKit focus (tvOS/iPad), not keyboard input focus on iPhone.
                        // The focus frame is only ever applied to text-input nodes, so skip
                        // the live requery entirely when the snapshot exposes no text field
                        // (no keyboard can be focused without one) (issue #5474).
                        let focusFrame: CGRect?
                        if Self.shouldQueryKeyboardFocus(textInputSnapshotCount: typedInputs.count) {
                            let focused = freshApp.descendants(matching: .any)
                                .matching(NSPredicate(format: "hasKeyboardFocus == true"))
                                .firstMatch
                            focusFrame = focused.exists ? focused.frame : nil
                        } else {
                            focusFrame = nil
                        }
                        return (snap, typedInputs, focusFrame, UIScreen.main.bounds)
                    }

                    return (
                        capture.value.0,
                        capture.value.1,
                        capture.value.2,
                        ScreenMetrics(
                            scale: Float(UIScreen.main.scale),
                            nativeScale: Double(UIScreen.main.nativeScale),
                            fallbackWidth: Int(capture.value.3.width),
                            fallbackHeight: Int(capture.value.3.height),
                            rotation: capture.rotation
                        )
                    )
                }
            }

            // Get screen bounds for offscreen filtering
            let screenBounds = snapshot.frame

            // Build hierarchy from snapshot (no more IPC calls - all data is local)
            let rawElement = tracked("buildHierarchy") {
                buildElementInfoFromSnapshot(
                    snapshot,
                    depth: 0,
                    screenBounds: screenBounds,
                    keyboardFocusFrame: keyboardFocusFrame,
                    disableAllFiltering: disableAllFiltering
                )
            }

            let hierarchyWithTypedTextInputs = tracked("mergeTypedTextInputs") {
                let candidates = typedTextInputSnapshots.enumerated().map { index, textInputSnapshot in
                    buildElementInfoFromSnapshot(
                        textInputSnapshot,
                        depth: 1,
                        screenBounds: screenBounds,
                        parentPath: "typed-text-input",
                        childIndex: index,
                        keyboardFocusFrame: keyboardFocusFrame,
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
                bounds: ElementBounds(
                    left: Int(frame.origin.x),
                    top: Int(frame.origin.y),
                    right: Int(frame.origin.x + frame.width),
                    bottom: Int(frame.origin.y + frame.height)
                )
            )

            // Check for system alerts from multiple sources:
            // 1. Alerts in the app's own snapshot tree (permission dialogs presented within the app)
            // 2. Alerts in SpringBoard's tree (system dialogs managed by SpringBoard)
            // System permission dialogs may appear in either location depending on iOS version.
            let systemAlertCapture = try tracked("systemAlerts") {
                try getSystemAlerts(appSnapshot: snapshot, keyboardFocusFrame: keyboardFocusFrame)
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
                            fallbackWidth: Int(bounds.width),
                            fallbackHeight: Int(bounds.height),
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
                fallbackHeight: currentScreenMetrics.fallbackHeight
            )
            let pixelDimensions = ElementLocator.computePixelDimensions(
                pointWidth: screenWidth,
                pointHeight: screenHeight,
                nativeScale: currentScreenMetrics.nativeScale
            )

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
                fallbackToSpringboard: tracker.didFallbackToSpringboard ? true : nil
            )
        }

        /// Collect text-input element snapshots by walking the already-captured
        /// application snapshot tree (issue #5474).
        ///
        /// This replaces the previous live-query approach
        /// (`descendants(matching:).allElementsBoundByIndex` + per-candidate
        /// `snapshot()`), which forced the app to re-serialize its accessibility
        /// tree over IPC once per element type plus once per candidate. Because the
        /// root snapshot is already in hand, the same text-input nodes are read
        /// locally with no further IPC. Zero-area nodes are skipped to mirror the
        /// old `!frame.isEmpty` visibility filter.
        private static func collectTextInputSnapshots(from snapshot: XCUIElementSnapshot) -> [XCUIElementSnapshot] {
            var snapshots: [XCUIElementSnapshot] = []
            collectTextInputSnapshots(from: snapshot, into: &snapshots)
            return snapshots
        }

        private static func collectTextInputSnapshots(
            from snapshot: XCUIElementSnapshot,
            into snapshots: inout [XCUIElementSnapshot]
        ) {
            if textInputElementTypes.contains(snapshot.elementType), !snapshot.frame.isEmpty {
                snapshots.append(snapshot)
            }
            for child in snapshot.children {
                collectTextInputSnapshots(from: child, into: &snapshots)
            }
        }

        /// Get system alerts from the app snapshot and springboard.
        /// Checks two sources because system permission dialogs may appear in either:
        /// 1. The foreground app's accessibility tree (common on modern iOS)
        /// 2. SpringBoard's accessibility tree (for some system-level dialogs)
        /// Alert elements are extracted separately from the main hierarchy tree to ensure
        /// they are always visible as top-level children and never lost to optimization.
        /// Deduplicates by alert label text to avoid showing the same alert twice.
        private func getSystemAlerts(
            appSnapshot: XCUIElementSnapshot,
            keyboardFocusFrame: CGRect? = nil
        ) throws -> (alerts: [UIElementInfo], rotation: Int?) {
            // Check for alerts in the app's own snapshot tree
            let appAlertSnapshots = collectAlertElements(from: appSnapshot)
            let appAlerts = appAlertSnapshots.map { snapshot in
                buildElementInfoFromSnapshot(snapshot, depth: 0, screenBounds: snapshot.frame, keyboardFocusFrame: keyboardFocusFrame)
            }

            // Also check SpringBoard for alerts not in the app's tree — but only pay
            // for the second full-tree serialization when an alert may actually exist.
            // When the foreground app IS SpringBoard, `appSnapshot` already is
            // SpringBoard's tree, so its alerts were collected above without a second
            // snapshot (issue #5474).
            let foregroundIsSpringboard = (foregroundBundleId ?? "com.apple.springboard") == "com.apple.springboard"
            let runSpringboardSnapshot = Self.shouldSnapshotSpringboardForAlerts(
                foregroundIsSpringboard: foregroundIsSpringboard,
                appHasAlert: !appAlertSnapshots.isEmpty
            )
            let springboardCapture = try getAlertsFromSpringboard(
                runSnapshot: runSpringboardSnapshot,
                keyboardFocusFrame: keyboardFocusFrame
            )

            // Deduplicate by alert label text
            var seenLabels: Set<String> = []
            var combined: [UIElementInfo] = []

            for alert in appAlerts {
                let label = alert.text ?? ""
                if !seenLabels.contains(label) {
                    seenLabels.insert(label)
                    combined.append(alert)
                }
            }

            for alert in springboardCapture.alerts {
                let label = alert.text ?? ""
                if !seenLabels.contains(label) {
                    seenLabels.insert(label)
                    combined.append(alert)
                }
            }

            if !combined.isEmpty {
                print(
                    "[ElementLocator] Found \(combined.count) system alert(s): appAlerts=\(appAlerts.count), springboardAlerts=\(springboardCapture.alerts.count)"
                )
            }

            return (combined, springboardCapture.rotation)
        }

        /// Get alerts from a fresh springboard snapshot.
        /// Uses single snapshot() + tree traversal instead of .alerts query which can hang
        /// indefinitely on system permission dialogs, blocking the main thread.
        /// IMPORTANT: Creates a new XCUIApplication each call to avoid stale cached state.
        ///
        /// When `runSnapshot` is false the expensive `springboard.snapshot()` IPC is
        /// skipped and no alerts are returned, but the (cheap, local) rotation sample
        /// is still captured so the caller's rotation-agreement check is unaffected
        /// (issue #5474).
        private func getAlertsFromSpringboard(
            runSnapshot: Bool,
            keyboardFocusFrame: CGRect? = nil
        ) throws -> (alerts: [UIElementInfo], rotation: Int?) {
            let capture: (alertSnapshots: [XCUIElementSnapshot], rotation: Int?) =
                try catchingObjCException {
                    let capture = DeviceRotation.capture { () -> [XCUIElementSnapshot] in
                        guard runSnapshot else {
                            return []
                        }
                        let freshSpringboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
                        guard let snapshot = try? freshSpringboard.snapshot() else {
                            return []
                        }
                        return self.collectAlertElements(from: snapshot)
                    }
                    return (alertSnapshots: capture.value, rotation: capture.rotation)
                }

            let alerts = capture.alertSnapshots.map { snapshot in
                buildElementInfoFromSnapshot(
                    snapshot,
                    depth: 0,
                    screenBounds: snapshot.frame,
                    keyboardFocusFrame: keyboardFocusFrame
                )
            }
            return (alerts, capture.rotation)
        }

        /// Recursively collect alert-type element snapshots from a snapshot tree.
        /// Used instead of .alerts query which can hang on system permission dialogs.
        private func collectAlertElements(from snapshot: XCUIElementSnapshot) -> [XCUIElementSnapshot] {
            if snapshot.elementType == .alert {
                // Found an alert - return it without recursing into children
                // (buildElementInfoFromSnapshot will handle the alert's children)
                return [snapshot]
            }
            var alerts: [XCUIElementSnapshot] = []
            for child in snapshot.children {
                alerts.append(contentsOf: collectAlertElements(from: child))
            }
            return alerts
        }

        /// Build element info from XCUIElementSnapshot - all data is already captured, no IPC calls
        /// Applies early filtering: offscreen elements, zero-area elements
        /// Only sets boolean fields when true (nil = false) to reduce JSON size
        private func buildElementInfoFromSnapshot(
            _ snapshot: XCUIElementSnapshot,
            depth: Int,
            screenBounds: CGRect,
            parentPath: String = "",
            childIndex: Int = 0,
            keyboardFocusFrame: CGRect? = nil,
            disableAllFiltering: Bool = false
        )
            -> UIElementInfo
        {
            let frame = snapshot.frame

            // Skip zero-area elements
            let hasZeroArea = frame.width <= 0 || frame.height <= 0

            let bounds = ElementBounds(
                left: Int(frame.origin.x),
                top: Int(frame.origin.y),
                right: Int(frame.origin.x + frame.width),
                bottom: Int(frame.origin.y + frame.height)
            )

            // Get identifier
            let identifier = snapshot.identifier

            // Build deterministic path for viewId generation
            let resId = identifier.isEmpty ? nil : identifier
            let segment: String
            if let rid = resId {
                segment = "\(childIndex):\(rid)"
            } else {
                segment = "\(childIndex)"
            }
            let currentPath = parentPath.isEmpty ? segment : "\(parentPath)/\(segment)"
            let viewId = resId ?? generateDeterministicUuid(from: currentPath)

            // Get children from snapshot (already captured - fast!)
            // Filter out offscreen and zero-area children
            // Alert-type elements are SKIPPED here because they are extracted separately
            // by collectAlertElements() and added as top-level system alerts. This ensures
            // permission dialogs are always visible and never lost to hierarchy optimization.
            let parentClassName = mapElementType(snapshot.elementType)
            var childNodes: [UIElementInfo]?
            if depth < ElementLocator.maxDepth {
                let children = snapshot.children
                if !children.isEmpty {
                    var filteredChildren = children.enumerated().compactMap { (idx, child) -> UIElementInfo? in
                        // Skip alert elements - they are extracted separately as system alerts
                        // to ensure they're always visible as top-level children
                        if child.elementType == .alert {
                            return nil
                        }

                        let childFrame = child.frame

                        // Skip zero-area children
                        if childFrame.width <= 0 || childFrame.height <= 0 {
                            return nil
                        }

                        // Skip completely offscreen children (with margin)
                        let margin: CGFloat = 50
                        let expandedScreen = screenBounds.insetBy(dx: -margin, dy: -margin)
                        if !expandedScreen.intersects(childFrame) {
                            return nil
                        }

                        return buildElementInfoFromSnapshot(
                            child,
                            depth: depth + 1,
                            screenBounds: screenBounds,
                            parentPath: currentPath,
                            childIndex: idx,
                            keyboardFocusFrame: keyboardFocusFrame,
                            disableAllFiltering: disableAllFiltering
                        )
                    }

                    if !disableAllFiltering {
                        // Collapse same-type text-input children (e.g. UITextField inside UITextField)
                        // that are internal UIKit subviews with no unique identifying properties.
                        filteredChildren = ElementLocator.collapseSameTypeTextInputChildren(
                            parentClassName: parentClassName,
                            children: filteredChildren
                        )

                        // Deduplicate siblings with identical type + bounds + no unique properties.
                        filteredChildren = ElementLocator.deduplicateSiblings(filteredChildren)
                    }

                    childNodes = filteredChildren.isEmpty ? nil : filteredChildren
                }
            }

            // Determine boolean properties - only set to "true", leave nil for false
            // This significantly reduces JSON size
            let isEnabled = snapshot.isEnabled

            // Only mark specific element types as clickable (not generic UIViews)
            let isClickableType = isActuallyClickableType(snapshot.elementType)
            let isClickable = isEnabled && isClickableType

            let isScrollable = isScrollableType(snapshot.elementType)
            let isCheckable = isCheckableType(snapshot.elementType)
            let isSelected = snapshot.isSelected
            // UISwitch reports toggle state via value ("0"/"1"), not isSelected
            let isChecked: Bool
            if isCheckable, let value = snapshot.value as? String {
                isChecked = value == "1"
            } else {
                isChecked = isCheckable && isSelected
            }
            // snapshot.hasFocus reflects UIKit focus (tvOS/iPad), not keyboard input
            // focus on iPhone. Use the keyboardFocusFrame from the predicate query instead.
            let hasFocus: Bool
            if let focusFrame = keyboardFocusFrame, !frame.isEmpty, !focusFrame.isEmpty {
                let epsilon: CGFloat = 0.5
                let framesMatch = abs(frame.origin.x - focusFrame.origin.x) < epsilon
                    && abs(frame.origin.y - focusFrame.origin.y) < epsilon
                    && abs(frame.width - focusFrame.width) < epsilon
                    && abs(frame.height - focusFrame.height) < epsilon
                let isTextInput = snapshot.elementType == .textField
                    || snapshot.elementType == .textView
                    || snapshot.elementType == .secureTextField
                    || snapshot.elementType == .searchField
                hasFocus = framesMatch && isTextInput
            } else {
                hasFocus = snapshot.hasFocus
            }
            let isPassword = snapshot.elementType == .secureTextField

            // Only include actions for text input elements (click is implied by clickable)
            var actions: [String]?
            if isEnabled && (snapshot.elementType == .textField || snapshot.elementType == .textView ||
                snapshot.elementType == .secureTextField || snapshot.elementType == .searchField)
            {
                actions = ["set_text", "clear_text"]
            }

            // Get label - use for text (don't duplicate in content-desc)
            let label = snapshot.label.isEmpty ? nil : snapshot.label

            // For text inputs, surface the entered value separately from the
            // accessibility label (which is typically the placeholder for
            // UISearchBar / UITextField). Mask password content to avoid
            // leaking secrets through the hierarchy.
            let isTextInput = snapshot.elementType == .textField
                || snapshot.elementType == .textView
                || snapshot.elementType == .secureTextField
                || snapshot.elementType == .searchField
            var enteredValue: String?
            if isTextInput, let raw = snapshot.value as? String, !raw.isEmpty {
                enteredValue = isPassword ? String(repeating: "•", count: raw.count) : raw
            }

            return UIElementInfo(
                text: label,
                value: enteredValue,
                textSize: nil,
                contentDesc: nil, // Don't duplicate - label is in text
                resourceId: resId,
                className: parentClassName,
                bounds: hasZeroArea ? nil : bounds, // Don't include bounds for zero-area elements
                // Only include boolean fields when true (nil = false)
                clickable: isClickable ? "true" : nil,
                enabled: nil, // Don't include enabled - it's almost always true and implied by clickable
                focusable: nil, // Don't include - almost all elements are focusable on iOS
                focused: hasFocus ? "true" : nil,
                accessibilityFocused: nil,
                scrollable: isScrollable ? "true" : nil,
                password: isPassword ? "true" : nil,
                checkable: isCheckable ? "true" : nil,
                checked: isChecked ? "true" : nil,
                selected: isSelected ? "true" : nil,
                longClickable: nil, // Don't include - same as clickable on iOS
                semanticLinks: snapshot.elementType == .link
                    ? label.map { [SemanticLink(text: $0, occurrence: 0)] }
                    : nil,
                testTag: nil, // Don't duplicate - identifier is in resourceId
                role: mapRole(snapshot.elementType),
                stateDescription: nil,
                errorMessage: nil,
                hintText: snapshot.placeholderValue,
                viewId: viewId,
                extras: nil,
                actions: actions,
                node: childNodes
            )
        }

        // MARK: - Deterministic ID Generation

        /// Generate a deterministic UUID from a hierarchy path string using SHA-256.
        /// The path encodes the element's position in the tree, ensuring stable IDs
        /// across snapshots when the tree structure hasn't changed.
        private func generateDeterministicUuid(from path: String) -> String {
            let data = Data(path.utf8)
            let digest = SHA256.hash(data: data)
            let bytes = Array(digest)
            let hex = bytes.prefix(16).map { String(format: "%02x", $0) }.joined()
            return "\(hex.prefix(8))-\(hex.dropFirst(8).prefix(4))-\(hex.dropFirst(12).prefix(4))-\(hex.dropFirst(16).prefix(4))-\(hex.dropFirst(20).prefix(12))"
        }

        // MARK: - Hierarchy Optimization

        /// Check if an element has meaningful content that should be preserved
        private func meetsFilterCriteria(_ element: UIElementInfo) -> Bool {
            // String criteria - element has useful identifying information
            let hasStringCriteria =
                element.text != nil ||
                element.resourceId != nil ||
                element.role != nil ||
                element.hintText != nil

            // Boolean criteria - element is interactive
            let hasBooleanCriteria =
                element.clickable == "true" ||
                element.scrollable == "true" ||
                element.focused == "true" ||
                element.selected == "true" ||
                element.checkable == "true"

            return hasStringCriteria || hasBooleanCriteria
        }

        /// Check if a class name is a structural wrapper (no semantic meaning)
        private func isStructuralWrapper(_ className: String?) -> Bool {
            guard let className = className else { return false }
            return ElementLocator.structuralClassNames.contains(className)
        }

        /// Optimizes the hierarchy by:
        /// 1. Promoting children of bounds-only wrapper nodes (structural nodes with only bounds)
        /// 2. Filtering out empty structural nodes
        /// 3. Preserving interactive elements and their children
        ///
        /// This significantly reduces hierarchy size for complex UIs.
        private func optimizeHierarchy(_ element: UIElementInfo, isRoot: Bool = false) -> [UIElementInfo] {
            // Check if this element is a bounds-only wrapper (has no useful properties)
            let meetsCriteria = meetsFilterCriteria(element)
            let isStructural = isStructuralWrapper(element.className)
            let isBoundsOnlyWrapper = !meetsCriteria && isStructural

            // Never promote children of interactive elements
            let isInteractive = element.clickable == "true" ||
                element.scrollable == "true" ||
                element.selected == "true"

            // First, recursively optimize children
            var optimizedChildren: [UIElementInfo]?
            if let children = element.node {
                let optimized = children.flatMap { child in
                    optimizeHierarchy(child, isRoot: false)
                }
                let cleaned = ElementLocator.cleanupXCTestUIKitNoise(parent: element, children: optimized)
                optimizedChildren = cleaned.isEmpty ? nil : cleaned
            }

            // Root element is always kept
            if isRoot {
                return [Self.copying(element, node: optimizedChildren)]
            }

            // Only promote children (flatten hierarchy) if this is a bounds-only wrapper AND not interactive
            if isBoundsOnlyWrapper && !isInteractive {
                if let children = optimizedChildren {
                    if ElementLocator.containsOnlyUnprotectedScrollBarNoise(children) {
                        return []
                    }
                    // Promote children - flatten this wrapper node
                    return children
                }
                // No children and no content - filter out completely
                return []
            }

            // Keep this element with optimized children
            return [Self.copying(element, node: optimizedChildren)]
        }

        private func mapElementType(_ type: XCUIElement.ElementType) -> String {
            switch type {
            case .application: return "XCUIApplication"
            case .window: return "UIWindow"
            case .button: return "UIButton"
            case .staticText: return "UILabel"
            case .textField: return "UITextField"
            case .secureTextField: return "UISecureTextField"
            case .textView: return "UITextView"
            case .image: return "UIImageView"
            case .switch: return "UISwitch"
            case .slider: return "UISlider"
            case .picker: return "UIPickerView"
            case .table: return "UITableView"
            case .cell: return "UITableViewCell"
            case .scrollView: return "UIScrollView"
            case .collectionView: return "UICollectionView"
            case .navigationBar: return "UINavigationBar"
            case .tabBar: return "UITabBar"
            case .toolbar: return "UIToolbar"
            case .searchField: return "UISearchBar"
            case .alert: return "UIAlertController"
            case .sheet: return "UIActionSheet"
            case .progressIndicator: return "UIProgressView"
            case .activityIndicator: return "UIActivityIndicatorView"
            case .segmentedControl: return "UISegmentedControl"
            case .stepper: return "UIStepper"
            case .datePicker: return "UIDatePicker"
            case .webView: return "WKWebView"
            case .link: return "UILink"
            case .keyboard: return "UIKeyboard"
            case .key: return "UIKeyboardKey"
            default: return "UIView"
            }
        }

        private func mapRole(_ type: XCUIElement.ElementType) -> String? {
            switch type {
            case .button: return "button"
            case .link: return "link"
            case .switch: return "switch"
            case .checkBox: return "checkbox"
            case .radioButton: return "radio"
            case .slider: return "slider"
            case .textField, .textView, .secureTextField, .searchField: return "textfield"
            case .image: return "image"
            case .staticText: return "text"
            case .table, .collectionView: return "list"
            case .cell: return "listitem"
            case .tab: return "tab"
            case .progressIndicator: return "progressbar"
            default: return nil
            }
        }

        private func isScrollableType(_ type: XCUIElement.ElementType) -> Bool {
            switch type {
            case .scrollView, .table, .collectionView, .webView, .textView:
                return true
            default:
                return false
            }
        }

        private func isCheckableType(_ type: XCUIElement.ElementType) -> Bool {
            switch type {
            case .switch, .checkBox, .radioButton:
                return true
            default:
                return false
            }
        }

        /// Check if an element type is actually clickable (not just a generic container)
        /// This prevents marking every UIView as clickable just because it's enabled
        private func isActuallyClickableType(_ type: XCUIElement.ElementType) -> Bool {
            switch type {
            // Interactive controls
            case .button, .link, .switch, .slider, .stepper, .segmentedControl:
                return true
            // Checkable items
            case .checkBox, .radioButton:
                return true
            // Text input
            case .textField, .textView, .secureTextField, .searchField:
                return true
            // List items (cells are tappable)
            case .cell:
                return true
            // Tab and navigation items
            case .tab, .tabBar:
                return true
            // Pickers
            case .picker, .datePicker:
                return true
            // Alert/sheet buttons
            case .alert, .sheet:
                return true
            // Keyboard keys
            case .key:
                return true
            // Images can be tappable
            case .image:
                return true
            // Everything else (UIView, window, staticText, etc.) is not inherently clickable
            default:
                return false
            }
        }

        // MARK: - Element Finding

        public func findElement(byResourceId resourceId: String) -> Any? {
            if let cached = elementCache[resourceId] {
                print("[ElementLocator] Element found by resourceId=\(resourceId) source=cache")
                return cached
            }

            let app = currentApplication
            // Query .any first (1 IPC call). If the match is a text-input type,
            // re-query with the specific type to get the outermost (parent) element
            // instead of an internal UIKit subview that shares the same identifier.
            guard let element: XCUIElement = catchingObjCExceptionNonThrowing({
                Self.firstMatchingElement(
                    foregroundLookup: {
                        Self.findElement(in: app, byResourceId: resourceId)
                    },
                    springBoardLookup: {
                        guard self.foregroundBundleId != "com.apple.springboard" else { return nil }
                        return self.findSpringBoardAlertElement(byResourceId: resourceId)
                    }
                )
            }, fallback: nil) else {
                print("[ElementLocator] Element not found by resourceId=\(resourceId)")
                return nil
            }
            elementCache[resourceId] = element
            print("[ElementLocator] Element found by resourceId=\(resourceId) source=query")
            return element
        }

        public func findElement(byText text: String) -> Any? {
            let app = currentApplication
            let element = catchingObjCExceptionNonThrowing({
                Self.firstMatchingElement(
                    foregroundLookup: {
                        Self.findElement(in: app, byText: text)
                    },
                    springBoardLookup: {
                        guard self.foregroundBundleId != "com.apple.springboard" else { return nil }
                        return self.findSpringBoardAlertElement(byText: text)
                    }
                )
            }, fallback: nil)
            if element == nil {
                print("[ElementLocator] Element not found by text=\(text)")
            } else {
                print("[ElementLocator] Element found by text=\(text)")
            }
            return element
        }

        private static func findElement(in app: XCUIApplication, byResourceId resourceId: String) -> XCUIElement? {
            let anyMatch = app.descendants(matching: .any)
                .matching(identifier: resourceId).firstMatch
            guard anyMatch.exists else { return nil }

            let matchedType = anyMatch.elementType
            if textInputElementTypes.contains(matchedType) {
                let typedMatch = app.descendants(matching: matchedType)
                    .matching(identifier: resourceId).firstMatch
                if typedMatch.exists {
                    return typedMatch
                }
            }
            return anyMatch
        }

        private static func findElement(in app: XCUIApplication, byText text: String) -> XCUIElement? {
            let match = app.descendants(matching: .any)
                .matching(NSPredicate(format: "label == %@", text)).firstMatch
            return match.exists ? match : nil
        }

        /// Finds a SpringBoard element only when it belongs to an alert snapshot that
        /// `getAlertsFromSpringboard` would expose through `observe` (#4014).
        private func findSpringBoardAlertElement(byResourceId resourceId: String) -> XCUIElement? {
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            guard let snapshot = try? springboard.snapshot() else { return nil }
            let matchingFrames = Self.matchingFrames(
                in: collectAlertElements(from: snapshot),
                matches: { $0.identifier == resourceId }
            )
            return Self.findElement(in: springboard, byResourceId: resourceId, constrainedTo: matchingFrames)
        }

        private func findSpringBoardAlertElement(byText text: String) -> XCUIElement? {
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            guard let snapshot = try? springboard.snapshot() else { return nil }
            let matchingFrames = Self.matchingFrames(
                in: collectAlertElements(from: snapshot),
                matches: { $0.label == text }
            )
            return Self.findElement(in: springboard, byText: text, constrainedTo: matchingFrames)
        }

        private static func findElement(
            in app: XCUIApplication,
            byResourceId resourceId: String,
            constrainedTo frames: [CGRect]
        ) -> XCUIElement?
        {
            guard !frames.isEmpty else {
                return nil
            }
            let matches = app.descendants(matching: .any)
                .matching(identifier: resourceId)
                .allElementsBoundByIndex
            return matches.first { element in
                frames.contains { frame in
                    frame.equalTo(element.frame)
                }
            }
        }

        private static func findElement(
            in app: XCUIApplication,
            byText text: String,
            constrainedTo frames: [CGRect]
        ) -> XCUIElement?
        {
            guard !frames.isEmpty else {
                return nil
            }
            let matches = app.descendants(matching: .any)
                .matching(NSPredicate(format: "label == %@", text))
                .allElementsBoundByIndex
            return matches.first { element in
                frames.contains { frame in
                    frame.equalTo(element.frame)
                }
            }
        }

        private static func matchingFrames(
            in alertSnapshots: [XCUIElementSnapshot],
            matches: (XCUIElementSnapshot) -> Bool
        ) -> [CGRect]
        {
            alertSnapshots.flatMap { alertSnapshot in
                descendants(of: alertSnapshot).compactMap { snapshot in
                    matches(snapshot) ? snapshot.frame : nil
                }
            }
        }

        private static func descendants(of snapshot: XCUIElementSnapshot) -> [XCUIElementSnapshot]
        {
            [snapshot] + snapshot.children.flatMap(descendants)
        }

    #else
        /// Non-iOS stub implementation
        public init() {}

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
    #endif

    // MARK: - Platform-independent helpers (host-compiled and host-tested)
    //
    // These operate only on `UIElementInfo` / `ElementBounds` / scalars, so they live
    // outside the `#if os(iOS)` block and are exercised directly by the parity tests on
    // macOS. On this `@MainActor` class they must be `nonisolated static` so non-isolated
    // test code (and the iOS instance methods, synchronously) can call them without hopping.

    /// Returns the foreground match when available; otherwise consults SpringBoard.
    /// Keeping the fallback here makes all lookup paths preserve app precedence while
    /// allowing actions to resolve system-owned alerts that observation exposes (#4014).
    nonisolated static func firstMatchingElement<Element>(
        foregroundLookup: () -> Element?,
        springBoardLookup: () -> Element?
    ) -> Element? {
        foregroundLookup() ?? springBoardLookup()
    }

    // MARK: - Same-Type Child Collapsing & Sibling Dedup

    /// Class name strings for text-input element types whose UIKit internal subviews
    /// produce same-type nested children in the XCUITest accessibility tree.
    /// NOTE: Must stay in sync with `textInputElementTypes` (the XCUIElement.ElementType set
    /// inside #if os(iOS)). Note that .searchField maps to "UISearchBar" (not "UISearchField").
    nonisolated static let textInputClassNames: Set<String> = [
        "UITextField",
        "UISecureTextField",
        "UITextView",
        "UISearchBar",
    ]

    /// Adds typed XCTest text-input candidates that the recursive application
    /// snapshot did not contain. Fallback nodes are leaves below the application
    /// root because XCTest does not expose a reliable parent for this path.
    nonisolated static func mergeMissingTextInputCandidates(
        into root: UIElementInfo,
        candidates: [UIElementInfo]
    ) -> UIElementInfo {
        var existing = allNodes(in: root)
        var rootChildren = root.node ?? []

        for candidate in candidates {
            guard !existing.contains(where: { isSameTextInput($0, candidate) }) else {
                continue
            }

            let leaf = copying(candidate, node: nil)
            rootChildren.append(leaf)
            existing.append(leaf)
        }

        return copying(root, node: rootChildren.isEmpty ? nil : rootChildren)
    }

    nonisolated private static func allNodes(in element: UIElementInfo) -> [UIElementInfo] {
        [element] + (element.node ?? []).flatMap(allNodes)
    }

    nonisolated private static func isSameTextInput(_ lhs: UIElementInfo, _ rhs: UIElementInfo) -> Bool {
        guard lhs.resourceId == rhs.resourceId,
              lhs.className == rhs.className,
              let lhsBounds = lhs.bounds,
              let rhsBounds = rhs.bounds
        else {
            return false
        }

        return lhsBounds.left == rhsBounds.left
            && lhsBounds.top == rhsBounds.top
            && lhsBounds.right == rhsBounds.right
            && lhsBounds.bottom == rhsBounds.bottom
    }

    nonisolated static func copying(_ element: UIElementInfo, node: [UIElementInfo]?) -> UIElementInfo {
        UIElementInfo(
            text: element.text,
            value: element.value,
            textSize: element.textSize,
            contentDesc: element.contentDesc,
            resourceId: element.resourceId,
            className: element.className,
            bounds: element.bounds,
            clickable: element.clickable,
            enabled: element.enabled,
            focusable: element.focusable,
            focused: element.focused,
            accessibilityFocused: element.accessibilityFocused,
            scrollable: element.scrollable,
            password: element.password,
            checkable: element.checkable,
            checked: element.checked,
            selected: element.selected,
            longClickable: element.longClickable,
            semanticLinks: element.semanticLinks,
            testTag: element.testTag,
            role: element.role,
            stateDescription: element.stateDescription,
            errorMessage: element.errorMessage,
            hintText: element.hintText,
            viewId: element.viewId,
            extras: element.extras,
            actions: element.actions,
            node: node
        )
    }

    /// Check whether a UIElementInfo carries any unique identifying information
    /// (text, resourceId, contentDesc, hintText). Elements without these are
    /// considered internal UIKit subviews that should be collapsed/deduped.
    nonisolated static func hasUniqueIdentifyingProperties(_ element: UIElementInfo) -> Bool {
        return element.text != nil
            || element.resourceId != nil
            || element.contentDesc != nil
            || element.hintText != nil
    }

    /// Whether the live keyboard-focus predicate query should run (issue #5474).
    ///
    /// The keyboard-focus frame is only ever applied to text-input nodes when
    /// building element info, so when the captured snapshot exposes no text-input
    /// node there is nothing a focus frame could annotate — the extra live query
    /// (a main-thread IPC round trip) is pure overhead and is skipped.
    nonisolated static func shouldQueryKeyboardFocus(textInputSnapshotCount: Int) -> Bool {
        return textInputSnapshotCount > 0
    }

    /// Whether the second, SpringBoard full-tree snapshot should be taken to look
    /// for system alerts (issue #5474).
    ///
    /// When the foreground app IS SpringBoard, the app snapshot already is
    /// SpringBoard's tree, so a second serialization would be redundant. Otherwise
    /// the extra snapshot is only warranted when the app's own snapshot already
    /// shows an alert element (a co-presented system dialog may exist in
    /// SpringBoard's tree); the common no-alert case skips it.
    nonisolated static func shouldSnapshotSpringboardForAlerts(
        foregroundIsSpringboard: Bool,
        appHasAlert: Bool
    ) -> Bool {
        if foregroundIsSpringboard {
            return false
        }
        return appHasAlert
    }

    /// Whether the last-resort ~40-app `checkSystemApps` foreground sweep should
    /// run, or be short-circuited by a recently cached negative result (issue #5474).
    ///
    /// A zero `lastMissTime` (never swept, or invalidated by a foreground switch)
    /// always runs. A clock that appears to run backwards also runs, to avoid
    /// wedging on a bad sample. Otherwise the sweep is skipped until the TTL since
    /// the last miss has elapsed.
    nonisolated static func shouldRunSystemAppSweep(
        now: UInt64,
        lastMissTime: UInt64,
        ttlNanos: UInt64
    ) -> Bool {
        guard lastMissTime != 0 else { return true }
        guard now >= lastMissTime else { return true }
        return (now - lastMissTime) >= ttlNanos
    }

    /// Resolve the logical screen dimensions reported in the hierarchy.
    ///
    /// The XCUITest runner process can report a stale 320x480 `UIScreen.main.bounds`
    /// when it runs in legacy compatibility mode (issue #2683). The foreground app's
    /// root snapshot frame reflects the true device size, so prefer it and fall back
    /// to the runner-reported bounds only when the root frame is unavailable or
    /// degenerate.
    nonisolated static func resolveScreenDimensions(
        rootBounds: ElementBounds?,
        fallbackWidth: Int,
        fallbackHeight: Int
    ) -> (width: Int, height: Int) {
        if let bounds = rootBounds, bounds.width > 0, bounds.height > 0 {
            return (bounds.width, bounds.height)
        }
        return (fallbackWidth, fallbackHeight)
    }

    /// Compute the physical screenshot pixel dimensions for the reported point dimensions.
    ///
    /// `nativeScale` must be `UIScreen.nativeScale`, never `UIScreen.scale`: under Display
    /// Zoom the two differ (e.g. a zoomed iPhone reports scale 3.0 while nativeScale is
    /// ~3.14, and an iPhone Plus reports scale 3.0 with nativeScale ~2.61), and
    /// `XCUIScreenshot.pngRepresentation` is rendered at native scale — so only
    /// `points * nativeScale` matches the actual screenshot pixels (#4548).
    ///
    /// Returns nil when any input is degenerate, so the additive wire fields are simply
    /// omitted rather than carrying values no screenshot can match.
    nonisolated static func computePixelDimensions(
        pointWidth: Int,
        pointHeight: Int,
        nativeScale: Double
    ) -> (pixelWidth: Int, pixelHeight: Int)? {
        guard pointWidth > 0, pointHeight > 0, nativeScale.isFinite, nativeScale > 0 else {
            return nil
        }
        return (
            pixelWidth: Int((Double(pointWidth) * nativeScale).rounded()),
            pixelHeight: Int((Double(pointHeight) * nativeScale).rounded())
        )
    }

    /// Collapse same-type text-input children into their parent.
    ///
    /// iOS UIKit exposes internal subviews (e.g. _UITextFieldRoundedRectBackgroundViewNeue)
    /// as accessibility elements with the *same* elementType as the parent text field.
    /// These are non-interactive noise that confuse element targeting.
    ///
    /// For text-input parent types, any child with the same className that carries no
    /// unique identifying properties is collapsed: its children are absorbed into the
    /// parent's child list, and the duplicate wrapper is removed.
    nonisolated static func collapseSameTypeTextInputChildren(
        parentClassName: String?,
        children: [UIElementInfo]
    ) -> [UIElementInfo] {
        guard let parentClass = parentClassName,
              textInputClassNames.contains(parentClass)
        else {
            return children
        }

        var result: [UIElementInfo] = []
        for child in children {
            if child.className == parentClass && !hasUniqueIdentifyingProperties(child) && !hasStateFlags(child) {
                // Collapse: absorb this child's children into the parent level
                if let grandchildren = child.node {
                    result.append(contentsOf: grandchildren)
                }
                // else: empty same-type wrapper — discard entirely
            } else {
                result.append(child)
            }
        }
        return result
    }

    /// Whether the element carries any state flags (focused, selected, checked,
    /// password, clickable, scrollable) that make it semantically distinct.
    nonisolated private static func hasStateFlags(_ element: UIElementInfo) -> Bool {
        return element.focused != nil || element.selected != nil
            || element.checked != nil || element.password != nil
            || element.clickable != nil || element.scrollable != nil
    }

    /// Deduplicate sibling elements that share the same elementType, identical bounds,
    /// and carry no unique identifying properties (no id, text, contentDesc, hintText).
    /// Only deduplicates leaf elements (no children) — elements with distinct subtrees
    /// are always preserved to avoid discarding valid controls.
    /// Keeps only the first occurrence of each duplicate.
    nonisolated static func deduplicateSiblings(_ children: [UIElementInfo]) -> [UIElementInfo] {
        var seen: Set<String> = []
        var result: [UIElementInfo] = []

        for child in children {
            if hasUniqueIdentifyingProperties(child) {
                // Has unique info — always keep
                result.append(child)
                continue
            }

            // Elements with children have distinct subtrees — always keep
            if let node = child.node, !node.isEmpty {
                result.append(child)
                continue
            }

            // Elements with any state flags are considered distinct — don't discard
            // a focused/selected/checked/password element as a duplicate
            if hasStateFlags(child) {
                result.append(child)
                continue
            }

            // Build key from className + bounds
            let key: String
            if let cls = child.className, let b = child.bounds {
                key = "\(cls)|\(b.left),\(b.top),\(b.right),\(b.bottom)"
            } else if let cls = child.className {
                key = "\(cls)|nobounds"
            } else {
                // No className — can't meaningfully dedup, keep it
                result.append(child)
                continue
            }

            if seen.contains(key) {
                continue
            }
            seen.insert(key)
            result.append(child)
        }
        return result
    }

    /// Collapse common XCTest/UIKit hierarchy noise that survives the generic
    /// structural wrapper pass. The rules are intentionally conservative:
    /// discard duplicated labels/scroll bars/accessory nodes only when the node
    /// is non-actionable, while preserving tappable controls, text inputs, ids,
    /// focus/selection state, and meaningful descendants.
    nonisolated static func cleanupXCTestUIKitNoise(parent: UIElementInfo, children: [UIElementInfo]) -> [UIElementInfo] {
        var seenNoiseKeys: Set<String> = []
        var result: [UIElementInfo] = []

        for child in children {
            if isDuplicateLabel(child, of: parent) {
                continue
            }
            if isStructuralWrapperWithOnlyScrollBarNoise(child) {
                continue
            }
            if let key = dedupeNoiseKey(child) {
                if seenNoiseKeys.contains(key) {
                    continue
                }
                seenNoiseKeys.insert(key)
            }
            result.append(child)
        }

        return result
    }

    nonisolated private static func isDuplicateLabel(_ child: UIElementInfo, of parent: UIElementInfo) -> Bool {
        guard let parentText = parent.text,
              let childText = child.text,
              parentText == childText,
              child.className == "UILabel",
              isActionableContainer(parent),
              !isActionable(child)
        else {
            return false
        }
        return true
    }

    nonisolated private static func isActionableContainer(_ element: UIElementInfo) -> Bool {
        return element.clickable == "true"
            || element.role == "button"
            || element.role == "listitem"
            || element.className == "UIButton"
            || element.className == "UITableViewCell"
            || element.className == "UICollectionViewCell"
    }

    nonisolated private static func isActionable(_ element: UIElementInfo) -> Bool {
        return element.clickable == "true"
            || element.resourceId != nil
            || hasProtectedMetadata(element)
    }

    nonisolated private static func isStructuralWrapperWithOnlyScrollBarNoise(_ element: UIElementInfo) -> Bool {
        guard element.className == "UIView",
              !isActionable(element),
              element.text == nil,
              element.value == nil,
              element.contentDesc == nil,
              element.resourceId == nil,
              element.hintText == nil,
              let children = element.node,
              !children.isEmpty
        else {
            return false
        }
        return containsOnlyUnprotectedScrollBarNoise(children)
    }

    nonisolated private static func containsOnlyUnprotectedScrollBarNoise(_ children: [UIElementInfo]) -> Bool {
        return !children.isEmpty && children.allSatisfy { isScrollBarNoise($0) && !isActionable($0) }
    }

    nonisolated private static func dedupeNoiseKey(_ element: UIElementInfo) -> String? {
        guard element.node?.isEmpty ?? true else {
            return nil
        }

        if isScrollBarNoise(element) && !isActionable(element) {
            return "\(element.className ?? "")|\(normalizedText(element.text))|\(boundsKey(element.bounds))|\(element.resourceId ?? "")"
        }
        if isKeyboardAccessoryNoise(element) && !hasProtectedMetadata(element) {
            return "\(element.className ?? "")|\(normalizedText(element.text))|\(boundsKey(element.bounds))|\(element.resourceId ?? "")"
        }
        return nil
    }

    nonisolated private static func hasProtectedMetadata(_ element: UIElementInfo) -> Bool {
        return element.longClickable == "true"
            || element.focused == "true"
            || element.accessibilityFocused == "true"
            || element.selected == "true"
            || element.checkable == "true"
            || element.checked == "true"
            || element.scrollable == "true"
            || element.testTag != nil
            || hasProtectedRoleMetadata(element)
            || element.stateDescription != nil
            || element.errorMessage != nil
            || element.hintText != nil
            || element.extras?.isEmpty == false
            || element.actions?.isEmpty == false
            || textInputClassNames.contains(element.className ?? "")
    }

    nonisolated private static func hasProtectedRoleMetadata(_ element: UIElementInfo) -> Bool {
        guard let role = element.role else {
            return false
        }
        return role != "text" && role != "button"
    }

    nonisolated private static func isScrollBarNoise(_ element: UIElementInfo) -> Bool {
        return normalizedText(element.text).contains("scroll bar")
    }

    nonisolated private static func isKeyboardAccessoryNoise(_ element: UIElementInfo) -> Bool {
        let text = normalizedText(element.text)
        return text == "dictation" || text == "dictate"
    }

    nonisolated private static func normalizedText(_ text: String?) -> String {
        return text?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }

    nonisolated private static func boundsKey(_ bounds: ElementBounds?) -> String {
        guard let bounds = bounds else {
            return "nobounds"
        }
        return "\(bounds.left),\(bounds.top),\(bounds.right),\(bounds.bottom)"
    }
}
