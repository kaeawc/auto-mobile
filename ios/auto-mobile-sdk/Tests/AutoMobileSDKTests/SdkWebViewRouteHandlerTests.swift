@testable import AutoMobileSDK
import AutoMobileSdkWire
import Foundation
import XCTest

#if DEBUG && !os(watchOS)
    private final class FakeWebView: AutoMobileWebViewControlling, @unchecked Sendable {
        let webViewId: String
        var latestSnapshot: AutoMobileWebSnapshot?
        var maxMessageBytes = 256 * 1024
        var originAllowed = true
        var contentProcessAvailable = true
        var result = AutoMobileWebActionResult(status: .accepted)
        private(set) var performed: [AutoMobileWebControlAction] = []

        init(webViewId: String, snapshot: AutoMobileWebSnapshot? = nil) {
            self.webViewId = webViewId
            latestSnapshot = snapshot
        }

        var bridgeEntry: WebViewBridgeEntry {
            WebViewBridgeEntry(
                webViewId: webViewId, url: "https://fixture.local/", allowedOrigins: ["https://fixture.local"],
                contentProcessAvailable: contentProcessAvailable
            )
        }

        func perform(_ action: AutoMobileWebControlAction) async -> AutoMobileWebActionResult {
            performed.append(action)
            return result
        }
    }

    /// #5162: the web-view routes serve registered bridges only and fail closed with typed errors.
    final class SdkWebViewRouteHandlerTests: XCTestCase {
        private let snapshot = AutoMobileWebSnapshot(
            snapshotId: "s1",
            url: "https://fixture.local/",
            elements: [AutoMobileWebElement(id: "submit", role: "button", label: "Submit", bounds: [1, 2, 3, 4])]
        )

        private func handler(_ webViews: FakeWebView...) -> SdkWebViewRouteHandler {
            let registry = AutoMobileWebViewRegistry()
            for webView in webViews {
                registry.register(controller: webView)
            }
            return SdkWebViewRouteHandler(registry: registry)
        }

        private func errorCode(_ response: SdkRouteResponse) throws -> String? {
            let object = try JSONSerialization.jsonObject(with: response.body) as? [String: Any]
            return object?["error"] as? String
        }

        private func actionBody(_ webViewId: String, _ action: AutoMobileWebControlAction) throws -> Data {
            try JSONEncoder().encode(AutoMobileWebActionRequest(webViewId: webViewId, action: action))
        }

        func testSnapshotServesTheFirstOrNamedWebView() throws {
            let other = FakeWebView(
                webViewId: "other", snapshot: AutoMobileWebSnapshot(snapshotId: "s2", elements: [])
            )
            let routes = handler(FakeWebView(webViewId: "main", snapshot: snapshot), other)
            let cases: [(Data?, String)] = [
                (nil, "main"), (Data("{}".utf8), "main"), (Data(#"{"webViewId":"other"}"#.utf8), "other"),
            ]
            for (body, expected) in cases {
                let response = routes.snapshot(body: body)
                XCTAssertEqual(response.statusCode, 200)
                let reply = try JSONDecoder().decode(AutoMobileWebSnapshotReply.self, from: response.body)
                XCTAssertEqual(reply.webViewId, expected)
            }
        }

        func testSnapshotFailuresAreTyped() throws {
            XCTAssertEqual(try errorCode(handler().snapshot(body: nil)), "bridge_not_registered")
            XCTAssertEqual(handler().snapshot(body: nil).statusCode, 503)

            let unknown = handler(FakeWebView(webViewId: "main", snapshot: snapshot))
                .snapshot(body: Data(#"{"webViewId":"nope"}"#.utf8))
            XCTAssertEqual(try errorCode(unknown), "bridge_not_registered")

            let dead = FakeWebView(webViewId: "main", snapshot: snapshot)
            dead.contentProcessAvailable = false
            XCTAssertEqual(handler(dead).snapshot(body: nil).statusCode, 410)
            XCTAssertEqual(try errorCode(handler(dead).snapshot(body: nil)), "web_process_unavailable")

            let foreign = FakeWebView(webViewId: "main", snapshot: snapshot)
            foreign.originAllowed = false
            XCTAssertEqual(handler(foreign).snapshot(body: nil).statusCode, 403)
            XCTAssertEqual(try errorCode(handler(foreign).snapshot(body: nil)), "disallowed_origin")

            XCTAssertEqual(try errorCode(handler(FakeWebView(webViewId: "main")).snapshot(body: nil)), "no_snapshot")

            let tiny = FakeWebView(webViewId: "main", snapshot: snapshot)
            tiny.maxMessageBytes = 8
            XCTAssertEqual(handler(tiny).snapshot(body: nil).statusCode, 413)
            XCTAssertEqual(try errorCode(handler(tiny).snapshot(body: nil)), "message_too_large")

            XCTAssertEqual(try errorCode(handler().snapshot(body: Data("[".utf8))), "bad_request")
        }

        func testActionReachesTheNamedWebViewAndReturnsItsResult() async throws {
            let webView = FakeWebView(webViewId: "main", snapshot: snapshot)
            webView.result = .rejected(AutoMobileWebActionResult.staleSnapshotReason)
            let action = AutoMobileWebControlAction.setValue(snapshotId: "s0", elementId: "q", text: "hi")
            let body = try actionBody("main", action)
            let response = await handler(webView).perform(body: body)
            XCTAssertEqual(response.statusCode, 200)
            let result = try JSONDecoder().decode(AutoMobileWebActionResult.self, from: response.body)
            XCTAssertEqual(result, .rejected("stale_snapshot"))
            XCTAssertEqual(webView.performed, [action])
        }

        func testArbitraryJavaScriptCannotBeExpressed() async throws {
            let webView = FakeWebView(webViewId: "main", snapshot: snapshot)
            let body = Data(#"{"webViewId":"main","action":{"evaluateJavaScript":{"_0":"alert(1)"}}}"#.utf8)
            let response = await handler(webView).perform(body: body)
            XCTAssertEqual(response.statusCode, 400)
            XCTAssertEqual(try errorCode(response), "bad_request")
            XCTAssertEqual(webView.performed, [])
        }

        func testActionFailuresAreTyped() async throws {
            let action = AutoMobileWebControlAction.click(snapshotId: "s1", elementId: "submit")
            let body = try actionBody("main", action)
            let missing = await handler().perform(body: body)
            XCTAssertEqual(missing.statusCode, 503)

            let tiny = FakeWebView(webViewId: "main", snapshot: snapshot)
            tiny.maxMessageBytes = 8
            let oversized = await handler(tiny).perform(body: body)
            XCTAssertEqual(oversized.statusCode, 413)
            XCTAssertEqual(tiny.performed, [])

            let empty = await handler(tiny).perform(body: nil)
            XCTAssertEqual(empty.statusCode, 400)
        }

        func testRegistryReportsWebViewsInRegistrationOrder() {
            let registry = AutoMobileWebViewRegistry()
            XCTAssertEqual(registry.state, .none)
            registry.register(controller: FakeWebView(webViewId: "b"))
            registry.register(controller: FakeWebView(webViewId: "a"))
            registry.register(controller: FakeWebView(webViewId: "b"))
            XCTAssertEqual(registry.state.webViews.map(\.webViewId), ["a", "b"])
            registry.unregister(webViewId: "a")
            XCTAssertEqual(registry.state.webViews.map(\.webViewId), ["b"])
            XCTAssertEqual(registry.controller(for: nil)?.webViewId, "b")
        }

        func testHealthCarriesTheWebViewState() throws {
            let registry = AutoMobileWebViewRegistry()
            registry.register(controller: FakeWebView(webViewId: "main"))
            let server = SdkHierarchyServer(tracker: HealthTracker(), webViewRegistry: registry)
            let payload = try XCTUnwrap(
                JSONSerialization.jsonObject(with: server.healthResponse().body) as? [String: Any]
            )
            let bridge = try XCTUnwrap(payload["webViewBridge"] as? [String: Any])
            let webViews = try XCTUnwrap(bridge["webViews"] as? [[String: Any]])
            XCTAssertEqual(webViews.first?["webViewId"] as? String, "main")
            XCTAssertEqual(webViews.first?["allowedOrigins"] as? [String], ["https://fixture.local"])
        }
    }

    private final class HealthTracker: SdkHierarchyServing {
        let bundleId: String? = "test.bundle"
        let isApplicationActive = true
        func getLatestHierarchy() -> SdkViewHierarchy? { nil }
        func walkNow() -> SdkViewHierarchy {
            SdkViewHierarchy(screenScale: 1, screenWidth: 0, screenHeight: 0, root: nil)
        }
    }
#endif

/// #5162: the policy names why a controller action may not run, and every controller action maps
/// to a bounded bridge action.
final class AutoMobileWebViewPolicyRejectionTests: XCTestCase {
    func testRejectionNamesStaleSnapshotsAndUnactionableElements() {
        let policy = AutoMobileWebViewPolicy(configuration: .init(allowedOrigins: ["https://fixture.local"]))
        _ = policy.accept(AutoMobileWebSnapshot(snapshotId: "s1", elements: [
            AutoMobileWebElement(id: "ok"),
            AutoMobileWebElement(id: "off", enabled: false),
            AutoMobileWebElement(id: "hidden", visible: false),
        ]))
        XCTAssertNil(policy.rejection(for: .click(snapshotId: "s1", elementId: "ok")))
        XCTAssertNil(policy.rejection(for: .scroll(snapshotId: "s1", elementId: nil, x: 0, y: 10)))
        XCTAssertEqual(policy.rejection(for: .click(snapshotId: "old", elementId: "ok")), "stale_snapshot")
        for id in ["off", "hidden", "missing"] {
            XCTAssertEqual(policy.rejection(for: .clear(snapshotId: "s1", elementId: id)), "element_not_actionable")
        }
        XCTAssertEqual(policy.latestSnapshot?.snapshotId, "s1")
    }

    func testRouteAccessChecksTheOriginEvenWithAFrameAllowlist() throws {
        let policy = AutoMobileWebViewPolicy(configuration: .init(
            allowedOrigins: ["https://fixture.local"], allowedFrames: ["https://fixture.local/frame"]
        ))
        let page = try XCTUnwrap(URL(string: "https://fixture.local/index.html"))
        XCTAssertTrue(policy.allowsOrigin(url: page))
        XCTAssertFalse(policy.allowsOrigin(url: URL(string: "https://other.local/")))
        // Messages still need an allowed frame.
        XCTAssertTrue(policy.allows(url: page, frameId: "https://fixture.local/frame"))
        XCTAssertFalse(policy.allows(url: page, frameId: "https://fixture.local/other"))
        XCTAssertFalse(policy.allows(url: page, frameId: nil))
    }

    func testTerminationForgetsSnapshotsSoNoneIsServedOrActedOn() {
        let policy = AutoMobileWebViewPolicy(configuration: .init(allowedOrigins: ["https://fixture.local"]))
        _ = policy.accept(AutoMobileWebSnapshot(snapshotId: "s1", elements: [AutoMobileWebElement(id: "ok")]))
        policy.forgetSnapshots()
        XCTAssertNil(policy.latestSnapshot)
        XCTAssertEqual(policy.rejection(for: .click(snapshotId: "s1", elementId: "ok")), "stale_snapshot")
    }

    func testOnlyALoadRestoresATerminatedProcess() throws {
        let page = try XCTUnwrap(URL(string: "https://fixture.local/"))
        var state = AutoMobileWebPageState()
        state.attached(url: page)
        XCTAssertTrue(state.contentProcessAvailable)
        state.terminated(url: nil)
        // Reattaching before the reload must not advertise a live process.
        state.attached(url: page)
        XCTAssertFalse(state.contentProcessAvailable)
        XCTAssertEqual(state.url, page)
        state.loaded(url: nil)
        XCTAssertTrue(state.contentProcessAvailable)
        XCTAssertEqual(state.url, page)
    }

    func testLatestSnapshotIsTheRedactedOne() {
        let policy = AutoMobileWebViewPolicy(configuration: .init(redactText: true))
        _ = policy.accept(AutoMobileWebSnapshot(
            snapshotId: "s1",
            elements: [AutoMobileWebElement(id: "pw", value: "secret")]
        ))
        XCTAssertEqual(policy.latestSnapshot?.elements.first?.value, "[REDACTED]")
    }

    func testEveryControllerActionMapsToABoundedScript() {
        let actions: [AutoMobileWebControlAction] = [
            .click(snapshotId: "s", elementId: "e"), .focus(snapshotId: "s", elementId: "e"),
            .insertText(snapshotId: "s", elementId: "e", text: "t"),
            .select(snapshotId: "s", elementId: "e", value: "v"),
            .scroll(snapshotId: "s", elementId: nil, x: 0, y: 1), .setValue(snapshotId: "s", elementId: "e", text: "t"),
            .clear(snapshotId: "s", elementId: "e"), .scrollIntoView(snapshotId: "s", elementId: "e"),
            .submit(snapshotId: "s", elementId: "e"),
        ]
        for action in actions {
            XCTAssertNotNil(AutoMobileWebActionScript.source(for: AutoMobileWebAction(action)), "\(action)")
        }
    }

    func testAnActionOnAMissingElementThrowsInsteadOfDoingNothing() throws {
        let source = try XCTUnwrap(AutoMobileWebActionScript.source(for: .click(snapshotId: "s", elementId: "e0")))
        XCTAssertTrue(source.contains("if (!e) { throw new Error("), source)
        XCTAssertFalse(source.contains("if (!e) { return; }"), source)
    }
}

#if canImport(WebKit)
    /// Bridge behavior that needs no WKWebView attached (#15868).
    @MainActor
    final class AutoMobileWebViewBridgeLifecycleTests: XCTestCase {
        private func bridge() -> AutoMobileWebViewBridge {
            AutoMobileWebViewBridge(
                configuration: .init(allowedOrigins: ["https://fixture.local"]),
                emitEvent: { _ in }
            )
        }

        func testACommittedNavigationDropsTheOldDocumentsSnapshots() throws {
            let bridge = bridge()
            try bridge.documentCommitted(url: XCTUnwrap(URL(string: "https://fixture.local/a")))
            _ = bridge.policy.accept(AutoMobileWebSnapshot(
                snapshotId: "s1",
                elements: [AutoMobileWebElement(id: "e0")]
            ))
            XCTAssertNotNil(bridge.latestSnapshot)

            // Even a reload of the same URL is a new document whose `e0` is another element.
            try bridge.documentCommitted(url: XCTUnwrap(URL(string: "https://fixture.local/a")))
            XCTAssertNil(bridge.latestSnapshot)
            XCTAssertEqual(bridge.policy.rejection(for: .click(snapshotId: "s1", elementId: "e0")), "stale_snapshot")
            XCTAssertTrue(bridge.contentProcessAvailable)
        }

        func testAnActionWithNoWebViewAttachedAnswersInsteadOfHanging() async throws {
            let bridge = bridge()
            try bridge.documentCommitted(url: XCTUnwrap(URL(string: "https://fixture.local/")))
            _ = bridge.policy.accept(AutoMobileWebSnapshot(
                snapshotId: "s1",
                elements: [AutoMobileWebElement(id: "e0")]
            ))

            let result = await bridge.perform(AutoMobileWebControlAction.click(snapshotId: "s1", elementId: "e0"))

            XCTAssertEqual(result, .rejected(AutoMobileWebActionResult.webProcessUnavailableReason))
        }

        func testTheCompletionBasedPerformCallsBackWithNoWebViewAttached() throws {
            let bridge = bridge()
            try bridge.documentCommitted(url: XCTUnwrap(URL(string: "https://fixture.local/")))
            _ = bridge.policy.accept(AutoMobileWebSnapshot(
                snapshotId: "s1",
                elements: [AutoMobileWebElement(id: "e0")]
            ))
            let answered = expectation(description: "completion called")

            bridge.perform(.click(snapshotId: "s1", elementId: "e0")) { result in
                if case .success = result { XCTFail("an action with no web view must fail") }
                answered.fulfill()
            }

            wait(for: [answered], timeout: 1)
        }
    }
#endif
