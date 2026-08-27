import Foundation
import XCTest

/// Differential parity for `SdkHierarchyExtractor` (Phase 3): given the same
/// `POST /sdk-events` batch, the reference and rewrite extract the same hierarchy into the
/// cache (or leave it empty) and fire the update callback the same way. Exercises the raw
/// batch envelope decode, the base64 `payload` → `SdkViewHierarchy` decode, and the
/// fast-path byte scan.
final class SdkHierarchyExtractorParityTests: XCTestCase {
    /// A batch carrying one `view_hierarchy` event whose base64 payload wraps a
    /// `SdkViewHierarchy` under a `hierarchy` key.
    private func hierarchyBatch(bundleId: String = "com.example.app") -> Data {
        let payloadJSON = """
        {"hierarchy":{"timestamp":9,"bundleId":"\(bundleId)","screenScale":3,"screenWidth":393,"screenHeight":852}}
        """
        let payloadBase64 = Data(payloadJSON.utf8).base64EncodedString()
        let batch = """
        {"bundleId":null,"events":[{"eventType":"view_hierarchy","payload":"\(payloadBase64)"}]}
        """
        return Data(batch.utf8)
    }

    func testExtractsHierarchyIdenticallyAndFiresCallback() {
        let batch = hierarchyBatch()
        let reference = ReferenceSdkHierarchy.extract(from: batch)
        let rewrite = RewriteSdkHierarchy.extract(from: batch)

        XCTAssertNotNil(rewrite.latestEncoded, "rewrite should have cached a hierarchy")
        XCTAssertEqual(reference.latestEncoded, rewrite.latestEncoded, "extracted hierarchy bytes diverged")
        XCTAssertTrue(rewrite.fired, "onHierarchyUpdated should fire after a hierarchy batch")
        XCTAssertEqual(reference.fired, rewrite.fired)
    }

    func testNonHierarchyBatchLeavesCacheEmptyInBoth() {
        // A batch with no `view_hierarchy` marker — the fast-path byte scan skips decode.
        let logPayload = Data(#"{"message":"hello"}"#.utf8).base64EncodedString()
        let batch = Data(#"{"bundleId":null,"events":[{"eventType":"log","payload":"\#(logPayload)"}]}"#.utf8)
        let reference = ReferenceSdkHierarchy.extract(from: batch)
        let rewrite = RewriteSdkHierarchy.extract(from: batch)
        XCTAssertNil(rewrite.latestEncoded)
        XCTAssertNil(reference.latestEncoded)
        XCTAssertFalse(rewrite.fired)
        XCTAssertFalse(reference.fired)
    }

    func testMalformedBatchWithMarkerLeavesCacheEmptyInBoth() {
        // Contains the `view_hierarchy` marker (passes the fast-path scan) but is not valid
        // JSON, so the decode guard must leave the cache untouched in both modules.
        let batch = Data("view_hierarchy but not json".utf8)
        let reference = ReferenceSdkHierarchy.extract(from: batch)
        let rewrite = RewriteSdkHierarchy.extract(from: batch)
        XCTAssertNil(rewrite.latestEncoded)
        XCTAssertNil(reference.latestEncoded)
        XCTAssertFalse(rewrite.fired)
        XCTAssertFalse(reference.fired)
    }
}
