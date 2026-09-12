import Foundation
import os

/// Thread-safe cache holding the latest SDK view hierarchy received from the target app.
/// Updated when the SDK POSTs hierarchy events via `/sdk-events`. Ported from the
/// reference `SdkHierarchyCache.swift`.
///
/// Rewrite archetype: a **lock-confined `Sendable`** collection (like `SdkEventBuffer`).
/// The reference guarded a `var _latest` with an `NSLock` and was `@unchecked Sendable`;
/// this holds an `OSAllocatedUnfairLock<SdkViewHierarchy?>` (itself `Sendable`, over
/// `Sendable` state), so the cache is `Sendable` with **no `@unchecked`**.
///
/// Lock-confinement (rather than the actor the phase plan first proposed) is deliberate:
/// the write path — `POST /sdk-events` → `SdkHierarchyExtractor` → `update` → the
/// hierarchy-refresh broadcast — runs synchronously and in-order on the connection's
/// serial queue, and an `actor` could only be reached from that sync closure via a
/// detached `Task`, which would reorder cache updates across rapid POSTs (caching a stale
/// hierarchy) and move JSON decode off the serial queue — a *new* ordering hazard. A lock
/// keeps that path synchronous and ordered while still closing race #2.
///
/// **Race #2 (lost-update / dropped-event TOCTOU)** is closed by `reconcile`: the
/// reference's callers read `latest`, compared bundle ids, then called `clear()` as three
/// separate lock acquisitions, so a `POST /sdk-events` `update` landing between the read
/// and the clear was silently dropped. `reconcile` performs read → compare → clear inside
/// a single `withLock`, so no concurrent `update` can be lost.
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
