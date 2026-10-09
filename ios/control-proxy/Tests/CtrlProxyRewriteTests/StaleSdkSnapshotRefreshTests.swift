import XCTest

@testable import CtrlProxyRewrite

/// #10858: after in-app navigation no SDK event reaches the runner, so the cached snapshot
/// predates the XCUITest capture it is merged into and must be re-fetched.
private actor FreshFetchSdkClient: SdkHierarchyFetching {
    private var freshFetches = 0
    private let freshTimestamp: Int64

    init(freshTimestamp: Int64) { self.freshTimestamp = freshTimestamp }

    func freshFetchCount() -> Int { freshFetches }
    func fetchHierarchy() async -> SdkViewHierarchy? { nil }
    func fetchFreshHierarchy() async -> SdkViewHierarchy? {
        freshFetches += 1
        return SdkViewHierarchy(
            timestamp: freshTimestamp, bundleId: "com.example.app", screenScale: 3,
            screenWidth: 393, screenHeight: 852, root: nil
        )
    }

    func fetchServerInfo() async -> SdkHierarchyServerInfo? {
        SdkHierarchyServerInfo(status: "ok", bundleId: "com.example.app")
    }

    func isAvailable() async -> Bool { true }
    func setMockRules(_: [NetworkMockRuleDTO]) async -> Bool { false }
    func setNetworkFaultRules(_: [NetworkFaultRuleDTO]) async -> Bool { false }
    func setNetworkErrorSimulation(_: NetworkErrorSimulationDTO) async -> Bool { false }
    func addHighlight(id _: String, shape _: HighlightShape) async -> SdkHighlightOutcome { .unavailable }
}

@MainActor
final class StaleSdkSnapshotRefreshTests: XCTestCase {
    func testDecisionProbesAgainWhenSameAppCacheIsStale() {
        XCTAssertEqual(
            SdkHierarchyProbeDecision.decide(
                foregroundBundleId: "com.example.app", cachedBundleId: "com.example.app",
                appState: .runningForeground, cacheIsFresh: false
            ), .probe
        )
        XCTAssertEqual(
            SdkHierarchyProbeDecision.decide(
                foregroundBundleId: "com.example.app", cachedBundleId: "com.example.app",
                appState: .runningForeground, cacheIsFresh: true
            ), .skip
        )
    }

    func testStaleCacheNeverOutlivesALeftForegroundApp() {
        for fresh in [true, false] {
            XCTAssertEqual(
                SdkHierarchyProbeDecision.decide(
                    foregroundBundleId: "com.example.app", cachedBundleId: "com.example.app",
                    appState: .runningBackground, cacheIsFresh: fresh
                ), .clear
            )
            XCTAssertEqual(
                SdkHierarchyProbeDecision.decide(
                    foregroundBundleId: "com.example.app", cachedBundleId: "com.example.other",
                    appState: .runningForeground, cacheIsFresh: fresh
                ), .clear
            )
        }
    }

    func testFreshnessComparesSnapshotStampToCapture() {
        XCTAssertTrue(SdkHierarchyProbeDecision.isFresh(cachedTimestamp: nil, captureTimestamp: 100))
        XCTAssertTrue(SdkHierarchyProbeDecision.isFresh(cachedTimestamp: 100, captureTimestamp: 100))
        XCTAssertTrue(SdkHierarchyProbeDecision.isFresh(cachedTimestamp: 101, captureTimestamp: 100))
        XCTAssertFalse(SdkHierarchyProbeDecision.isFresh(cachedTimestamp: 99, captureTimestamp: 100))
    }

    func testRequestHierarchyRefetchesSnapshotOlderThanTheCapture() async {
        let sdk = FreshFetchSdkClient(freshTimestamp: 2000)
        let cache = SdkHierarchyCache()
        let locator = RewriteFakeElementLocator()
        locator.appState = .runningForeground
        let handler = CommandHandler(
            elementLocator: locator, gesturePerformer: RewriteFakeGesturePerformer(),
            perf: PerfProvider(), sdkHierarchyClient: sdk, sdkHierarchyCache: cache
        )
        cache.update(snapshot(timestamp: 1))

        _ = await handler.enrichWithMatchingSdkHierarchy(capture(updatedAt: 1000))

        let fetches = await sdk.freshFetchCount()
        XCTAssertEqual(fetches, 1)
        XCTAssertEqual(cache.latest?.timestamp, 2000)
    }

    func testRequestHierarchyKeepsSnapshotNewerThanTheCapture() async {
        let sdk = FreshFetchSdkClient(freshTimestamp: 2000)
        let cache = SdkHierarchyCache()
        let locator = RewriteFakeElementLocator()
        locator.appState = .runningForeground
        let handler = CommandHandler(
            elementLocator: locator, gesturePerformer: RewriteFakeGesturePerformer(),
            perf: PerfProvider(), sdkHierarchyClient: sdk, sdkHierarchyCache: cache
        )
        cache.update(snapshot(timestamp: 1500))

        _ = await handler.enrichWithMatchingSdkHierarchy(capture(updatedAt: 1000))

        let fetches = await sdk.freshFetchCount()
        XCTAssertEqual(fetches, 0)
        XCTAssertEqual(cache.latest?.timestamp, 1500)
    }

    private func snapshot(timestamp: Int64) -> SdkViewHierarchy {
        SdkViewHierarchy(
            timestamp: timestamp, bundleId: "com.example.app", screenScale: 3,
            screenWidth: 393, screenHeight: 852, root: nil
        )
    }

    private func capture(updatedAt: Int64) -> ViewHierarchy {
        ViewHierarchy(
            updatedAt: updatedAt,
            packageName: "com.example.app",
            hierarchy: UIElementInfo(
                text: "Root", className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 393, bottom: 852)
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
    }
}

final class GestureApplicationTargetTests: XCTestCase {
    func testKeepsPinnedAppWhenTrackedForegroundMatches() {
        XCTAssertEqual(
            GestureApplicationTarget.resolve(pinnedBundleId: "com.a", trackedBundleId: "com.a"), .keepPinned
        )
    }

    func testRebindsWhenSimctlLaunchMovedTheForegroundApp() {
        XCTAssertEqual(
            GestureApplicationTarget.resolve(pinnedBundleId: "com.a", trackedBundleId: "com.b"),
            .rebind(bundleId: "com.b")
        )
    }

    func testRebindsWhenNothingWasPinnedYet() {
        XCTAssertEqual(
            GestureApplicationTarget.resolve(pinnedBundleId: nil, trackedBundleId: "com.b"),
            .rebind(bundleId: "com.b")
        )
    }

    func testKeepsPinnedAppWhenNoForegroundIsTracked() {
        for tracked in [nil, "", "  "] as [String?] {
            XCTAssertEqual(
                GestureApplicationTarget.resolve(pinnedBundleId: "com.a", trackedBundleId: tracked), .keepPinned
            )
        }
    }
}
