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

    func testSetCtrlProxyUrlUpdatesValue() {
        let broadcaster = SdkEventBroadcaster.makeTestInstance()
        let url = URL(string: "http://localhost:9999/sdk-events")
        broadcaster.setCtrlProxyUrl(url)
        #if DEBUG
        XCTAssertEqual(broadcaster.ctrlProxyUrl, url)
        #endif
    }
}
