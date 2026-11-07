import AutoMobileSdkWire
@testable import CtrlProxy
import Foundation
import XCTest

@MainActor
final class AccessibilityFocusCommandTests: XCTestCase {
    private func run(
        info: SdkHierarchyServerInfo?,
        reply: SdkAccessibilityFocusReply?
    )
        async throws -> (AccessibilityFocusResponse, FocusSdkFake)
    {
        let sdk = FocusSdkFake(info: info, reply: reply)
        let locator = FakeElementLocator()
        locator.foregroundBundleId = "com.example.app"
        let handler = CommandHandler(
            elementLocator: locator, gesturePerformer: FakeGesturePerformer(),
            perf: PerfProvider(), sdkHierarchyClient: sdk
        )
        let request = try JSONDecoder().decode(
            WebSocketRequest.self,
            from: Data(
                #"{"type":"request_accessibility_focus","requestId":"focus-1","resourceId":"save","text":"Save","contentDesc":"Button"}"#
                    .utf8
            )
        )
        XCTAssertEqual(request.requestType, .accessibilityFocus)
        let payload = await handler.handle(request)
        return try (XCTUnwrap(payload as? AccessibilityFocusResponse), sdk)
    }

    func testSuccessAndTypedSdkFailures() async throws {
        let info = SdkHierarchyServerInfo(
            status: "ok",
            bundleId: "com.example.app",
            capabilities: ["accessibility-focus"]
        )
        for code in [nil, "voiceover_off", "element_not_found", "invalid_selector"] as [String?] {
            let (response, sdk) = try await run(info: info, reply: .init(
                status: code == nil ? "ok" : "error",
                errorCode: code.flatMap(AccessibilityFocusErrorCode.init(rawValue:))
            ))
            XCTAssertEqual(response.success, code == nil)
            XCTAssertEqual(response.errorCode?.rawValue, code)
            XCTAssertEqual(response.requestId, "focus-1")
            if code ==
                "voiceover_off" { XCTAssertTrue(response.error?.contains("accessibility {voiceover:true}") == true) }
            let calls = await sdk.requests
            XCTAssertEqual(calls.count, 1)
            XCTAssertEqual(calls.first?.resourceId, "save")
            XCTAssertEqual(calls.first?.text, "Save")
            XCTAssertEqual(calls.first?.contentDesc, "Button")
        }
    }

    func testAbsentOldOrBackgroundSdkNeverInvokesFocus() async throws {
        let infos: [SdkHierarchyServerInfo?] = [
            nil,
            .init(status: "ok", bundleId: "com.example.app"),
            .init(status: "ok", bundleId: "com.example.background", capabilities: ["accessibility-focus"]),
        ]
        for info in infos {
            let (response, sdk) = try await run(info: info, reply: .init(status: "ok", errorCode: nil))
            XCTAssertFalse(response.success)
            XCTAssertEqual(response.errorCode, .sdkUnavailable)
            XCTAssertEqual(
                response.error,
                "Accessibility focus requires the AutoMobile in-app SDK with accessibility-focus support in the foreground app."
            )
            let calls = await sdk.requests
            XCTAssertTrue(calls.isEmpty)
        }
    }

    func testTransportFailureReturnsTypedFailure() async throws {
        let (response, _) = try await run(
            info: .init(status: "ok", bundleId: "com.example.app", capabilities: ["accessibility-focus"]), reply: nil
        )
        XCTAssertFalse(response.success)
        XCTAssertEqual(response.errorCode, .sdkUnavailable)
    }
}

private actor FocusSdkFake: SdkHierarchyFetching {
    let info: SdkHierarchyServerInfo?
    let reply: SdkAccessibilityFocusReply?
    var requests: [RequestAccessibilityFocus] = []
    init(info: SdkHierarchyServerInfo?, reply: SdkAccessibilityFocusReply?) {
        self.info = info
        self.reply = reply
    }

    func performAccessibilityFocus(_ request: RequestAccessibilityFocus) async -> SdkAccessibilityFocusReply? {
        requests.append(request)
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
