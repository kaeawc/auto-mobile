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
