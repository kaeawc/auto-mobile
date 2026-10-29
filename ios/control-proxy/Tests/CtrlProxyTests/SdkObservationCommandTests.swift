import AutoMobileSdkWire
@testable import CtrlProxy
import Foundation
import XCTest

/// #5159: `request_sdk_observation` and `request_sdk_action` relay the in-app observation bridge
/// and fail closed with typed failures.
@MainActor
final class SdkObservationCommandTests: XCTestCase {
    private static let snapshot = AutoMobileObservationSnapshot(
        captureIdentity: 41,
        orientation: .portrait,
        coordinateSpace: .screen,
        bounds: SdkBounds(left: 0, top: 0, right: 390, bottom: 844),
        root: AutoMobileObservationNode(
            id: "submit", role: "button", label: "Submit", bounds: SdkBounds(left: 10, top: 10, right: 90, bottom: 40)
        )
    )

    private static let registered = SdkHierarchyServerInfo(
        status: "ok", bundleId: "com.example.app",
        observationBridge: ObservationBridgeState(available: true, supportedActions: ["tap"])
    )

    private func handle<T>(
        _ json: String,
        info: SdkHierarchyServerInfo?,
        reply: SdkBridgeReply?,
        as _: T.Type
    ) async throws -> (T, ObservationSdkFake) {
        let sdk = ObservationSdkFake(info: info, reply: reply)
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

    private static let observeJson = #"{"type":"request_sdk_observation","requestId":"obs-1"}"#

    private static func actionJson(_ action: String) -> String {
        let escaped = action.replacingOccurrences(of: "\"", with: "\\\"")
        return #"{"type":"request_sdk_action","requestId":"act-1","actionJson":""# + escaped + #""}"#
    }

    func testObservationRelaysTheBridgeSnapshot() async throws {
        let body = try JSONEncoder().encode(Self.snapshot)
        let (response, sdk) = try await handle(
            Self.observeJson, info: Self.registered, reply: SdkBridgeReply(statusCode: 200, body: body),
            as: SdkObservationResponse.self
        )
        XCTAssertTrue(response.success)
        XCTAssertEqual(response.observation, Self.snapshot)
        XCTAssertEqual(response.requestId, "obs-1")
        let routes = await sdk.routes
        XCTAssertEqual(routes, [.observationSnapshot])
    }

    func testNoBridgeOrForeignAppNeverCallsTheSdk() async throws {
        let infos: [SdkHierarchyServerInfo?] = [
            nil,
            SdkHierarchyServerInfo(status: "ok", bundleId: "com.example.app"),
            SdkHierarchyServerInfo(status: "ok", bundleId: "com.example.app", observationBridge: .notRegistered),
            SdkHierarchyServerInfo(
                status: "ok", bundleId: "com.example.other",
                observationBridge: ObservationBridgeState(available: true)
            ),
        ]
        for info in infos {
            let (response, sdk) = try await handle(
                Self.observeJson, info: info, reply: SdkBridgeReply(statusCode: 200, body: Data()),
                as: SdkObservationResponse.self
            )
            XCTAssertFalse(response.success)
            XCTAssertFalse(response.available)
            XCTAssertEqual(response.failure, "bridge_unavailable")
            let routes = await sdk.routes
            XCTAssertEqual(routes, [])
        }
    }

    func testSdkStatusCodesMapToTypedFailures() async throws {
        let cases: [(SdkBridgeReply?, String, Bool)] = [
            (nil, "bad_reply", true),
            (SdkBridgeReply(statusCode: 503, body: Data()), "bridge_unavailable", false),
            (SdkBridgeReply(statusCode: 409, body: Data()), "app_not_active", true),
            (SdkBridgeReply(statusCode: 500, body: Data()), "bad_reply", true),
            (SdkBridgeReply(statusCode: 200, body: Data("{}".utf8)), "bad_reply", true),
        ]
        for (reply, failure, available) in cases {
            let (response, _) = try await handle(
                Self.observeJson, info: Self.registered, reply: reply, as: SdkObservationResponse.self
            )
            XCTAssertEqual(response.failure, failure)
            XCTAssertEqual(response.available, available, failure)
            XCTAssertNil(response.observation)
        }
    }

    func testActionRelaysTheBridgeResult() async throws {
        let accepted = AutoMobileActionResult(status: .accepted, durationMs: 4, nextObservationIdentity: 42)
        let body = try JSONEncoder().encode(accepted)
        let action = try String(
            data: JSONEncoder().encode(AutoMobileAction.tap(observationIdentity: 41, elementId: "submit")),
            encoding: .utf8
        )
        let (response, sdk) = try await handle(
            Self.actionJson(XCTUnwrap(action)), info: Self.registered,
            reply: SdkBridgeReply(statusCode: 200, body: body), as: SdkActionResponse.self
        )
        XCTAssertTrue(response.success)
        XCTAssertEqual(response.result?.nextObservationIdentity, 42)
        let routes = await sdk.routes
        XCTAssertEqual(routes, [.observationAction])
    }

    func testBridgeRejectionIsAResultNotAFailure() async throws {
        let body = try JSONEncoder().encode(AutoMobileActionResult(status: .rejected, reason: "stale_observation"))
        let (response, _) = try await handle(
            Self.actionJson(#"{"back":{"observationIdentity":40}}"#), info: Self.registered,
            reply: SdkBridgeReply(statusCode: 200, body: body), as: SdkActionResponse.self
        )
        XCTAssertFalse(response.success)
        XCTAssertTrue(response.available)
        XCTAssertNil(response.failure)
        XCTAssertEqual(response.result?.reason, "stale_observation")
        XCTAssertEqual(response.error, "stale_observation")
    }

    func testInvalidActionNeverReachesTheSdk() async throws {
        for json in [#"{"type":"request_sdk_action","requestId":"act-1"}"#, Self.actionJson(#"{"fly":{}}"#)] {
            let (response, sdk) = try await handle(
                json, info: Self.registered, reply: SdkBridgeReply(statusCode: 200, body: Data()),
                as: SdkActionResponse.self
            )
            XCTAssertEqual(response.failure, "invalid_action")
            XCTAssertTrue(response.available)
            let routes = await sdk.routes
            XCTAssertEqual(routes, [])
        }
    }
}

private actor ObservationSdkFake: SdkHierarchyFetching {
    let info: SdkHierarchyServerInfo?
    let reply: SdkBridgeReply?
    var routes: [SdkRoute] = []

    init(info: SdkHierarchyServerInfo?, reply: SdkBridgeReply?) {
        self.info = info
        self.reply = reply
    }

    func sendObservationRequest(_ route: SdkRoute, body _: Data) async -> SdkBridgeReply? {
        routes.append(route)
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
