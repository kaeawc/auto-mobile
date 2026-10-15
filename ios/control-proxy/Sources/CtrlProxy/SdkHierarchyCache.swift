import Foundation
import os

public final class SdkHierarchyCache: SdkHierarchyCaching, Sendable {
    private let state = OSAllocatedUnfairLock<SdkViewHierarchy?>(initialState: nil)

    public init() {}

    public var latest: SdkViewHierarchy? {
        state.withLock { $0 }
    }

    public func update(_ hierarchy: SdkViewHierarchy) {
        state.withLock { $0 = hierarchy }
    }

    public func clear() {
        state.withLock { $0 = nil }
    }

    public func reconcile(matchingBundleId foregroundBundleId: String) -> SdkViewHierarchy? {
        state.withLock { latest in
            guard let cached = latest else { return nil }
            if BundleId.normalized(cached.bundleId) == foregroundBundleId {
                return cached
            }
            // Mismatch: the cached hierarchy belongs to a different app. Clear it in the
            // same critical section so a concurrent `update` cannot be lost (race #2).
            latest = nil
            return nil
        }
    }
}
