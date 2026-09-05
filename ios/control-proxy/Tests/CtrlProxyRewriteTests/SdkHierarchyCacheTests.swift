@testable import CtrlProxyRewrite
import XCTest

/// Behavior tests for the lock-confined `SdkHierarchyCache` and its transactional
/// `reconcile` (Phase 3), which closes race #2. The atomicity that closes the race can't
/// be forced deterministically in a unit test, so these pin the compare/clear SEMANTICS
/// that `reconcile` performs as one step; the atomicity is guaranteed by the single
/// `withLock` around read → compare → clear (see `SdkHierarchyCache`).
final class SdkHierarchyCacheTests: XCTestCase {
    private func hierarchy(bundleId: String?, timestamp: Int64 = 1) -> SdkViewHierarchy {
        SdkViewHierarchy(
            timestamp: timestamp,
            bundleId: bundleId,
            screenScale: 3,
            screenWidth: 393,
            screenHeight: 852,
            root: nil
        )
    }

    func testUpdateThenLatestReturnsIt() {
        let cache = SdkHierarchyCache()
        XCTAssertNil(cache.latest)
        cache.update(hierarchy(bundleId: "com.example.app", timestamp: 7))
        XCTAssertEqual(cache.latest?.timestamp, 7)
        XCTAssertEqual(cache.latest?.bundleId, "com.example.app")
    }

    func testClearEmptiesCache() {
        let cache = SdkHierarchyCache()
        cache.update(hierarchy(bundleId: "com.example.app"))
        cache.clear()
        XCTAssertNil(cache.latest)
    }

    func testReconcileReturnsCachedWhenBundleMatches() {
        let cache = SdkHierarchyCache()
        cache.update(hierarchy(bundleId: "com.example.app", timestamp: 9))
        let result = cache.reconcile(matchingBundleId: "com.example.app")
        XCTAssertEqual(result?.timestamp, 9)
        // A match must NOT clear the cache.
        XCTAssertNotNil(cache.latest)
    }

    func testReconcileNormalizesCachedBundleId() {
        let cache = SdkHierarchyCache()
        cache.update(hierarchy(bundleId: "  com.example.app\n"))
        // The foreground id is already normalized by the caller; the cached side is
        // normalized inside reconcile, so surrounding whitespace still matches.
        XCTAssertNotNil(cache.reconcile(matchingBundleId: "com.example.app"))
    }

    func testReconcileClearsAndReturnsNilOnMismatch() {
        let cache = SdkHierarchyCache()
        cache.update(hierarchy(bundleId: "com.other.app"))
        let result = cache.reconcile(matchingBundleId: "com.example.app")
        XCTAssertNil(result)
        // A mismatch clears the cache in the same critical section (race #2).
        XCTAssertNil(cache.latest)
    }

    func testReconcileClearsWhenCachedBundleIdIsBlank() {
        let cache = SdkHierarchyCache()
        cache.update(hierarchy(bundleId: "   "))
        // A blank cached bundle id normalizes to nil, which never equals a real id.
        XCTAssertNil(cache.reconcile(matchingBundleId: "com.example.app"))
        XCTAssertNil(cache.latest)
    }

    func testReconcileOnEmptyCacheReturnsNilWithoutSideEffect() {
        let cache = SdkHierarchyCache()
        XCTAssertNil(cache.reconcile(matchingBundleId: "com.example.app"))
        XCTAssertNil(cache.latest)
    }

    func testUsableThroughSendableExistential() {
        // Compile-time: the cache is usable as the Sendable protocol a Phase-6
        // CommandHandler will hold, with synchronous (no-await) methods.
        let cache: any SdkHierarchyCaching = SdkHierarchyCache()
        cache.update(hierarchy(bundleId: "com.example.app"))
        XCTAssertNotNil(cache.reconcile(matchingBundleId: "com.example.app"))
    }
}
