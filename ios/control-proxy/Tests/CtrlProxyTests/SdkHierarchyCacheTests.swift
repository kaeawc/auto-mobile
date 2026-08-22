import XCTest
@testable import CtrlProxy

final class SdkHierarchyCacheTests: XCTestCase {

    private func makeSdkHierarchy(timestamp: Int64 = 1000) -> SdkViewHierarchy {
        SdkViewHierarchy(
            timestamp: timestamp,
            bundleId: "com.test.app",
            screenScale: 3.0,
            screenWidth: 375,
            screenHeight: 812,
            root: SdkViewNode(
                className: "UIView",
                bounds: SdkBounds(left: 0, top: 0, right: 375, bottom: 812)
            )
        )
    }

    // MARK: - Basic Operations

    func testInitiallyNil() {
        let cache = SdkHierarchyCache()
        XCTAssertNil(cache.latest)
    }

    func testUpdateAndRetrieve() {
        let cache = SdkHierarchyCache()
        let hierarchy = makeSdkHierarchy()

        cache.update(hierarchy)

        XCTAssertNotNil(cache.latest)
        XCTAssertEqual(cache.latest?.timestamp, 1000)
        XCTAssertEqual(cache.latest?.bundleId, "com.test.app")
    }

    func testUpdateReplacesLatest() {
        let cache = SdkHierarchyCache()
        cache.update(makeSdkHierarchy(timestamp: 1000))
        cache.update(makeSdkHierarchy(timestamp: 2000))

        XCTAssertEqual(cache.latest?.timestamp, 2000)
    }

    func testClearResetsToNil() {
        let cache = SdkHierarchyCache()
        cache.update(makeSdkHierarchy())

        cache.clear()

        XCTAssertNil(cache.latest)
    }

    // MARK: - Thread Safety

    func testConcurrentAccess() {
        let cache = SdkHierarchyCache()
        let group = DispatchGroup()
        let iterations = 100

        for i in 0..<iterations {
            group.enter()
            DispatchQueue.global().async {
                cache.update(self.makeSdkHierarchy(timestamp: Int64(i)))
                _ = cache.latest
                group.leave()
            }
        }

        group.wait()
        // No crash = thread-safe. Latest should be some valid value.
        // Can't assert exact value due to race, but it should not be nil.
        XCTAssertNotNil(cache.latest)
    }

    // MARK: - Extractor

    func testExtractorWithInvalidData() {
        let cache = SdkHierarchyCache()

        SdkHierarchyExtractor.extractIfPresent(from: Data("not json".utf8), into: cache)

        XCTAssertNil(cache.latest)
    }

    private func makeHierarchyEventBatch(timestamp: Int64) throws -> Data {
        let hierarchy = makeSdkHierarchy(timestamp: timestamp)
        let payload = try JSONEncoder().encode(["hierarchy": hierarchy])
        return Data(
            """
            {"events":[{"eventType":"view_hierarchy","payload":"\(payload.base64EncodedString())"}]}
            """.utf8
        )
    }

    func testBatchContainingViewHierarchyStillDecodes() throws {
        let cache = SdkHierarchyCache()
        let batch = try makeHierarchyEventBatch(timestamp: 4242)

        SdkHierarchyExtractor.extractIfPresent(from: batch, into: cache)

        XCTAssertEqual(cache.latest?.timestamp, 4242)
    }

    func testBatchWithoutViewHierarchyIsSkipped() {
        let cache = SdkHierarchyCache()
        // Well-formed batch whose only event is a non-hierarchy type: the raw-byte
        // scan must not find "view_hierarchy" and must skip the decode entirely.
        let batch = Data(
            """
            {"events":[{"eventType":"lifecycle","payload":"\(Data("{}".utf8).base64EncodedString())"}]}
            """.utf8
        )

        SdkHierarchyExtractor.extractIfPresent(from: batch, into: cache)

        XCTAssertNil(cache.latest)
    }

    func testHierarchyEventBroadcastsFreshChromeForUnchangedXcuitestHierarchy() throws {
        let cache = SdkHierarchyCache()
        let xcuitest = ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812)
            ),
            insets: .unavailable
        )
        var broadcasts: [ViewHierarchy] = []
        let publisher = SdkHierarchyRefreshPublisher(
            hierarchyProvider: { xcuitest },
            enrich: { HierarchyMerger.merge(xcuitest: $0, sdk: cache.latest) },
            broadcast: { broadcasts.append($0) }
        )
        let hierarchy = SdkViewHierarchy(
            timestamp: 1000,
            bundleId: "com.test.app",
            screenScale: 3,
            screenWidth: 375,
            screenHeight: 812,
            systemChrome: SdkSystemChrome(
                visibility: "hidden",
                statusBar: "hidden",
                homeIndicatorAutoHideRequested: true,
                source: "ios-status-bar-manager"
            ),
            root: nil
        )
        let payload = try JSONEncoder().encode(["hierarchy": hierarchy])
        let batch = Data(
            """
            {"events":[{"eventType":"view_hierarchy","payload":"\(payload.base64EncodedString())"}]}
            """.utf8
        )

        SdkHierarchyExtractor.extractIfPresent(
            from: batch,
            into: cache,
            onHierarchyUpdated: publisher.publish
        )

        XCTAssertEqual(broadcasts.count, 1)
        XCTAssertFalse(broadcasts[0].insets.available)
        XCTAssertEqual(broadcasts[0].insets.systemChrome?.visibility, "hidden")
    }
}
