import AutoMobileSdkWire
@testable import CtrlProxy
import Foundation
import XCTest

/// #5162: `request_sdk_web_snapshot` and `request_sdk_web_action` relay opted-in WKWebViews and
/// fail closed with typed failures; arbitrary JavaScript never reaches the SDK.
@MainActor
final class SdkWebViewCommandTests: XCTestCase {
    private static let entry = WebViewBridgeEntry(
        webViewId: "main", url: "https://fixture.local/", allowedOrigins: ["https://fixture.local"],
        contentProcessAvailable: true
    )

    private static let registered = SdkHierarchyServerInfo(
        status: "ok", bundleId: "com.example.app", webViewBridge: WebViewBridgeState(webViews: [entry])
    )

    private static let snapshot = AutoMobileWebSnapshot(
        snapshotId: "s1", url: "https://fixture.local/",
        elements: [AutoMobileWebElement(id: "submit", role: "button", label: "Submit", bounds: [1, 2, 3, 4])]
    )

    private func handle<T>(
        _ json: String,
        info: SdkHierarchyServerInfo?,
        reply: SdkBridgeReply?,
        as _: T.Type
    )
        async throws -> (T, WebViewSdkFake)
    {
        let sdk = WebViewSdkFake(info: info, reply: reply)
        let locator = FakeElementLocator()
        locator.foregroundBundleId = "com.example.app"
        let handler = CommandHandler(
            elementLocator: locator, gesturePerformer: FakeGesturePerformer(),
            perf: PerfProvider(), sdkHierarchyClient: sdk
        )
        let request = try JSONDecoder().decode(WebSocketRequest.self, from: Data(json.utf8))
        let payload = await handler.handle(request)
        return try (XCTUnwrap(payload as? T), sdk)
    }

    private static let snapshotJson = #"{"type":"request_sdk_web_snapshot","requestId":"web-1"}"#

    private static func actionJson(_ action: String, webViewId: String? = "main") -> String {
        let escaped = action.replacingOccurrences(of: "\"", with: "\\\"")
        let id = webViewId.map { #","webViewId":""# + $0 + #"""# } ?? ""
        return #"{"type":"request_sdk_web_action","requestId":"web-2""# + id + #","actionJson":""# + escaped + #""}"#
    }

    func testSnapshotRelaysTheWebViewSnapshotAndDiscovery() async throws {
        let body = try JSONEncoder().encode(AutoMobileWebSnapshotReply(webViewId: "main", snapshot: Self.snapshot))
        let (response, sdk) = try await handle(
            Self.snapshotJson, info: Self.registered, reply: SdkBridgeReply(statusCode: 200, body: body),
            as: SdkWebSnapshotResponse.self
        )
        XCTAssertTrue(response.success)
        XCTAssertEqual(response.webViewId, "main")
        XCTAssertEqual(response.snapshot, Self.snapshot)
        XCTAssertEqual(response.webViews, [Self.entry])
        let routes = await sdk.routes
        XCTAssertEqual(routes, [.webViewSnapshot])
        let sent = await sdk.bodies
        XCTAssertEqual(
            try JSONDecoder().decode(AutoMobileWebSnapshotRequest.self, from: XCTUnwrap(sent.first)),
            .init()
        )
    }

    func testNoWebViewOrForeignAppNeverCallsTheSdk() async throws {
        let infos: [SdkHierarchyServerInfo?] = [
            nil,
            SdkHierarchyServerInfo(status: "ok", bundleId: "com.example.app"),
            SdkHierarchyServerInfo(status: "ok", bundleId: "com.example.app", webViewBridge: .none),
            SdkHierarchyServerInfo(
                status: "ok", bundleId: "com.example.other", webViewBridge: WebViewBridgeState(webViews: [Self.entry])
            ),
        ]
        for info in infos {
            let (response, sdk) = try await handle(
                Self.snapshotJson, info: info, reply: SdkBridgeReply(statusCode: 200, body: Data()),
                as: SdkWebSnapshotResponse.self
            )
            XCTAssertFalse(response.success)
            XCTAssertFalse(response.available)
            XCTAssertEqual(response.failure, "bridge_unavailable")
            let routes = await sdk.routes
            XCTAssertEqual(routes, [])
        }
    }

    func testSdkStatusCodesMapToTypedFailures() async throws {
        let cases: [(SdkBridgeReply?, String)] = [
            (nil, "bad_reply"),
            (SdkBridgeReply(statusCode: 403, body: Data()), "disallowed_origin"),
            (SdkBridgeReply(statusCode: 404, body: Data()), "no_snapshot"),
            (SdkBridgeReply(statusCode: 410, body: Data()), "web_process_unavailable"),
            (SdkBridgeReply(statusCode: 413, body: Data()), "message_too_large"),
            (SdkBridgeReply(statusCode: 503, body: Data()), "bridge_unavailable"),
            (SdkBridgeReply(statusCode: 200, body: Data("{}".utf8)), "bad_reply"),
        ]
        for (reply, failure) in cases {
            let (response, _) = try await handle(
                Self.snapshotJson, info: Self.registered, reply: reply, as: SdkWebSnapshotResponse.self
            )
            XCTAssertEqual(response.failure, failure)
            XCTAssertNil(response.snapshot)
        }
    }

    func testActionRelaysTheResultAndRejectionsAreResults() async throws {
        let action = try XCTUnwrap(String(
            data: JSONEncoder().encode(AutoMobileWebControlAction.click(snapshotId: "s1", elementId: "submit")),
            encoding: .utf8
        ))
        let accepted = try JSONEncoder().encode(AutoMobileWebActionResult(status: .accepted))
        let (ok, sdk) = try await handle(
            Self.actionJson(action), info: Self.registered, reply: SdkBridgeReply(statusCode: 200, body: accepted),
            as: SdkWebActionResponse.self
        )
        XCTAssertTrue(ok.success)
        let routes = await sdk.routes
        XCTAssertEqual(routes, [.webViewAction])
        let sent = await sdk.bodies
        let request = try JSONDecoder().decode(AutoMobileWebActionRequest.self, from: XCTUnwrap(sent.first))
        XCTAssertEqual(
            request,
            AutoMobileWebActionRequest(webViewId: "main", action: .click(snapshotId: "s1", elementId: "submit"))
        )

        let stale = try JSONEncoder().encode(AutoMobileWebActionResult.rejected("stale_snapshot"))
        let (rejected, _) = try await handle(
            Self.actionJson(action), info: Self.registered, reply: SdkBridgeReply(statusCode: 200, body: stale),
            as: SdkWebActionResponse.self
        )
        XCTAssertFalse(rejected.success)
        XCTAssertTrue(rejected.available)
        XCTAssertNil(rejected.failure)
        XCTAssertEqual(rejected.error, "stale_snapshot")
    }

    func testJavaScriptOrMissingWebViewNeverReachesTheSdk() async throws {
        let invalid = [
            Self.actionJson(#"{"evaluateJavaScript":{"_0":"alert(1)"}}"#),
            Self.actionJson(#"{"click":{"snapshotId":"s1","elementId":"submit"}}"#, webViewId: nil),
            #"{"type":"request_sdk_web_action","requestId":"web-2","webViewId":"main"}"#,
        ]
        for json in invalid {
            let (response, sdk) = try await handle(
                json, info: Self.registered, reply: SdkBridgeReply(statusCode: 200, body: Data()),
                as: SdkWebActionResponse.self
            )
            XCTAssertEqual(response.failure, "invalid_action")
            let routes = await sdk.routes
            XCTAssertEqual(routes, [])
        }
    }

    func testActionOnAnUnregisteredWebViewNeverReachesTheSdk() async throws {
        let (response, sdk) = try await handle(
            Self.actionJson(#"{"click":{"snapshotId":"s1","elementId":"submit"}}"#, webViewId: "other"),
            info: Self.registered, reply: SdkBridgeReply(statusCode: 200, body: Data()), as: SdkWebActionResponse.self
        )
        XCTAssertEqual(response.failure, "bridge_unavailable")
        let routes = await sdk.routes
        XCTAssertEqual(routes, [])
    }
}

private actor WebViewSdkFake: SdkHierarchyFetching {
    let info: SdkHierarchyServerInfo?
    let reply: SdkBridgeReply?
    var routes: [SdkRoute] = []
    var bodies: [Data] = []

    init(info: SdkHierarchyServerInfo?, reply: SdkBridgeReply?) {
        self.info = info
        self.reply = reply
    }

    func sendObservationRequest(_ route: SdkRoute, body: Data) async -> SdkBridgeReply? {
        routes.append(route)
        bodies.append(body)
        return reply
    }

    func fetchHierarchy() async -> SdkViewHierarchy? { nil }
    func fetchFreshHierarchy() async -> SdkViewHierarchy? { nil }
    func fetchServerInfo() async -> SdkHierarchyServerInfo? { info }
    func isAvailable() async -> Bool { info != nil }
    func setMockRules(_: [NetworkMockRuleDTO]) async -> Bool { false }
    func setNetworkFaultRules(_: [NetworkFaultRuleDTO]) async -> Bool { false }
    func setNetworkErrorSimulation(_: NetworkErrorSimulationDTO) async -> Bool { false }
    func addHighlight(id _: String, shape _: HighlightShape) async -> SdkHighlightOutcome { .unavailable }
}
