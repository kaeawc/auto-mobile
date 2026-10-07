@testable import CtrlProxyRewrite
import Foundation
import XCTest

// swiftlint:disable force_unwrapping

@MainActor
final class SdkTriggerCommandTests: XCTestCase {
    private static let triggerInfo = SdkHierarchyServerInfo(
        status: "ok", bundleId: "com.example.app", capabilities: ["sdk-trigger"]
    )

    private func run(
        _ json: String, info: SdkHierarchyServerInfo?, reply: SdkTriggerReply?
    )
        async throws -> (SdkTriggerResponse, SdkTriggerFake)
    {
        let sdk = SdkTriggerFake(info: info, reply: reply)
        let locator = RewriteFakeElementLocator()
        locator.foregroundBundleId = "com.example.app"
        let handler = CommandHandler(
            elementLocator: locator, gesturePerformer: RewriteFakeGesturePerformer(),
            perf: PerfProvider(), sdkHierarchyClient: sdk
        )
        let request = try JSONDecoder().decode(WebSocketRequest.self, from: Data(json.utf8))
        let payload = await handler.handle(request)
        return try (XCTUnwrap(payload as? SdkTriggerResponse), sdk)
    }

    private static let callJson =
        #"{"type":"request_sdk_trigger","requestId":"t-1","module":"callkit","trigger":"call","payloadJson":"{\"phoneNumber\":\"555\"}"}"#

    func testForwardsModuleTriggerAndPayloadToTheSdk() async throws {
        let (response, sdk) = try await run(
            Self.callJson,
            info: Self.triggerInfo,
            reply: SdkTriggerReply(statusCode: 200)
        )
        XCTAssertTrue(response.success)
        XCTAssertTrue(response.available)
        XCTAssertEqual(response.statusCode, 200)
        XCTAssertNil(response.error)
        XCTAssertEqual(response.requestId, "t-1")
        XCTAssertEqual(response.type, "sdk_trigger_result")
        let bodies = await sdk.bodies
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(bodies.first)) as? NSDictionary)
        XCTAssertEqual(sent, ["module": "callkit", "trigger": "call", "payload": ["phoneNumber": "555"]])
    }

    func testStructuredSdkRejectionIsRelayed() async throws {
        let reply = SdkTriggerReply(statusCode: 404, error: "module_not_registered", registeredModules: ["biometrics"])
        let (response, _) = try await run(Self.callJson, info: Self.triggerInfo, reply: reply)
        XCTAssertFalse(response.success)
        XCTAssertTrue(response.available)
        XCTAssertEqual(response.statusCode, 404)
        XCTAssertEqual(response.sdkError, "module_not_registered")
        XCTAssertEqual(response.registeredModules, ["biometrics"])
        XCTAssertTrue(response.error?.contains("callkit.call") == true)
    }

    func testAbsentOldAndBackgroundSdkNeverSend() async throws {
        let infos: [SdkHierarchyServerInfo?] = [
            nil,
            SdkHierarchyServerInfo(status: "ok", bundleId: "com.example.app", capabilities: ["magic-tap"]),
            SdkHierarchyServerInfo(status: "ok", bundleId: "com.example.background", capabilities: ["sdk-trigger"]),
        ]
        for info in infos {
            let (response, sdk) = try await run(Self.callJson, info: info, reply: SdkTriggerReply(statusCode: 200))
            XCTAssertFalse(response.success)
            XCTAssertFalse(response.available)
            XCTAssertTrue(response.error?.contains("in-app SDK") == true)
            let bodies = await sdk.bodies
            XCTAssertEqual(bodies.count, 0)
        }
    }

    func testTransportFailureIsAvailableButUnsuccessful() async throws {
        let (response, _) = try await run(Self.callJson, info: Self.triggerInfo, reply: nil)
        XCTAssertFalse(response.success)
        XCTAssertTrue(response.available)
        XCTAssertNil(response.statusCode)
        XCTAssertNotNil(response.error)
    }

    func testMalformedRequestsNeverSend() async throws {
        let requests = [
            #"{"type":"request_sdk_trigger","requestId":"t-2","trigger":"call"}"#,
            #"{"type":"request_sdk_trigger","requestId":"t-3","module":"callkit","trigger":""}"#,
            #"{"type":"request_sdk_trigger","requestId":"t-4","module":"callkit","trigger":"call","payloadJson":"[1]"}"#,
        ]
        for json in requests {
            let (response, sdk) = try await run(json, info: Self.triggerInfo, reply: SdkTriggerReply(statusCode: 200))
            XCTAssertFalse(response.success)
            let bodies = await sdk.bodies
            XCTAssertEqual(bodies.count, 0)
        }
    }

    func testMissingPayloadSendsAnEmptyObject() async throws {
        let json = #"{"type":"request_sdk_trigger","requestId":"t-5","module":"callkit","trigger":"hold"}"#
        let (response, sdk) = try await run(json, info: Self.triggerInfo, reply: SdkTriggerReply(statusCode: 200))
        XCTAssertTrue(response.success)
        let bodies = await sdk.bodies
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(bodies.first)) as? NSDictionary)
        XCTAssertEqual(sent, ["module": "callkit", "trigger": "hold", "payload": [String: Any]()])
    }

    func testClientPostsToTriggerRouteAndDecodesStructuredErrors() async {
        let body = Data(#"{"error":"unknown_trigger","supportedTriggers":["call","hold"]}"#.utf8)
        let transport = StubHTTPTransport(status: 400, body: body)
        let client = SdkHierarchyClient(
            baseURL: URL(string: "http://localhost:8766")!, transport: transport, healthTransport: transport
        )
        let reply = await client.sendTrigger(Data("{}".utf8))
        XCTAssertEqual(
            reply,
            SdkTriggerReply(statusCode: 400, error: "unknown_trigger", supportedTriggers: ["call", "hold"])
        )
        XCTAssertEqual(transport.recordedRequests.first?.url?.path, "/trigger")
        XCTAssertEqual(transport.recordedRequests.first?.httpMethod, "POST")

        let unreachable = SdkHierarchyClient(
            baseURL: URL(string: "http://localhost:8766")!,
            transport: StubHTTPTransport([.transportError]),
            healthTransport: StubHTTPTransport([.transportError])
        )
        let missing = await unreachable.sendTrigger(Data("{}".utf8))
        XCTAssertNil(missing)
    }
}

private actor SdkTriggerFake: SdkHierarchyFetching {
    let info: SdkHierarchyServerInfo?
    let reply: SdkTriggerReply?
    var bodies: [Data] = []
    init(info: SdkHierarchyServerInfo?, reply: SdkTriggerReply?) {
        self.info = info
        self.reply = reply
    }

    func sendTrigger(_ body: Data) async -> SdkTriggerReply? {
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
