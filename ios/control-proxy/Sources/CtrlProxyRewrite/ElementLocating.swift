import Foundation

/// Locates UI elements and builds the Android-compatible view hierarchy via XCUITest.
///
/// `@MainActor`: every method ultimately drives XCUITest, which must run on the main
/// thread. Isolating the whole protocol — rather than hopping per call as the reference
/// did with `DispatchQueue.main.sync` — makes `getViewHierarchy`'s multi-step capture a
/// single main-actor transaction. That closes race #1: the reference's non-atomic capture
/// where a mid-capture UI change could interleave between the app snapshot, the SpringBoard
/// snapshot, and the final screen-metrics read. A `Sendable` `CommandHandler` (Phase 6)
/// `await`s this from off the main actor.
///
/// `ElementLocator` also conforms to the narrower `@MainActor HierarchyExtracting` (the
/// debouncer's seam); both declare `getViewHierarchy(disableAllFiltering:)` and a single
/// implementation satisfies both.
@MainActor
public protocol ElementLocating {
    /// The full view hierarchy of the current foreground app plus any system alerts.
    /// - Parameter disableAllFiltering: when `true`, skip optimization and return the raw hierarchy.
    func getViewHierarchy(disableAllFiltering: Bool) throws -> ViewHierarchy

    /// Find an element by resource id / accessibility identifier. Returns an opaque
    /// `XCUIElement` (or `nil`); the caller treats it as a token to act on.
    func findElement(byResourceId resourceId: String) -> Any?

    /// Find an element by (partial) text content.
    func findElement(byText text: String) -> Any?

    /// Record a bundle id the foreground-app detector should recognize as observed.
    func trackObservedBundleId(_ bundleId: String)

    /// Explicitly switch the tracked foreground app to `bundleId`. The command handler calls
    /// this after state-changing operations (launch, terminate, go-home).
    func switchForegroundApp(bundleId: String)

    /// The current lifecycle state of the app with the given bundle id.
    func getAppState(bundleId: String) -> ObservedAppState

    /// Wait for `bundleId` to reach `expectedState`. Bounded polling: up to 10 attempts at
    /// 50ms intervals. Returns `true` if reached, `false` on timeout.
    func awaitAppState(bundleId: String, expectedState: AppStateExpectation) -> Bool

    /// Bundle id of the currently tracked foreground app, or `nil` if none has been set.
    var foregroundBundleId: String? { get }
}
