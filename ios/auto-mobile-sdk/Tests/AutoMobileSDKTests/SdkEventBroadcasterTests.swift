@testable import AutoMobileSDK
import XCTest

final class SdkEventBroadcasterTests: XCTestCase {
    /// Concurrent get/set of the CtrlProxy URL must not race. It was a plain
    /// `var` read on the flush thread while written from other threads (#3632).
    func testCtrlProxyUrlConcurrentAccessDoesNotCrash() {
        let broadcaster = SdkEventBroadcaster.makeTestInstance()
        DispatchQueue.concurrentPerform(iterations: 2_000) { i in
            broadcaster.ctrlProxyUrl = URL(string: "http://localhost:\(8000 + i % 100)/sdk-events")
            _ = broadcaster.ctrlProxyUrl
        }
        // Final value is one of the concurrently-set URLs; the point is no crash.
        XCTAssertNotNil(broadcaster.ctrlProxyUrl)
    }

    /// Concurrent get/set of `persistence` must not race. It was a plain `var` read
    /// on the flush thread and the URLSession completion handler while written from
    /// the config/shutdown threads (#3632) — now guarded by the same config lock.
    func testPersistenceConcurrentAccessDoesNotCrash() {
        let broadcaster = SdkEventBroadcaster.makeTestInstance()
        let fakes = (0..<8).map { _ in FakeEventPersistence() }
        DispatchQueue.concurrentPerform(iterations: 2_000) { i in
            broadcaster.persistence = fakes[i % fakes.count]
            _ = broadcaster.persistence
        }
        XCTAssertNotNil(broadcaster.persistence)
    }

    func testSetCtrlProxyUrlUpdatesValue() {
        let broadcaster = SdkEventBroadcaster.makeTestInstance()
        let url = URL(string: "http://localhost:9999/sdk-events")
        broadcaster.setCtrlProxyUrl(url)
        #if DEBUG
        XCTAssertEqual(broadcaster.ctrlProxyUrl, url)
        #endif
    }

    // MARK: - persist-only-when-a-sink-exists (#3636)

    /// With no async delivery sink, the batch must NOT be written to disk (delivery
    /// is a synchronous NotificationCenter post), avoiding a write-then-delete churn.
    func testDoesNotPersistWhenNoSink() {
        let broadcaster = SdkEventBroadcaster.makeTestInstance()
        let persistence = FakeEventPersistence()
        broadcaster.persistence = persistence
        broadcaster.ctrlProxyUrl = nil

        broadcaster.broadcastBatch(bundleId: "com.example", events: [SdkInteractionEvent(interactionType: "e1")])

        XCTAssertEqual(persistence.persistCallCount, 0)
        XCTAssertEqual(persistence.removeCallCount, 0)
    }

    /// With a sink configured, the batch is persisted (so an async-delivery failure
    /// can be replayed after a crash).
    func testPersistsWhenSinkConfigured() {
        let broadcaster = SdkEventBroadcaster.makeTestInstance()
        let persistence = FakeEventPersistence()
        broadcaster.persistence = persistence
        broadcaster.ctrlProxyUrl = URL(string: "http://localhost:1/sdk-events") // unused port; delivery fails fast

        broadcaster.broadcastBatch(bundleId: "com.example", events: [SdkInteractionEvent(interactionType: "e1")])

        XCTAssertEqual(persistence.persistCallCount, 1)
    }
}
