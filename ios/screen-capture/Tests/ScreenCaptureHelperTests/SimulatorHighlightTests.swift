import AppKit
import ScreenCaptureCore
@testable import ScreenCaptureHelper
import XCTest

final class SimulatorHighlightTests: XCTestCase {
    func testSimulatorNameDoesNotMatchAnotherModel() {
        XCTAssertTrue(simulatorWindowTitle("iPhone 17 Pro Max – iOS 26.2", namesDevice: "iPhone 17 Pro Max"))
        XCTAssertFalse(simulatorWindowTitle("iPhone 17 Pro Max – iOS 26.2", namesDevice: "iPhone 17 Pro"))
        XCTAssertFalse(simulatorWindowTitle("iPhone 17", namesDevice: ""))
        XCTAssertFalse(simulatorWindowTitle(nil, namesDevice: "iPhone 17"))
    }

    private func shape(
        _ type: String = "circle",
        source: String = "\"sourceWidth\":100,\"sourceHeight\":200"
    )
        throws -> SimulatorHighlightShape
    {
        try JSONDecoder().decode(SimulatorHighlightShape.self, from: Data("""
        {"type":"\(type)","bounds":{"x":10,"y":20,"width":30,"height":40,\(
            source
        )}}
        """.utf8))
    }

    func testScalesCircleFromDeviceCoordinates() throws {
        for type in ["circle"] {
            let path = try shape(type).bounds.scaled(to: CGSize(width: 200, height: 400))
            XCTAssertEqual(path, CGRect(x: 20, y: 40, width: 60, height: 80))
        }
    }

    func testRejectsMissingOrZeroSourceDimensions() throws {
        XCTAssertNil(
            try shape(source: "\"sourceWidth\":null,\"sourceHeight\":null")
                .bounds.scaled(to: CGSize(width: 200, height: 400))
        )
        XCTAssertNil(
            try shape(source: "\"sourceWidth\":0,\"sourceHeight\":200")
                .bounds.scaled(to: CGSize(width: 200, height: 400))
        )
        XCTAssertThrowsError(try shape("box"))
        XCTAssertThrowsError(try shape("path"))
    }

    func testConvertsGlobalCoordinatesAboveAndBelowPrimaryDisplay() {
        XCTAssertEqual(
            SimulatorDisplayGeometry
                .appKitFrame(CGRect(x: -500, y: -300, width: 200, height: 400), primaryScreenHeight: 1000),
            CGRect(x: -500, y: 900, width: 200, height: 400)
        )
        XCTAssertEqual(
            SimulatorDisplayGeometry
                .appKitFrame(CGRect(x: 100, y: 1100, width: 200, height: 400), primaryScreenHeight: 1000),
            CGRect(x: 100, y: -500, width: 200, height: 400)
        )
    }

    func testHighlightCLIRejectsMixedCaptureOptions() throws {
        XCTAssertEqual(
            try CommandLineOptions.parse(["helper", "--highlight-simulator", "iPhone", "--highlight-json", "{}"]).mode,
            .highlightSimulator(deviceName: "iPhone", json: "{}")
        )
        XCTAssertThrowsError(try CommandLineOptions.parse(["helper", "--highlight-json", "{}"]))
        XCTAssertThrowsError(try CommandLineOptions.parse([
            "helper",
            "--simulator-window",
            "42",
            "--highlight-json",
            "{}",
            "--encode",
            "h264",
        ]))
    }
}

@MainActor
final class SimulatorHighlightHostTests: XCTestCase {
    private final class FakeOverlay: SimulatorOverlay {
        var closed = false
        var refreshes = 0
        func close() {
            closed = true
        }

        func refresh() async throws {
            refreshes += 1
        }
    }

    @MainActor
    private final class FrameClock {
        var waits = 0
        private var continuation: CheckedContinuation<Void, Never>?

        func wait() async {
            waits += 1
            await withCheckedContinuation { continuation = $0 }
        }

        func advance() {
            let pending = continuation
            continuation = nil
            pending?.resume()
        }
    }

    func testRefreshLoopParksAfterExpiryAndRestartsForNextHighlight() async {
        let clock = FrameClock()
        var now: TimeInterval = 0
        var created: [FakeOverlay] = []
        let host = SimulatorHighlightHost(deviceName: "iPhone", now: { now }, makeOverlay: { _ in
            let overlay = FakeOverlay()
            created.append(overlay)
            return overlay
        }, waitForFrame: { await clock.wait() }, replySink: { _ in })
        let command = Data(
            #"{"requestId":"1","id":"same","shape":{"type":"circle","bounds":{"x":0,"y":0,"width":10,"height":10}}}"#
                .utf8
        )
        XCTAssertEqual(clock.waits, 0)
        await host.receive(command)
        for _ in 0 ..< 100 where clock.waits == 0 {
            await Task.yield()
        }
        XCTAssertEqual(clock.waits, 1)
        now = 2
        clock.advance()
        for _ in 0 ..< 100 {
            await Task.yield()
        }
        XCTAssertTrue(created[0].closed)
        XCTAssertEqual(clock.waits, 1, "Expired overlays must not schedule further frames")
        await host.receive(command)
        for _ in 0 ..< 100 where clock.waits == 1 {
            await Task.yield()
        }
        XCTAssertEqual(clock.waits, 2)
        XCTAssertFalse(created[1].closed)
        host.close()
        clock.advance()
        for _ in 0 ..< 100 {
            await Task.yield()
        }
        XCTAssertTrue(created[1].closed)
        XCTAssertEqual(clock.waits, 2, "Shutdown must stop refreshing")
    }

    func testReplacementGetsItsOwnDeadlineAndHostAcceptsMoreCommandsAfterExpiry() async {
        var now: TimeInterval = 0
        var created: [FakeOverlay] = []
        var replies: [SimulatorHighlightReply] = []
        let host = SimulatorHighlightHost(deviceName: "iPhone", now: { now }, makeOverlay: { _ in
            let overlay = FakeOverlay()
            created.append(overlay)
            return overlay
        }, replySink: { replies.append($0) })
        let first =
            Data(
                #"{"requestId":"1","id":"same","shape":{"type":"circle","bounds":{"x":0,"y":0,"width":10,"height":10}}}"#
                    .utf8
            )
        await host.receive(first)
        now = 0.5
        await host.receive(first)
        XCTAssertTrue(created[0].closed)
        now = 1.2
        await host.refresh()
        XCTAssertFalse(created[1].closed)
        now = 1.7
        await host.refresh()
        XCTAssertTrue(created[1].closed)
        await host.receive(first)
        XCTAssertEqual(created.count, 3)
        XCTAssertEqual(replies.count, 3)
        XCTAssertTrue(replies.allSatisfy(\.success))
        host.close()
        XCTAssertTrue(created[2].closed)
    }

    func testNativeDrawFailureIsAcknowledgedAsFailure() async {
        var replies: [SimulatorHighlightReply] = []
        let host = SimulatorHighlightHost(deviceName: "iPhone", makeOverlay: { _ in
            throw OverlayError("permission denied")
        }, replySink: { replies.append($0) })
        await host
            .receive(
                Data(
                    #"{"requestId":"1","id":"same","shape":{"type":"circle","bounds":{"x":0,"y":0,"width":10,"height":10}}}"#
                        .utf8
                )
            )
        XCTAssertEqual(replies.count, 1)
        XCTAssertFalse(replies[0].success)
        XCTAssertEqual(replies[0].error, "permission denied")
    }
}
