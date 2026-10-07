@testable import CtrlProxyRewrite
import Foundation
import XCTest

@MainActor
final class MagicTapCommandTests: XCTestCase {
    private func run(info: SdkHierarchyServerInfo?, result: Bool?) async throws -> (MagicTapResponse, MagicTapSdkFake) {
        let sdk = MagicTapSdkFake(info: info, result: result)
        let locator = RewriteFakeElementLocator()
        locator.foregroundBundleId = "com.example.app"
        let handler = CommandHandler(
            elementLocator: locator, gesturePerformer: RewriteFakeGesturePerformer(),
            perf: PerfProvider(), sdkHierarchyClient: sdk
        )
        let request = try JSONDecoder().decode(
            WebSocketRequest.self, from: Data(#"{"type":"request_magic_tap","requestId":"magic-1"}"#.utf8)
        )
        let payload = await handler.handle(request)
        return try (XCTUnwrap(payload as? MagicTapResponse), sdk)
    }

    func testHandledAndUnhandledAreDistinct() async throws {
        let info = SdkHierarchyServerInfo(status: "ok", bundleId: "com.example.app", capabilities: ["magic-tap"])
        for handled in [true, false] {
            let (response, sdk) = try await run(info: info, result: handled)
            XCTAssertEqual(response.success, handled)
            XCTAssertEqual(response.handled, handled)
            XCTAssertTrue(response.available)
            XCTAssertEqual(response.unsupported, !handled)
            XCTAssertFalse(response.requiresVoiceOver)
            XCTAssertEqual(response.requestId, "magic-1")
            let calls = await sdk.calls
            XCTAssertEqual(calls, 1)
        }
    }

    func testAbsentOldAndBackgroundSdkNeverInvokeAction() async throws {
        let infos: [SdkHierarchyServerInfo?] = [
            nil,
            SdkHierarchyServerInfo(status: "ok", bundleId: "com.example.app"),
            SdkHierarchyServerInfo(status: "ok", bundleId: "com.example.background", capabilities: ["magic-tap"]),
        ]
        for info in infos {
            let (response, sdk) = try await run(info: info, result: true)
            XCTAssertFalse(response.success)
            XCTAssertFalse(response.available)
            XCTAssertNil(response.handled)
            XCTAssertTrue(response.unsupported)
            XCTAssertTrue(response.error?.contains("in-app SDK") == true)
            let calls = await sdk.calls
            XCTAssertEqual(calls, 0)
        }
    }

    func testTransportFailureDoesNotClaimNoHandler() async throws {
        let (response, _) = try await run(
            info: SdkHierarchyServerInfo(status: "ok", bundleId: "com.example.app", capabilities: ["magic-tap"]),
            result: nil
        )
        XCTAssertFalse(response.success)
        XCTAssertTrue(response.available)
        XCTAssertNil(response.handled)
        XCTAssertFalse(response.unsupported)
    }
}

private actor MagicTapSdkFake: SdkHierarchyFetching {
    let info: SdkHierarchyServerInfo?
    let result: Bool?
    var calls = 0
    init(info: SdkHierarchyServerInfo?, result: Bool?) {
        self.info = info
        self.result = result
    }

    func performMagicTap() async -> Bool? {
        calls += 1
        return result
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
