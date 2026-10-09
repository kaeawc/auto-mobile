import Foundation

/// Decides which application a coordinate gesture (tap, swipe, drag, pinch) is bound to.
///
/// The runner pins an app when `request_launch_app` runs, but an app launched with
/// `simctl launch` never reaches that handler. The locator's tracker follows it through the
/// observe path, so a gesture bound to the pinned app addressed the previous app and failed with
/// "Application ... is not running" (#10858). The tracked foreground bundle id wins whenever it
/// differs from the one the pinned app was built for.
enum GestureApplicationTarget: Equatable {
    /// Keep the application the performer already holds.
    case keepPinned
    /// Re-resolve an `XCUIApplication` for this bundle id before the gesture.
    case rebind(bundleId: String)

    static func resolve(pinnedBundleId: String?, trackedBundleId: String?) -> Self {
        guard let tracked = trackedBundleId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !tracked.isEmpty
        else {
            return .keepPinned
        }
        return tracked == pinnedBundleId ? .keepPinned : .rebind(bundleId: tracked)
    }
}

/// How a tap or swipe reaches the screen.
///
/// Rebinding to an app the runner did not launch or activate is not enough (#10858): after
/// `simctl launch com.apple.Preferences`, observe reads the app through an accessibility
/// snapshot, but an `XCUICoordinate` tap anchored on the rebound `XCUIApplication` must resolve
/// that app through a live query and wait for it to idle before and after the event. On an
/// iOS 26.5 simulator the tap timed out on the host after 5 s, the runner stayed busy about
/// 20 s, and the screen did not change. `launchApp` hides the problem because XCTest launches or activates the
/// app itself. An event record synthesized in screen space needs no application at all, the
/// same delivery the lock-screen swipe uses.
enum GestureDeliveryRoute: Equatable {
    /// `XCUICoordinate` on the performer's application.
    case xcuiCoordinate
    /// App-free synthesized event record at the observed point, in this
    /// `UIInterfaceOrientation` raw value.
    case synthesizedEventRecord(interfaceOrientation: Int)

    /// Synthesizes only when every condition proves an observed point is a screen point:
    /// the foreground app was not pinned by the runner, no strategy was forced, and the cached
    /// observation of that app is a full-screen, single-panel frame with a known rotation.
    /// Anything else keeps the `XCUICoordinate` path and its multi-panel and window mapping.
    static func resolve(
        target: GestureApplicationTarget,
        forced: TapCoordinateStrategy?,
        geometry: GestureCoordinateGeometry?
    )
        -> Self
    {
        guard case .rebind = target,
              forced == nil,
              let geometry,
              geometry.app.isValid,
              geometry.screen.isValid,
              !hasMultiPanelMismatch(app: geometry.app, screen: geometry.screen),
              let orientation = DeviceRotation.gestureInterfaceOrientationRawValue(rotation: geometry.rotation)
        else {
            return .xcuiCoordinate
        }
        return .synthesizedEventRecord(interfaceOrientation: orientation)
    }
}
