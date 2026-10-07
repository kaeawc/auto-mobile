@testable import CtrlProxyRewrite
import Foundation
import XCTest

final class ResponsePerfTimingCopyTests: XCTestCase {
    func testWebSocketResponsePerfTimingCopyPreservesEveryFieldAndUsesFallbackTotal() throws {
        var response = WebSocketResponse(
            type: "pinch_result",
            timestamp: 1_730_000_000_000,
            requestId: "request-1",
            success: true,
            totalTimeMs: nil,
            error: "diagnostic",
            blockingCommandType: "request_tap",
            blockingElapsedMs: 42,
            blockingDeadlineRemainingMs: -7,
            text: "result text",
            verified: false,
            warning: "Value did not change",
            pinchPath: "element-anchored",
            resolvedStore: "x"
        )
        response.effectiveValueDiffers = true
        let timing = PerfTiming(name: "handleRequest", durationMs: 12)

        let copied = response.withPerfTiming(timing, totalTimeMs: 99)
        let decoded = try JSONDecoder().decode(WebSocketResponse.self, from: JSONEncoder().encode(copied))

        XCTAssertEqual(decoded.type, "pinch_result")
        XCTAssertEqual(decoded.timestamp, 1_730_000_000_000)
        XCTAssertEqual(decoded.requestId, "request-1")
        XCTAssertEqual(decoded.success, true)
        XCTAssertEqual(decoded.totalTimeMs, 99)
        XCTAssertEqual(decoded.error, "diagnostic")
        XCTAssertEqual(decoded.blockingCommandType, "request_tap")
        XCTAssertEqual(decoded.blockingElapsedMs, 42)
        XCTAssertEqual(decoded.blockingDeadlineRemainingMs, -7)
        XCTAssertEqual(decoded.text, "result text")
        XCTAssertEqual(decoded.verified, false)
        XCTAssertEqual(decoded.warning, "Value did not change")
        XCTAssertEqual(decoded.pinchPath, "element-anchored")
        XCTAssertEqual(decoded.resolvedStore, "x")
        XCTAssertEqual(decoded.effectiveValueDiffers, true)
        XCTAssertEqual(decoded.perfTiming?.name, "handleRequest")
        XCTAssertEqual(decoded.perfTiming?.durationMs, 12)
    }

    func testWebSocketResponsePerfTimingCopyKeepsExistingTotal() throws {
        let response = WebSocketResponse(type: "pinch_result", totalTimeMs: 37, pinchPath: "event-path")

        let copied = response.withPerfTiming(PerfTiming(name: "total", durationMs: 12), totalTimeMs: 99)
        let decoded = try JSONDecoder().decode(WebSocketResponse.self, from: JSONEncoder().encode(copied))

        XCTAssertEqual(decoded.totalTimeMs, 37)
        XCTAssertEqual(decoded.pinchPath, "event-path")
        XCTAssertEqual(decoded.perfTiming?.name, "total")
    }

    func testHierarchyPerfTimingCopyPreservesTimestampAndFields() throws {
        let response = HierarchyUpdateResponse(
            timestamp: 1_730_000_000_000,
            requestId: "hierarchy-1",
            error: "capture failed",
            frameContext: "epoch:1:abc123",
            servedFromCache: true
        )

        let copied = response.withPerfTiming(PerfTiming(name: "hierarchy", durationMs: 5))
        let decoded = try JSONDecoder().decode(HierarchyUpdateResponse.self, from: JSONEncoder().encode(copied))

        XCTAssertEqual(decoded.type, "hierarchy_update")
        XCTAssertEqual(decoded.timestamp, 1_730_000_000_000)
        XCTAssertEqual(decoded.requestId, "hierarchy-1")
        XCTAssertNil(decoded.data)
        XCTAssertEqual(decoded.error, "capture failed")
        XCTAssertEqual(decoded.frameContext, "epoch:1:abc123")
        XCTAssertEqual(decoded.servedFromCache, true)
        XCTAssertEqual(decoded.perfTiming?.name, "hierarchy")
        XCTAssertEqual(decoded.perfTiming?.durationMs, 5)
    }
}
