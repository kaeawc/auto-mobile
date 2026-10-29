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

    // MARK: - Bounded web actions (#5162)

    func testDecidedActionsValidateOnlyAgainstALiveSnapshot() {
        let policy = AutoMobileWebViewPolicy()
        let snapshot = policy.accept(AutoMobileWebSnapshot(elements: [AutoMobileWebElement(id: "field")]))
        let id = snapshot.snapshotId
        for action in [
            AutoMobileWebAction.setValue(snapshotId: id, elementId: "field", text: "hi"),
            .clear(snapshotId: id, elementId: "field"),
            .scrollIntoView(snapshotId: id, elementId: "field"),
            .submit(snapshotId: id, elementId: "field"),
        ] {
            XCTAssertTrue(policy.validates(action), "\(action)")
        }
        XCTAssertFalse(policy.validates(.setValue(snapshotId: "stale", elementId: "field", text: "hi")))
        XCTAssertFalse(policy.validates(.submit(snapshotId: id, elementId: "missing")))
    }

    func testAPageControlledIdNeverBecomesScriptSource() throws {
        let hostile = #"x"]'); window.pwned = 1; //"#
        let actions: [AutoMobileWebAction] = [
            .click(snapshotId: "s", elementId: hostile),
            .focus(snapshotId: "s", elementId: hostile),
            .insertText(snapshotId: "s", elementId: hostile, text: "t"),
            .select(snapshotId: "s", elementId: hostile, value: "v"),
            .scroll(snapshotId: "s", elementId: hostile, x: 0, y: 10),
            .setValue(snapshotId: "s", elementId: hostile, text: #"'); window.pwned = 2; //"#),
            .clear(snapshotId: "s", elementId: hostile),
            .scrollIntoView(snapshotId: "s", elementId: hostile),
            .submit(snapshotId: "s", elementId: hostile),
        ]
        for action in actions {
            let source = try XCTUnwrap(AutoMobileWebActionScript.source(for: action))
            // Remove every JSON string literal the script embeds; nothing hostile may remain.
            var stripped = source.replacingOccurrences(of: AutoMobileWebActionScript.json(hostile), with: "ID")
            stripped = stripped.replacingOccurrences(
                of: AutoMobileWebActionScript.json(#"'); window.pwned = 2; //"#), with: "TEXT"
            )
            XCTAssertFalse(stripped.contains("pwned"), source)
            XCTAssertTrue(source.contains("CSS.escape(id)"), source)
        }
    }

    func testActionScriptsDoWhatTheDecisionSays() throws {
        let setValue = try XCTUnwrap(
            AutoMobileWebActionScript.source(for: .setValue(snapshotId: "s", elementId: "f", text: "hi"))
        )
        XCTAssertTrue(setValue.contains("e.focus();"))
        XCTAssertTrue(setValue.contains("new Event('input'"))
        XCTAssertTrue(setValue.contains("new Event('change'"))
        let clear = try XCTUnwrap(AutoMobileWebActionScript.source(for: .clear(snapshotId: "s", elementId: "f")))
        XCTAssertTrue(clear.contains("e.value='';"))
        let submit = try XCTUnwrap(AutoMobileWebActionScript.source(for: .submit(snapshotId: "s", elementId: "f")))
        XCTAssertTrue(submit.contains("requestSubmit"))
        let scroll = try XCTUnwrap(
            AutoMobileWebActionScript.source(for: .scrollIntoView(snapshotId: "s", elementId: "f"))
        )
        XCTAssertTrue(scroll.contains("scrollIntoView"))
        XCTAssertNil(AutoMobileWebActionScript.source(for: .evaluateJavaScript("document.body")))
    }

    func testDecidedActionsRoundTripThroughCodable() throws {
        for action in [
            AutoMobileWebAction.setValue(snapshotId: "s", elementId: "f", text: "hi"),
            .clear(snapshotId: "s", elementId: "f"),
            .scrollIntoView(snapshotId: "s", elementId: "f"),
            .submit(snapshotId: "s", elementId: "f"),
        ] {
            let decoded = try JSONDecoder().decode(AutoMobileWebAction.self, from: JSONEncoder().encode(action))
            XCTAssertEqual(decoded, action)
        }
    }

    func testWebViewEventEncodesWireType() throws {
        let event = SdkWebViewEvent(webViewId: "web", name: "request_started", requestId: "req")
        let data = try JSONEncoder().encode(event)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["eventType"] as? String, "webview")
        XCTAssertEqual(object["requestId"] as? String, "req")
    }
}
