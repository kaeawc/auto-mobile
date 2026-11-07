import AppKit
import AutoMobileHighlightCore
import ScreenCaptureCore
@testable import ScreenCaptureHelper
import XCTest

final class SimulatorHighlightTests: XCTestCase {
    private func target(_ id: UInt32, title: String = "mt-duo-0090b") -> SimulatorOverlayTarget {
        SimulatorOverlayTarget(windowID: id, processID: 1, frame: .zero, title: title)
    }

    func testSelectsDuoPanelBySourceAspectRatio() throws {
        // Panel dimensions are from issue #17048, not a live capture.
        let cover = CGSize(width: 466, height: 678)
        let inner = CGSize(width: 951, height: 669)
        let candidates = [target(1), target(2), target(3, title: "another device")]
        for (source, expectedID) in [(cover, UInt32(1)), (inner, UInt32(2))] {
            let selected = try SimulatorDisplayGeometry.find(
                deviceName: "mt-duo-0090b",
                sourceSize: source,
                candidates: candidates,
                displayFrame: { window in
                    XCTAssertNotEqual(window.windowID, 3)
                    return CGRect(origin: .zero, size: window.windowID == 1 ? cover : inner)
                }
            )
            XCTAssertEqual(selected.windowID, expectedID)
        }
    }

    func testSelectsInnerPanelDrawnInOtherOrientation() throws {
        // These measurements come from the Duo capture on 2026-11-05 (scratch/ax-dump-simulator-app.txt), not a
        // hand-written guess.
        let candidates = [target(1), target(2)]
        for (source, expectedID) in [
            (CGSize(width: 951, height: 669), UInt32(1)),
            (CGSize(width: 466, height: 678), UInt32(2)),
        ] {
            let selected = try SimulatorDisplayGeometry.find(
                deviceName: "mt-duo-0090b",
                sourceSize: source,
                candidates: candidates,
                displayFrame: { window in
                    CGRect(
                        origin: .zero,
                        size: window.windowID == 1
                            ? CGSize(width: 615, height: 875)
                            : CGSize(width: 466, height: 678)
                    )
                }
            )
            XCTAssertEqual(selected.windowID, expectedID)
        }
    }

    func testOrientationIndependentMatchStaysAmbiguousForSameShapedPanels() {
        XCTAssertThrowsError(try SimulatorDisplayGeometry.find(
            deviceName: "mt-duo-0090b",
            sourceSize: CGSize(width: 951, height: 669),
            candidates: [target(1), target(2)],
            displayFrame: { _ in CGRect(x: 0, y: 0, width: 615, height: 875) }
        )) { error in
            XCTAssertTrue(String(describing: error).contains("found 2"))
        }
    }

    func testOrientedBoundsRotatesLandscapeSourceForPortraitDisplay() throws {
        let bounds = CircleBounds(x: 100, y: 200, width: 120, height: 120, sourceWidth: 951, sourceHeight: 669)
        let targetSize = CGSize(width: 615, height: 875)
        let oriented = SimulatorDisplayGeometry.orientedBounds(bounds, targetSize: targetSize)

        XCTAssertEqual(oriented.x, 349)
        XCTAssertEqual(oriented.y, 100)
        XCTAssertEqual(oriented.width, 120)
        XCTAssertEqual(oriented.height, 120)
        XCTAssertEqual(oriented.sourceWidth, 669)
        XCTAssertEqual(oriented.sourceHeight, 951)

        let scaled = try XCTUnwrap(oriented.scaled(to: targetSize))
        XCTAssertLessThanOrEqual(abs(scaled.width / scaled.height - 1), 0.01)
        // Rotated center is (349 + 60, 100 + 60); scale by 615/669 and 875/951 to about (376, 147).
        XCTAssertLessThanOrEqual(abs(scaled.midX - 376), 1)
        XCTAssertLessThanOrEqual(abs(scaled.midY - 147), 1)
    }

    func testOrientedBoundsLeavesMatchingOrientationUnchanged() {
        let bounds = CircleBounds(x: 12, y: 34, width: 56, height: 78, sourceWidth: 466, sourceHeight: 678)
        let oriented = SimulatorDisplayGeometry.orientedBounds(bounds, targetSize: CGSize(width: 466, height: 678))
        XCTAssertEqual(oriented.x, bounds.x)
        XCTAssertEqual(oriented.y, bounds.y)
        XCTAssertEqual(oriented.width, bounds.width)
        XCTAssertEqual(oriented.height, bounds.height)
        XCTAssertEqual(oriented.sourceWidth, bounds.sourceWidth)
        XCTAssertEqual(oriented.sourceHeight, bounds.sourceHeight)
    }

    func testOrientedBoundsLeavesNilSourceUnchanged() {
        let bounds = CircleBounds(x: 12, y: 34, width: 56, height: 78, sourceWidth: nil, sourceHeight: nil)
        let oriented = SimulatorDisplayGeometry.orientedBounds(bounds, targetSize: CGSize(width: 615, height: 875))
        XCTAssertEqual(oriented.x, bounds.x)
        XCTAssertEqual(oriented.y, bounds.y)
        XCTAssertEqual(oriented.width, bounds.width)
        XCTAssertEqual(oriented.height, bounds.height)
        XCTAssertEqual(oriented.sourceWidth, bounds.sourceWidth)
        XCTAssertEqual(oriented.sourceHeight, bounds.sourceHeight)
    }

    func testMultipleWindowsWithoutSourceSizeRemainAmbiguous() {
        XCTAssertThrowsError(try SimulatorDisplayGeometry.find(
            deviceName: "mt-duo-0090b",
            candidates: [target(1), target(2)],
            displayFrame: { _ in
                XCTFail("Missing source size must not query display geometry")
                return nil
            }
        )) { error in
            XCTAssertTrue(error is OverlayError)
            XCTAssertTrue(String(describing: error).contains("found 2"))
            XCTAssertTrue(String(describing: error).contains("Duo"))
        }
    }

    func testMultipleWindowsMatchingSourceAspectRemainAmbiguous() {
        XCTAssertThrowsError(try SimulatorDisplayGeometry.find(
            deviceName: "mt-duo-0090b",
            sourceSize: CGSize(width: 466, height: 678),
            candidates: [target(1), target(2)],
            displayFrame: { _ in CGRect(x: 0, y: 0, width: 233, height: 339) }
        )) { error in
            XCTAssertTrue(String(describing: error).contains("found 2"))
        }
    }

    func testNoMatchingWindowThrows() {
        for candidates in [[], [target(1, title: "another device")]] {
            XCTAssertThrowsError(try SimulatorDisplayGeometry.find(
                deviceName: "mt-duo-0090b",
                sourceSize: CGSize(width: 466, height: 678),
                candidates: candidates,
                displayFrame: { _ in
                    XCTFail("Unmatched windows must not query display geometry")
                    return nil
                }
            )) { error in
                XCTAssertTrue(String(describing: error).contains("found 0"))
            }
        }
    }

    func testSingleMatchingWindowIgnoresSourceSize() throws {
        let sizes: [CGSize?] = [nil, .zero, CGSize(width: 951, height: 669)]
        for size in sizes {
            let selected = try SimulatorDisplayGeometry.find(
                deviceName: "mt-duo-0090b",
                sourceSize: size,
                candidates: [target(1), target(2, title: "another device")],
                displayFrame: { _ in
                    XCTFail("Single match must not query display geometry")
                    return nil
                }
            )
            XCTAssertEqual(selected.windowID, 1)
        }
    }

    func testAspectMatchingAllowsSmallRoundingDifferences() throws {
        let selected = try SimulatorDisplayGeometry.find(
            deviceName: "mt-duo-0090b",
            sourceSize: CGSize(width: 466, height: 678),
            candidates: [target(1), target(2)],
            displayFrame: { window in
                CGRect(x: 0, y: 0, width: window.windowID == 1 ? 466 * 1.01 : 466 * 1.03, height: 678)
            }
        )
        XCTAssertEqual(selected.windowID, 1)
    }

    func testUnavailableOrMismatchedDisplayFramesDoNotSelectAWindow() {
        for frame: CGRect? in [nil, .zero, CGRect(x: 0, y: 0, width: 951, height: 669)] {
            XCTAssertThrowsError(try SimulatorDisplayGeometry.find(
                deviceName: "mt-duo-0090b",
                sourceSize: CGSize(width: 466, height: 678),
                candidates: [target(1), target(2)],
                displayFrame: { _ in frame }
            )) { error in
                XCTAssertTrue(String(describing: error).contains("found 2"))
            }
        }
    }

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
        var refreshGate: FrameClock?
        func close() {
            closed = true
        }

        func refresh() async throws {
            refreshes += 1
            if let refreshGate {
                await refreshGate.wait()
            }
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

    func testRefreshKeepsReplacementsWhenSnapshotEntriesExpireDuringSuspension() async {
        let gate = FrameClock()
        var now: TimeInterval = 0
        var created: [FakeOverlay] = []
        let host = SimulatorHighlightHost(deviceName: "iPhone", now: { now }, makeOverlay: { _ in
            let overlay = FakeOverlay()
            if created.count < 2 {
                overlay.refreshGate = gate
            }
            created.append(overlay)
            return overlay
        }, waitForFrame: { throw CancellationError() }, replySink: { _ in })
        defer { host.close() }
        let commands = ["A", "B"].map { id in
            Data("""
            {"requestId":"\(id)","id":"\(id)","shape":{"type":"circle","bounds":{"x":0,"y":0,"width":10,"height":10}}}
            """.utf8)
        }
        for command in commands {
            await host.receive(command)
        }
        let oldOverlays = Array(created.prefix(2))
        let refreshTask = Task { await host.refresh() }
        for _ in 0 ..< 100 where gate.waits == 0 {
            await Task.yield()
        }
        XCTAssertEqual(gate.waits, 1, "Either first-generation overlay must suspend before replacement")

        now = 5
        for command in commands {
            await host.receive(command)
        }
        let newOverlays = Array(created.suffix(2))
        // Only the first snapshot entry suspends; the other now takes the expired-deadline branch.
        // Clearing gates also prevents a hang if the bounded start check above fails.
        for overlay in oldOverlays {
            overlay.refreshGate = nil
        }
        gate.advance()
        await refreshTask.value

        XCTAssertEqual(created.count, 4)
        XCTAssertTrue(oldOverlays.allSatisfy { $0.closed })
        XCTAssertTrue(newOverlays.allSatisfy { !$0.closed })
        now = 5.5
        await host.refresh()
        for overlay in newOverlays {
            XCTAssertEqual(overlay.refreshes, 1, "Both replacements must remain tracked regardless of iteration order")
        }
        host.close()
        XCTAssertTrue(newOverlays.allSatisfy { $0.closed })
    }

    /// Two highlights, one on a Device Hub window whose relocation capture never finishes until the
    /// test releases it. The host's serial refresh must neither wait on that capture nor delay the
    /// other highlight's refresh or the Device Hub highlight's deadline cleanup.
    func testPendingDeviceHubCaptureDelaysNeitherDeadlineCleanupNorTheOtherHighlight() async throws {
        var now: TimeInterval = 0
        var captures = 0
        var release: CheckedContinuation<CGRect?, Never>?
        let window = SimulatorOverlayTarget(
            windowID: 7, processID: 1, frame: CGRect(x: 0, y: 0, width: 200, height: 400), title: "Device Hub"
        )
        let tracker = DeviceHubDisplayTracker(
            relativeRect: CGRect(x: 0, y: 0, width: 200, height: 400),
            windowSize: window.frame.size,
            now: { now },
            relocate: { _ in
                captures += 1
                return await withCheckedContinuation { release = $0 }
            }
        )
        let lookup = SimulatorDisplayGeometry.trackingLookup(tracker)
        var hubFrameLookups = 0
        var hub: SimulatorHighlightOverlay?
        var other: FakeOverlay?
        let host = SimulatorHighlightHost(deviceName: "Device Hub", now: { now }, makeOverlay: { request in
            guard request.id == "hub" else {
                let overlay = FakeOverlay()
                other = overlay
                return overlay
            }
            let overlay = try SimulatorHighlightOverlay(
                window: window,
                request: request,
                displayFrame: { hubFrameLookups += 1; return lookup.frame($0) },
                prepare: lookup.prepare,
                isTrusted: { true },
                targets: { [window] }
            )
            hub = overlay
            return overlay
        }, waitForFrame: { throw CancellationError() }, replySink: { _ in })
        defer { host.close() }
        func command(_ id: String) -> Data {
            Data("""
            {"requestId":"\(id)","id":"\(id)","shape":{"type":"circle","bounds":{"x":10,"y":20,"width":30,\
            "height":40,"sourceWidth":100,"sourceHeight":200}}}
            """.utf8)
        }
        await host.receive(command("hub"))
        now = DeviceHubDisplayTracker.relocateInterval
        await host.receive(command("other"))
        let hubOverlay = try XCTUnwrap(hub)
        let otherOverlay = try XCTUnwrap(other)

        // The Device Hub capture is due: this refresh starts it and must return while it is pending.
        await host.refresh()
        XCTAssertEqual(otherOverlay.refreshes, 1, "the other highlight refreshes in the same pass")
        for _ in 0 ..< 100 where release == nil {
            await Task.yield()
        }
        XCTAssertEqual(captures, 1)
        XCTAssertNotNil(release, "the capture is still pending")
        let lookupsWhilePending = hubFrameLookups

        now += 0.1
        await host.refresh()
        XCTAssertEqual(otherOverlay.refreshes, 2)
        XCTAssertGreaterThan(hubFrameLookups, lookupsWhilePending, "the hub panel keeps its last placement")
        XCTAssertEqual(captures, 1, "no second capture starts while one is pending")

        // Past the hub deadline only: it is cleaned up on this pass with the capture still pending.
        now = HandDrawnCircle.duration
        await host.refresh()
        XCTAssertFalse(hubOverlay.isPanelVisible)
        XCTAssertEqual(otherOverlay.refreshes, 3)
        XCTAssertFalse(otherOverlay.closed)
        let lookupsAtClose = hubFrameLookups

        // The late result lands after the overlay closed; it must not reopen or move the panel.
        release?.resume(returning: CGRect(x: 10, y: 10, width: 100, height: 200))
        for _ in 0 ..< 20 {
            await Task.yield()
        }
        now += 0.1
        await host.refresh()
        XCTAssertEqual(hubFrameLookups, lookupsAtClose, "the expired hub highlight is no longer refreshed")
        XCTAssertFalse(hubOverlay.isPanelVisible)
        XCTAssertEqual(otherOverlay.refreshes, 4)

        now = DeviceHubDisplayTracker.relocateInterval + HandDrawnCircle.duration
        await host.refresh()
        XCTAssertTrue(otherOverlay.closed)
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

@MainActor
final class SimulatorHighlightOverlayRefreshTests: XCTestCase {
    func testRefreshPlacesThePanelFromTheWindowAfterCaptureMoved() async throws {
        let window = SimulatorOverlayTarget(
            windowID: 7, processID: 1, frame: CGRect(x: 0, y: 0, width: 200, height: 400), title: "mt-duo-0090b"
        )
        let moved = SimulatorOverlayTarget(
            windowID: 7, processID: 1, frame: CGRect(x: 30, y: 40, width: 200, height: 400), title: "mt-duo-0090b"
        )
        let request = try JSONDecoder().decode(SimulatorHighlightRequest.self, from: Data("""
        {"requestId":"r","id":"h","shape":{"type":"circle","bounds":{"x":10,"y":20,"width":30,"height":40,\
        "sourceWidth":100,"sourceHeight":200}}}
        """.utf8))
        var current = window
        var seen: [CGPoint] = []
        let overlay = try SimulatorHighlightOverlay(
            window: window,
            request: request,
            displayFrame: { seen.append($0.frame.origin); return $0.frame },
            prepare: { _ in current = moved },
            isTrusted: { true },
            targets: { [current] }
        )
        try await overlay.refresh()

        XCTAssertEqual(seen.last, moved.frame.origin, "the frame must come from the window re-resolved after capture")
    }

    func testClosedOverlayIgnoresRefreshResumingFromPendingCapture() async throws {
        let window = SimulatorOverlayTarget(
            windowID: 7, processID: 1, frame: CGRect(x: 0, y: 0, width: 200, height: 400), title: "mt-duo-0090b"
        )
        let request = try JSONDecoder().decode(SimulatorHighlightRequest.self, from: Data("""
        {"requestId":"r","id":"h","shape":{"type":"circle","bounds":{"x":10,"y":20,"width":30,"height":40,\
        "sourceWidth":100,"sourceHeight":200}}}
        """.utf8))
        var frameLookups = 0
        var captureStarted: CheckedContinuation<Void, Never>?
        var captureFinish: CheckedContinuation<Void, Never>?
        let overlay = try SimulatorHighlightOverlay(
            window: window,
            request: request,
            displayFrame: { _ in frameLookups += 1; return window.frame },
            prepare: { _ in
                await withCheckedContinuation { finish in
                    captureFinish = finish
                    captureStarted?.resume()
                    captureStarted = nil
                }
            },
            isTrusted: { true },
            targets: { [window] }
        )
        XCTAssertEqual(frameLookups, 1)

        let refresh = Task { try await overlay.refresh() }
        while captureFinish == nil {
            await Task.yield()
        }
        // A same-ID replacement closes the old overlay while its capture is pending.
        overlay.close()
        captureFinish?.resume()
        try await refresh.value

        XCTAssertEqual(frameLookups, 1, "closed overlay must not resolve a frame or re-order its panel")
        XCTAssertFalse(overlay.isPanelVisible)
    }
}
