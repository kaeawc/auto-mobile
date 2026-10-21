import Foundation

@MainActor
public protocol ElementLocating: Sendable {
    /// The full view hierarchy of the current foreground app plus any system alerts.
    /// - Parameter disableAllFiltering: when `true`, skip optimization and return the raw hierarchy.
    func getViewHierarchy(disableAllFiltering: Bool) throws -> ViewHierarchy

    /// Find an element by resource id / accessibility identifier. Returns an opaque
    /// `XCUIElement` (or `nil`); the caller treats it as a token to act on.
    func findElement(byResourceId resourceId: String) -> Any?

    /// Find an element by (partial) text content.
    func findElement(byText text: String) -> Any?
    func findElement(byText text: String, bounds: ElementBounds) -> Any?

    /// Record a bundle id the foreground-app detector should recognize as observed.
    func trackObservedBundleId(_ bundleId: String)

    /// Explicitly switch the tracked foreground app to `bundleId`. The command handler calls
    /// this after state-changing operations (launch, terminate, go-home).
    func switchForegroundApp(bundleId: String)

    /// The current lifecycle state of the app with the given bundle id.
    func getAppState(bundleId: String) -> ObservedAppState

    /// Wait for `bundleId` to reach `expectedState`. Bounded polling: up to 10 attempts at
    /// 50ms intervals, yielding the main actor between probes. Returns `true` if reached,
    /// `false` on exhaustion or cancellation.
    func awaitAppState(bundleId: String, expectedState: AppStateExpectation) async -> Bool

    /// Bundle id of the currently tracked foreground app, or `nil` if none has been set.
    var foregroundBundleId: String? { get }

    /// Refresh foreground-app tracking before returning the current bundle id.
    func refreshForegroundBundleId() -> String?
}

extension ElementLocating {
    var gestureCoordinateGeometry: GestureCoordinateGeometry? {
        (self as? ElementLocator)?.observedGestureGeometry
    }
}
