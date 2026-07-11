import XCTest
@testable import AutoMobileSDK

final class ViewBodyTrackerTests: XCTestCase {
    override func tearDown() {
        ViewBodyTracker.shared.reset()
        super.tearDown()
    }

    func testDisabledByDefault() {
        XCTAssertFalse(ViewBodyTracker.shared.isEnabled)
    }

    func testRecordingWhenDisabledIsNoOp() {
        ViewBodyTracker.shared.recordBodyEvaluation(id: "test", viewName: "TestView")
        let snapshots = ViewBodyTracker.shared.getSnapshots()
        XCTAssertTrue(snapshots.isEmpty)
    }

    func testRecordBodyEvaluation() {
        let fakeTimer = FakeTimer()
        ViewBodyTracker.shared.setEnabled(true, timerFactory: { fakeTimer })

        ViewBodyTracker.shared.recordBodyEvaluation(id: "home", viewName: "HomeView")
        ViewBodyTracker.shared.recordBodyEvaluation(id: "home", viewName: "HomeView")
        ViewBodyTracker.shared.recordBodyEvaluation(id: "home", viewName: "HomeView")

        let snapshots = ViewBodyTracker.shared.getSnapshots()
        XCTAssertEqual(snapshots.count, 1)
        XCTAssertEqual(snapshots.first?.id, "home")
        XCTAssertEqual(snapshots.first?.viewName, "HomeView")
        XCTAssertEqual(snapshots.first?.totalCount, 3)
    }

    func testRecordDuration() {
        let fakeTimer = FakeTimer()
        ViewBodyTracker.shared.setEnabled(true, timerFactory: { fakeTimer })

        ViewBodyTracker.shared.recordBodyEvaluation(id: "view1", viewName: "View1")
        ViewBodyTracker.shared.recordDuration(id: "view1", durationMs: 10.0)
        ViewBodyTracker.shared.recordDuration(id: "view1", durationMs: 20.0)

        let snapshots = ViewBodyTracker.shared.getSnapshots()
        XCTAssertEqual(snapshots.first?.averageDurationMs, 15.0)
    }

    func testMultipleViews() {
        let fakeTimer = FakeTimer()
        ViewBodyTracker.shared.setEnabled(true, timerFactory: { fakeTimer })

        ViewBodyTracker.shared.recordBodyEvaluation(id: "a", viewName: "ViewA")
        ViewBodyTracker.shared.recordBodyEvaluation(id: "b", viewName: "ViewB")
        ViewBodyTracker.shared.recordBodyEvaluation(id: "a", viewName: "ViewA")

        let snapshots = ViewBodyTracker.shared.getSnapshots()
        XCTAssertEqual(snapshots.count, 2)

        let viewA = snapshots.first { $0.id == "a" }
        let viewB = snapshots.first { $0.id == "b" }
        XCTAssertEqual(viewA?.totalCount, 2)
        XCTAssertEqual(viewB?.totalCount, 1)
    }

    /// Per-instance ids (e.g. a long feed keyed by item uuid) must not grow the
    /// entries map without bound; the tracker caps it and evicts the
    /// least-recently-updated entries (issue #3624).
    func testEntriesAreBoundedAndEvictLeastRecentlyUpdated() {
        let dateProvider = FakeDateProvider(initialDate: Date(timeIntervalSince1970: 0))
        let buffer = SdkEventBuffer(maxBufferSize: 100, flushIntervalMs: 60000) { _ in }
        ViewBodyTracker.shared.initialize(buffer: buffer, dateProvider: dateProvider)
        ViewBodyTracker.shared.setEnabled(true, timerFactory: { FakeTimer() })

        // Record 600 distinct ids, each at a strictly later time so LRU order is
        // well defined. The cap is 512, so the map must stay bounded.
        let total = 600
        for i in 0..<total {
            ViewBodyTracker.shared.recordBodyEvaluation(id: "view-\(i)", viewName: "V")
            dateProvider.advance(by: 1.0)
        }

        let snapshots = ViewBodyTracker.shared.getSnapshots()
        let ids = Set(snapshots.map(\.id))

        XCTAssertLessThanOrEqual(snapshots.count, 512, "entries map must stay bounded")
        XCTAssertTrue(ids.contains("view-\(total - 1)"), "the most recent id must survive")
        XCTAssertFalse(ids.contains("view-0"), "the oldest id must have been evicted")
    }
}
