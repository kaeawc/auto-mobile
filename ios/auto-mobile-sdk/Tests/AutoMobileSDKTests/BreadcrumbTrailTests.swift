// swiftlint:disable force_unwrapping
// Force-unwrap is idiomatic in test fixtures (fail fast on bad setup); disabled file-wide.

import XCTest
@testable import AutoMobileSDK

final class BreadcrumbTrailTests: XCTestCase {

    func testAddAndSnapshot() {
        let trail = BreadcrumbTrail(maxSize: 10)
        trail.add(Breadcrumb(category: .navigation, message: "HomeScreen"))
        trail.add(Breadcrumb(category: .tap, message: "Button tapped"))

        let crumbs = trail.snapshot()
        XCTAssertEqual(crumbs.count, 2)
        XCTAssertEqual(crumbs[0].category, .navigation)
        XCTAssertEqual(crumbs[0].message, "HomeScreen")
        XCTAssertEqual(crumbs[1].category, .tap)
        XCTAssertEqual(crumbs[1].message, "Button tapped")
    }

    func testRingBufferOverflow() {
        let maxSize = 5
        let trail = BreadcrumbTrail(maxSize: maxSize)

        for i in 0..<(maxSize + 10) {
            trail.add(Breadcrumb(category: .custom, message: "msg-\(i)"))
        }

        let crumbs = trail.snapshot()
        XCTAssertEqual(crumbs.count, maxSize)
        // Only the last `maxSize` items should remain
        XCTAssertEqual(crumbs.first?.message, "msg-10")
        XCTAssertEqual(crumbs.last?.message, "msg-14")
    }

    func testClearEmpties() {
        let trail = BreadcrumbTrail(maxSize: 10)
        trail.add(Breadcrumb(category: .log, message: "hello"))
        XCTAssertEqual(trail.snapshot().count, 1)

        trail.clear()
        XCTAssertTrue(trail.snapshot().isEmpty)
    }

    func testSnapshotIsACopy() {
        let trail = BreadcrumbTrail(maxSize: 10)
        trail.add(Breadcrumb(category: .lifecycle, message: "foreground"))

        let snap1 = trail.snapshot()
        trail.add(Breadcrumb(category: .lifecycle, message: "background"))
        let snap2 = trail.snapshot()

        XCTAssertEqual(snap1.count, 1)
        XCTAssertEqual(snap2.count, 2)
    }

    func testThreadSafetyConcurrentAdds() {
        let trail = BreadcrumbTrail(maxSize: 200)
        let iterations = 100
        let group = DispatchGroup()

        for i in 0..<iterations {
            group.enter()
            DispatchQueue.global().async {
                trail.add(Breadcrumb(category: .custom, message: "concurrent-\(i)"))
                group.leave()
            }
        }

        group.wait()
        XCTAssertEqual(trail.snapshot().count, iterations)
    }

    func testMetadataPreserved() {
        let trail = BreadcrumbTrail(maxSize: 10)
        let meta = ["key": "value", "screen": "home"]
        trail.add(Breadcrumb(category: .network, message: "GET /api", metadata: meta))

        let crumb = trail.snapshot().first!
        XCTAssertEqual(crumb.metadata["key"], "value")
        XCTAssertEqual(crumb.metadata["screen"], "home")
    }

    // MARK: - Disk Persistence

    func testWriteAndLoadFromDisk() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let trail = BreadcrumbTrail(maxSize: 10)
        trail.add(Breadcrumb(timestamp: 1000, category: .navigation, message: "Screen1"))
        trail.add(Breadcrumb(timestamp: 2000, category: .tap, message: "Button"))
        trail.writeToDisk(directory: tmpDir)

        let loaded = BreadcrumbTrail.loadFromDisk(directory: tmpDir)
        XCTAssertNotNil(loaded)
        XCTAssertEqual(loaded?.count, 2)
        XCTAssertEqual(loaded?[0].message, "Screen1")
        XCTAssertEqual(loaded?[1].message, "Button")
    }

    func testClearDisk() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let trail = BreadcrumbTrail(maxSize: 10)
        trail.add(Breadcrumb(category: .log, message: "test"))
        trail.writeToDisk(directory: tmpDir)

        BreadcrumbTrail.clearDisk(directory: tmpDir)
        XCTAssertNil(BreadcrumbTrail.loadFromDisk(directory: tmpDir))
    }

    func testLoadFromDiskReturnsNilWhenNoFile() {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        XCTAssertNil(BreadcrumbTrail.loadFromDisk(directory: tmpDir))
    }
}
