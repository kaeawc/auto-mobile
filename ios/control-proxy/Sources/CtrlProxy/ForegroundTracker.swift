import Foundation

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
