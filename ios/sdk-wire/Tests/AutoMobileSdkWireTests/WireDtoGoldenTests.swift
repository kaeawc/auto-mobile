@testable import AutoMobileSdkWire
import Foundation
import XCTest

/// Pins the key set every shared wire DTO puts on the wire. The synthesized `Codable` conformances use
/// the property names as keys, so renaming `NetworkMockRuleDTO.remaining` (or any other property) changes
/// both ends at once and nothing cross-package would notice. Each golden below is the output of the
/// DTO's own encoder (sorted keys) with every property populated, reviewed against the declaration.
final class WireDtoGoldenTests: XCTestCase {
    private func json(_ value: some Encodable) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try XCTUnwrap(String(data: encoder.encode(value), encoding: .utf8))
    }

    private func assertGolden(_ value: some Encodable, _ golden: String, line: UInt = #line) throws {
        XCTAssertEqual(try json(value), golden, line: line)
    }

    private var mockRule: NetworkMockRuleDTO {
        NetworkMockRuleDTO(
            mockId: "m1", host: "api.test", path: "/v1", method: "GET", limit: 3, remaining: 2,
            statusCode: 201, responseHeaders: ["X": "y"], responseBody: "{}", contentType: "application/json"
        )
    }

    private var faultRule: NetworkFaultRuleDTO {
        NetworkFaultRuleDTO(
            faultId: "f1", transport: .webSocket, host: "h", port: 443, scheme: "https", path: "/p",
            method: "POST", headers: ["A": "b"], origin: "o", connectionId: "c", sessionId: "s",
            action: .dropBytes, statusCode: 503, responseHeaders: ["R": "s"], responseBody: "b",
            contentType: "text/plain", errorType: "timeout", delayMs: 10, bandwidthBytesPerSecond: 20,
            dropBytes: 30, limit: 4, expiresAtEpochMs: 5, scope: "app", dryRun: true
        )
    }

    func testNetworkMockRuleKeys() throws { try assertGolden(
        mockRule,
        "{\"contentType\":\"application/json\",\"host\":\"api.test\",\"limit\":3,\"method\":\"GET\",\"mockId\":\"m1\",\"path\":\"/v1\",\"remaining\":2,\"responseBody\":\"{}\",\"responseHeaders\":{\"X\":\"y\"},\"statusCode\":201}"
    ) }
    func testRejectedMockRuleKeys() throws { try assertGolden(
        RejectedMockRule(mockId: "m1", reason: "bad"),
        "{\"mockId\":\"m1\",\"reason\":\"bad\"}"
    ) }

    func testNetworkErrorSimulationKeys() throws {
        try assertGolden(
            NetworkErrorSimulationDTO(
                enabled: true, errorType: "timeout", limit: 1, expiresAtEpochMs: 2, remainingMs: 3
            ), "{\"enabled\":true,\"errorType\":\"timeout\",\"expiresAtEpochMs\":2,\"limit\":1,\"remainingMs\":3}"
        )
    }

    func testNetworkFaultRuleKeys() throws { try assertGolden(
        faultRule,
        "{\"action\":\"dropBytes\",\"bandwidthBytesPerSecond\":20,\"connectionId\":\"c\",\"contentType\":\"text/plain\",\"delayMs\":10,\"dropBytes\":30,\"dryRun\":true,\"errorType\":\"timeout\",\"expiresAtEpochMs\":5,\"faultId\":\"f1\",\"headers\":{\"A\":\"b\"},\"host\":\"h\",\"limit\":4,\"method\":\"POST\",\"origin\":\"o\",\"path\":\"/p\",\"port\":443,\"responseBody\":\"b\",\"responseHeaders\":{\"R\":\"s\"},\"scheme\":\"https\",\"scope\":\"app\",\"sessionId\":\"s\",\"statusCode\":503,\"transport\":\"webSocket\"}"
    ) }
    func testSetMockRulesBodyKeys() throws { try assertGolden(
        SetMockRulesBody(rules: [mockRule]),
        "{\"rules\":[{\"contentType\":\"application/json\",\"host\":\"api.test\",\"limit\":3,\"method\":\"GET\",\"mockId\":\"m1\",\"path\":\"/v1\",\"remaining\":2,\"responseBody\":\"{}\",\"responseHeaders\":{\"X\":\"y\"},\"statusCode\":201}]}"
    ) }
    func testSetNetworkFaultRulesBodyKeys() throws { try assertGolden(
        SetNetworkFaultRulesBody(rules: [faultRule]),
        "{\"rules\":[{\"action\":\"dropBytes\",\"bandwidthBytesPerSecond\":20,\"connectionId\":\"c\",\"contentType\":\"text/plain\",\"delayMs\":10,\"dropBytes\":30,\"dryRun\":true,\"errorType\":\"timeout\",\"expiresAtEpochMs\":5,\"faultId\":\"f1\",\"headers\":{\"A\":\"b\"},\"host\":\"h\",\"limit\":4,\"method\":\"POST\",\"origin\":\"o\",\"path\":\"/p\",\"port\":443,\"responseBody\":\"b\",\"responseHeaders\":{\"R\":\"s\"},\"scheme\":\"https\",\"scope\":\"app\",\"sessionId\":\"s\",\"statusCode\":503,\"transport\":\"webSocket\"}]}"
    ) }

    func testSetMockRulesReplyKeys() throws {
        try assertGolden(
            SetMockRulesReply(rejected: [RejectedMockRule(mockId: "m1", reason: "bad")]),
            "{\"rejected\":[{\"mockId\":\"m1\",\"reason\":\"bad\"}]}"
        )
    }

    func testFaultTransportAndActionRawValues() throws {
        try assertGolden(
            [NetworkFaultTransport.urlSession, .webSocket, .nwConnection, .webView],
            "[\"urlSession\",\"webSocket\",\"nwConnection\",\"webView\"]"
        )
        try assertGolden(
            [
                NetworkFaultAction.response, .status, .error, .latency, .bandwidth, .dropBytes, .closeConnection,
                .rejectFrame,
            ],
            "[\"response\",\"status\",\"error\",\"latency\",\"bandwidth\",\"dropBytes\",\"closeConnection\",\"rejectFrame\"]"
        )
    }

    func testStorageKeys() throws {
        let diagnostic = StorageDiagnostic(code: "c", message: "m")
        try assertGolden(diagnostic, "{\"code\":\"c\",\"message\":\"m\"}")
        try assertGolden(
            SdkDatabaseErrorPayload(error: "e", diagnostic: diagnostic),
            "{\"diagnostic\":{\"code\":\"c\",\"message\":\"m\"},\"error\":\"e\"}"
        )
    }

    func testChromeKeys() throws {
        try assertGolden(
            SdkEdgeInsets(top: 1, right: 2, bottom: 3, left: 4),
            "{\"bottom\":3,\"left\":4,\"right\":2,\"top\":1}"
        )
        try assertGolden(
            SdkDisplayCutoutInfo(classification: "notch", bounds: [SdkBounds(left: 1, top: 2, right: 3, bottom: 4)]),
            "{\"bounds\":[{\"bottom\":4,\"left\":1,\"right\":3,\"top\":2}],\"classification\":\"notch\"}"
        )
        try assertGolden(
            SdkSystemChrome(visibility: "v", statusBar: "s", homeIndicatorAutoHideRequested: true, source: "src"),
            "{\"homeIndicatorAutoHideRequested\":true,\"source\":\"src\",\"statusBar\":\"s\",\"visibility\":\"v\"}"
        )
        try assertGolden(SdkGestureInfo(type: "tap", isEnabled: true), "{\"isEnabled\":true,\"type\":\"tap\"}")
    }

    func testBoundsAndSemanticLinkKeys() throws {
        try assertGolden(
            SdkBounds(left: 1, top: 2, right: 3, bottom: 4),
            "{\"bottom\":4,\"left\":1,\"right\":3,\"top\":2}"
        )
        try assertGolden(
            SdkSemanticLink(text: "t", occurrence: 1, start: 2, end: 3, centerX: 4.5, centerY: 5.5),
            "{\"centerX\":4.5,\"centerY\":5.5,\"end\":3,\"occurrence\":1,\"start\":2,\"text\":\"t\"}"
        )
    }
}
