@testable import CtrlProxyRewrite
import Foundation
import XCTest

final class XCUIQueryBoundTests: XCTestCase {
    func testBoundAppliesOnlyToHierarchyQueries() {
        for type in ["request_swipe", "request_tap_coordinates", "request_screenshot", "set_hierarchy_poll_interval"] {
            XCTAssertNil(XCUIQueryBound.boundMs(commandType: type, startExpiryMs: nil, executionStartedAtMs: 0))
        }
        for type in ["request_hierarchy", "request_hierarchy_if_stale"] {
            XCTAssertEqual(
                XCUIQueryBound.boundMs(commandType: type, startExpiryMs: nil, executionStartedAtMs: 0),
                10000
            )
        }
    }

    func testWireBudgetCanOnlyShortenTheDefault() {
        let bound = { (expiry: Int64?) in
            XCUIQueryBound.boundMs(
                commandType: "request_hierarchy", startExpiryMs: expiry, executionStartedAtMs: 1000
            )
        }
        XCTAssertEqual(bound(6000), 4500) // expiry - start - response reserve
        XCTAssertEqual(bound(1100), 250) // floor
        XCTAssertEqual(bound(60000), 10000) // a generous host budget keeps the default
    }

    func testQueryBoundErrorIsActionableAndKeepsHostMatchedWording() throws {
        let error = CommandError.queryBoundExceeded(command: "request_hierarchy", boundMs: 10000, elapsedMs: 10000)
        let message = try XCTUnwrap(error.errorDescription)
        XCTAssertNil(error.wireCode)
        XCTAssertTrue(message.contains("request_hierarchy exceeded execution bound 10000ms"))
        XCTAssertTrue(message.contains("suspended or backgrounded"))
        XCTAssertTrue(message.contains("Re-observe"))
        // IosLockScreenUnlocker matches /exceeded execution bound[\s\S]*XCUITest call is still executing/.
        XCTAssertNotNil(message.range(
            of: #"exceeded execution bound[\s\S]*XCUITest call is still executing"#, options: .regularExpression
        ))
    }

    private func server(
        timer: FakeProxyTimer, clock: FakeMonotonicClock,
        handler: @escaping @Sendable (WebSocketRequest) -> any WebSocketResponsePayload
    )
        -> WebSocketServer
    {
        WebSocketServer(
            commandHandler: FakeCommandHandling(handler: handler),
            perf: FakePerfTracking(flushResult: nil),
            frameContext: FakeFrameContextRecording(token: nil),
            monotonicNowMs: { clock.now() },
            timer: timer
        )
    }

    private func awaitWatchdog(_ timer: FakeProxyTimer) async {
        var spins = 0
        while timer.pendingWaiterCount == 0, spins < 10000 {
            await Task.yield()
            spins += 1
        }
    }

    func testFastHierarchyKeepsResponseAndCancelsWatchdog() async throws {
        let timer = FakeProxyTimer(mode: .manual)
        let done = expectation(description: "hierarchy response")
        let responder = CapturingResponder(onEach: { done.fulfill() })
        let server = server(timer: timer, clock: FakeMonotonicClock()) { request in
            WebSocketResponse.success(type: "hierarchy_update", requestId: request.requestId, totalTimeMs: 0)
        }
        server.dispatchCommand(Data(#"{"type":"request_hierarchy","requestId":"fast"}"#.utf8), responder: responder)
        await fulfillment(of: [done], timeout: 2)
        var spins = 0
        while timer.cancelledWaitCount == 0, spins < 10000 {
            await Task.yield()
            spins += 1
        }
        XCTAssertEqual(timer.cancelledWaitCount, 1)
        timer.advance(by: 10000)
        XCTAssertEqual(responder.captured.count, 1)
        let result = try JSONDecoder().decode(WebSocketResponse.self, from: XCTUnwrap(responder.captured.first))
        XCTAssertEqual(result.success, true)
    }

    func testStalledHierarchyAnswersAtBoundAndHoldsTheChainUntilTheQueryReturns() async throws {
        let timer = FakeProxyTimer(mode: .manual)
        let clock = FakeMonotonicClock()
        let started = expectation(description: "query started")
        let bounded = expectation(description: "bound response")
        let queuedDone = expectation(description: "queued command after release")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let server = server(timer: timer, clock: clock) { request in
            if request.requestId == "stuck" {
                // Stands in for a live XCUI query against a suspended app.
                started.fulfill()
                release.wait()
            }
            return WebSocketResponse.success(type: "hierarchy_update", requestId: request.requestId, totalTimeMs: 0)
        }
        let responder = CapturingResponder(onEach: { bounded.fulfill() })
        let queued = CapturingResponder(onEach: { queuedDone.fulfill() })
        server.dispatchCommand(
            Data(#"{"type":"request_hierarchy_if_stale","requestId":"stuck"}"#.utf8), responder: responder
        )
        await fulfillment(of: [started], timeout: 2)
        await awaitWatchdog(timer)
        XCTAssertEqual(timer.pendingWaiterCount, 1)
        server.dispatchCommand(Data(#"{"type":"request_screenshot","requestId":"queued"}"#.utf8), responder: queued)

        timer.advance(by: 9999)
        XCTAssertTrue(responder.captured.isEmpty)
        timer.advance(by: 1)
        await fulfillment(of: [bounded], timeout: 2)
        let result = try JSONDecoder().decode(WebSocketResponse.self, from: XCTUnwrap(responder.captured.first))
        XCTAssertEqual(result.type, "hierarchy_update")
        XCTAssertEqual(result.requestId, "stuck")
        XCTAssertEqual(result.success, false)
        XCTAssertTrue(result.error?.contains("exceeded execution bound 10000ms") == true)
        XCTAssertTrue(result.error?.contains("Re-observe") == true)
        XCTAssertTrue(queued.captured.isEmpty, "the serial chain stays held while the query runs")

        release.signal()
        await fulfillment(of: [queuedDone], timeout: 2)
        XCTAssertEqual(responder.captured.count, 1, "the late hierarchy result is discarded")
    }
}
