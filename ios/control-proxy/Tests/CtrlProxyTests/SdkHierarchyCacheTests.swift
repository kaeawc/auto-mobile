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
}
