import XCTest
@testable import AutoMobileSDK

final class WebViewBridgeTests: XCTestCase {
    func testPolicyBoundsAndRedactsSnapshot() {
        let policy = AutoMobileWebViewPolicy(configuration: AutoMobileWebViewConfiguration(maxElements: 1))
        let snapshot = policy.accept(AutoMobileWebSnapshot(elements: [
            AutoMobileWebElement(id: "first", value: "secret"),
            AutoMobileWebElement(id: "second"),
        ]))

        XCTAssertEqual(snapshot.elements.count, 1)
        XCTAssertEqual(snapshot.elements[0].value, "[REDACTED]")
        XCTAssertTrue(policy.validates(.click(snapshotId: snapshot.snapshotId, elementId: "first")))
        XCTAssertFalse(policy.validates(.click(snapshotId: snapshot.snapshotId, elementId: "second")))
    }

    func testActionsRejectUnknownAndStaleSnapshots() {
        let policy = AutoMobileWebViewPolicy()
        let snapshot = policy.accept(AutoMobileWebSnapshot(elements: [
            AutoMobileWebElement(id: "button"),
        ]))

        XCTAssertTrue(policy.validates(.focus(snapshotId: snapshot.snapshotId, elementId: "button")))
        XCTAssertFalse(policy.validates(.focus(snapshotId: "stale", elementId: "button")))
        XCTAssertFalse(policy.validates(.evaluateJavaScript("document.body")))
    }

    func testOriginAndFrameAllowlist() {
        let policy = AutoMobileWebViewPolicy(configuration: AutoMobileWebViewConfiguration(
            allowedOrigins: ["https://example.test"],
            allowedFrames: ["https://example.test/"]
        ))

        XCTAssertTrue(policy.allows(url: URL(string: "https://example.test/page"), frameId: "https://example.test/"))
        XCTAssertFalse(policy.allows(url: URL(string: "https://other.test/page"), frameId: "https://example.test/"))
        XCTAssertFalse(policy.allows(url: URL(string: "https://example.test/page"), frameId: "other"))
        XCTAssertFalse(policy.allows(url: URL(string: "file:///tmp/page"), frameId: nil))
        XCTAssertFalse(AutoMobileWebViewPolicy().allows(url: URL(string: "https://example.test/page"), frameId: nil))
    }

    func testWebViewEventEncodesWireType() throws {
        let event = SdkWebViewEvent(webViewId: "web", name: "request_started", requestId: "req")
        let data = try JSONEncoder().encode(event)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["eventType"] as? String, "webview")
        XCTAssertEqual(object["requestId"] as? String, "req")
    }
}
