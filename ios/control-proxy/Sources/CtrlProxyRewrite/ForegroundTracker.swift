import Foundation

/// The locator's foreground-app tracking state: the tracked app reference, its bundle id,
/// the observed-bundle-id set, the SpringBoard-fallback flag, the last-explicit-switch
/// timestamp, and the last system-app-sweep miss (issue #5474).
///
/// The reference type was a lock-guarded `final class` because these fields were read and
/// written from both the server queue and the main-thread poll (issue #3614). In the rewrite
/// the locator is `@MainActor`, so this state lives on the main actor as a plain value: a
/// `struct` the locator holds by `var`. There is no second isolation domain to tear against,
/// so the lock is gone — mutation happens through `mutating` methods on the main actor.
///
/// The app reference is stored as `AnyObject?` so this type stays free of the iOS-only
/// `XCUIApplication` (and thus host-compilable and host-testable); the locator casts it back
/// on use.
struct ForegroundTracker {
    private(set) var app: AnyObject?
    private(set) var bundleId: String?
    private(set) var observedBundleIds: Set<String> = []
    var didFallbackToSpringboard = false
    private(set) var lastSwitchTime: UInt64 = 0

    /// Timestamp (uptime nanos) of the last last-resort `checkSystemApps` sweep that found no
    /// foreground system app. Used to briefly cache the negative result so repeated extractions
    /// do not each fan out to ~40 state IPCs (issue #5474). Reset to 0 on any explicit switch.
    var lastSystemAppSweepMiss: UInt64 = 0

    mutating func trackObserved(_ bundleId: String) {
        observedBundleIds.insert(bundleId)
    }

    /// Set the tracked app and bundle id together, optionally recording the bundle id as observed.
    mutating func setApplication(_ app: AnyObject?, bundleId: String?, observe: Bool) {
        self.app = app
        self.bundleId = bundleId
        if observe, let bundleId {
            observedBundleIds.insert(bundleId)
        }
    }

    /// Switch the tracked foreground app, returning the previous bundle id. Resets the
    /// SpringBoard-fallback flag, stamps the switch time, and invalidates the cached
    /// "no system app is foreground" result (issue #5474).
    mutating func switchForeground(app: AnyObject?, bundleId: String, observe: Bool, now: UInt64) -> String? {
        let previous = self.bundleId
        self.app = app
        self.bundleId = bundleId
        didFallbackToSpringboard = false
        lastSwitchTime = now
        lastSystemAppSweepMiss = 0
        if observe {
            observedBundleIds.insert(bundleId)
        }
        return previous
    }
}
