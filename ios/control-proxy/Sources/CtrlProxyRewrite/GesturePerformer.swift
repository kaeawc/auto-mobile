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
/// (`runOnMainThread`); isolating the whole class to the
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
    let keyboardClock: any Clock<Duration>
    var caretMemo: CaretMemo?
    let logger = Logger(subsystem: "dev.jasonpearson.automobile", category: "GesturePerformer")

    nonisolated static let caretMemoTTL: Duration = .seconds(2)

    #if canImport(XCTest) && os(iOS)
        weak var application: XCUIApplication?
        /// Strong reference to keep the application alive when set via updateApplication.
        /// Without this, the weak `application` property would immediately deallocate
        /// freshly created XCUIApplication instances that have no other strong owner.
        private var ownedApplication: XCUIApplication?
        let elementLocator: ElementLocating
        let tapDiagnosticsSampler: any TapDiagnosticsSampling

        /// Cached SpringBoard app reference for system alert handling.
        lazy var springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

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

        /// Injects the application under test. A known `bundleId` pins it, so gestures on it keep
        /// the pinned `XCUIApplication`; without one the pin is cleared (#10995).
        public func setApplication(_ app: XCUIApplication, bundleId: String? = nil) {
            ownedApplication = nil
            pinnedApplication.inject(bundleId: bundleId)
            application = app
        }

        /// Bundle id `application` was pinned for: by `updateApplication` (launch) or by
        /// `setApplication(_:bundleId:)`; none when it was injected without one. Gesture rebinding
        /// never changes it.
        private var pinnedApplication = GesturePinnedApplication()

        /// The application a coordinate gesture targets: the pinned app unless the locator's
        /// tracked foreground app has moved on (e.g. after `simctl launch`, #10858).
        func gestureApplication() -> XCUIApplication? {
            gestureApplication(for: gestureApplicationTarget())
        }

        func gestureApplicationTarget() -> GestureApplicationTarget {
            pinnedApplication.target(trackedBundleId: elementLocator.foregroundBundleId)
        }

        func gestureApplication(for target: GestureApplicationTarget) -> XCUIApplication? {
            switch target {
            case .keepPinned:
                return application
            case let .rebind(bundleId):
                // A fresh instance for this gesture only: storing it as the pinned app would send
                // every later gesture on this externally launched app down `.keepPinned` (#10858).
                return catchingObjCExceptionNonThrowing({ XCUIApplication(bundleIdentifier: bundleId) }, fallback: nil)
            }
        }

        /// Decides whether a gesture skips the `XCUIApplication` for an app the runner did not
        /// launch (#10858; see `GestureDeliveryRoute`), and logs one `gesture_route` line. Returns
        /// the interface orientation to synthesize with, or nil to keep the `XCUICoordinate` path.
        /// The pinned app is left as is, so a later `launchApp` still pins its app and returns
        /// gestures to the `XCUICoordinate` path.
        func unpinnedSynthesisOrientation(
            kind: GestureKind, target: GestureApplicationTarget, forced: TapCoordinateStrategy?
        )
            -> Int?
        {
            let decision = GestureDeliveryRoute.decide(
                target: target, forced: forced, geometry: elementLocator.gestureCoordinateGeometry
            )
            // One line per gesture: tells a stale tracker (keepPinned) from a missing observation.
            let pinned = pinnedApplication.bundleId ?? "none"
            let tracked = elementLocator.foregroundBundleId ?? "none"
            let fallback = decision.fallback?.rawValue ?? "none"
            logger.info(
                "gesture_route gesture=\(kind.rawValue, privacy: .public) target=\(target.logLabel, privacy: .public) pinned=\(pinned, privacy: .public) tracked=\(tracked, privacy: .public) fallback=\(fallback, privacy: .public)"
            )
            guard case let .synthesizedEventRecord(orientation) = decision.route else { return nil }
            return orientation
        }

        /// Delivers a one-finger tap or swipe without an `XCUIApplication`. Returns false when
        /// the route does not apply or the private synthesis symbols are unavailable, so the caller
        /// keeps its `XCUICoordinate` path.
        func deliverToUnpinnedForegroundApp(
            kind: GestureKind = .tap,
            target: GestureApplicationTarget, forced: TapCoordinateStrategy?,
            start: GesturePoint, end: GesturePoint, duration: TimeInterval
        )
            throws -> Bool
        {
            guard let orientation = unpinnedSynthesisOrientation(kind: kind, target: target, forced: forced) else {
                return false
            }
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

        /// Drag counterpart of `deliverToUnpinnedForegroundApp`: one finger presses, moves and
        /// holds through the display-targeted event helper on the main display. Returns false
        /// when the route does not apply, no main display is known, or the symbols are missing.
        func deliverDragToUnpinnedForegroundApp(
            target: GestureApplicationTarget, start: GesturePoint, end: GesturePoint,
            press: TimeInterval, move: TimeInterval, hold: TimeInterval
        )
            throws -> Bool
        {
            guard let orientation = unpinnedSynthesisOrientation(kind: .drag, target: target, forced: nil) else {
                return false
            }
            let screens = (ObjCExceptionCatcher_displayInventory() ?? []).compactMap { entry in
                entry["displayId"].flatMap { id in
                    entry["isMain"]
                        .map { TapDiagnostics.DisplayScreen(displayId: id.uint64Value, isMain: $0.boolValue) }
                }
            }
            guard let displayId = UnpinnedGestureSynthesis.mainDisplayId(screens: screens) else {
                logger.warning("gesture_route gesture=drag fallback=noMainDisplay; using XCUICoordinate")
                return false
            }
            let touch = UnpinnedGestureSynthesis.drag(
                start: start, end: end, press: press, move: move, hold: hold,
                displayId: displayId, interfaceOrientation: orientation
            )
            return try catchingObjCException { () -> Bool in
                GesturePhaseDiagnostics.current?.begin("synthesizedGesture")
                defer { GesturePhaseDiagnostics.current?.begin("postGesture") }
                var errorMessage: NSString?
                var symbolsUnavailable: ObjCBool = false
                let succeeded = ObjCExceptionCatcher_synthesizeDisplayTouch(
                    CGFloat(touch.start.x), CGFloat(touch.start.y), CGFloat(touch.end.x), CGFloat(touch.end.y),
                    touch.pressDuration, touch.moveDuration, touch.holdDuration, touch.displayId,
                    touch.interfaceOrientation, &symbolsUnavailable, &errorMessage
                )
                if succeeded { return true }
                guard symbolsUnavailable.boolValue else {
                    throw GestureError.gestureFailed(errorMessage as String? ?? "drag synthesis failed")
                }
                logger.warning(
                    "drag synthesis unavailable; using XCUICoordinate: \((errorMessage as String?) ?? "", privacy: .public)"
                )
                return false
            }
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
        static var clipboardShadow: String?

        public func updateApplication(bundleId: String) {
            catchingObjCExceptionNonThrowing({
                let app = XCUIApplication(bundleIdentifier: bundleId)
                self.ownedApplication = app
                self.pinnedApplication.pin(bundleId)
                self.application = app
            }, fallback: ())
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

    #endif
}
