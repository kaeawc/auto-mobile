import CoreGraphics
@testable import ScreenCaptureHelper
import XCTest

@MainActor
final class DeviceHubDisplayTrackerTests: XCTestCase {
    func testZoomChangeFollowsTheNextRelocation() async throws {
        let zoomedOut = try XCTUnwrap(DeviceHubDisplayLocator.displayRect(
            deviceBounds: CGRect(x: 476.5, y: 261.5, width: 396, height: 283.5),
            sourceSize: CGSize(width: 951, height: 669)
        ))
        XCTAssertEqual(zoomedOut.width, 379.6, accuracy: 0.5)
        let capture = Capture(rects: [Capture.zoomFit, zoomedOut])
        let tracker = try await capture.makeTracker()
        assertRect(tracker.frame(for: capture.window), Capture.zoomFit.offsetBy(dx: 49, dy: 48))

        capture.time += DeviceHubDisplayTracker.relocateInterval + 0.01
        await tracker.refreshIfDue(window: capture.window)?.value

        XCTAssertEqual(capture.calls, 2)
        assertRect(tracker.frame(for: capture.window), zoomedOut.offsetBy(dx: 49, dy: 48))
    }

    func testDoesNotRecaptureBeforeTheInterval() async throws {
        let capture = Capture(rects: [Capture.zoomFit, .zero])
        let tracker = try await capture.makeTracker()
        await tracker.refreshIfDue(window: capture.window)?.value
        capture.time += DeviceHubDisplayTracker.relocateInterval - 0.01
        await tracker.refreshIfDue(window: capture.window)?.value

        XCTAssertEqual(capture.calls, 1)
        assertRect(tracker.frame(for: capture.window), Capture.zoomFit.offsetBy(dx: 49, dy: 48))
    }

    func testNilRelocationKeepsThePreviousRectAndIsThrottled() async throws {
        let recovered = CGRect(x: 300, y: 150, width: 400, height: 280)
        let capture = Capture(rects: [Capture.zoomFit, nil, recovered])
        let tracker = try await capture.makeTracker()
        capture.time += DeviceHubDisplayTracker.relocateInterval
        await tracker.refreshIfDue(window: capture.window)?.value
        await tracker.refreshIfDue(window: capture.window)?.value

        XCTAssertEqual(capture.calls, 2)
        assertRect(tracker.frame(for: capture.window), Capture.zoomFit.offsetBy(dx: 49, dy: 48))

        capture.time += DeviceHubDisplayTracker.relocateInterval
        await tracker.refreshIfDue(window: capture.window)?.value
        XCTAssertEqual(capture.calls, 3)
        assertRect(tracker.frame(for: capture.window), recovered.offsetBy(dx: 49, dy: 48))
    }

    func testPendingCaptureDoesNotBlockTheRefreshAndAppliesTheLateResult() async throws {
        let late = CGRect(x: 300, y: 150, width: 400, height: 280)
        var time: TimeInterval = 0
        var calls = 0
        var release: CheckedContinuation<CGRect?, Never>?
        let target = SimulatorOverlayTarget(
            windowID: 1, processID: 2, frame: CGRect(x: 49, y: 48, width: 1100, height: 800), title: "Device Hub"
        )
        let tracker = DeviceHubDisplayTracker(
            relativeRect: Capture.zoomFit,
            windowSize: target.frame.size,
            now: { time },
            relocate: { _ in
                calls += 1
                return await withCheckedContinuation { release = $0 }
            }
        )
        time += DeviceHubDisplayTracker.relocateInterval
        let pending = try XCTUnwrap(tracker.refreshIfDue(window: target), "a due refresh starts a capture")
        // refreshIfDue returned without awaiting the capture, which cannot finish until released.
        assertRect(tracker.frame(for: target), Capture.zoomFit.offsetBy(dx: 49, dy: 48))

        time += DeviceHubDisplayTracker.relocateInterval
        XCTAssertNil(tracker.refreshIfDue(window: target), "no second capture starts while one is still running")

        while release == nil {
            await Task.yield()
        }
        XCTAssertEqual(calls, 1)
        release?.resume(returning: late)
        await pending.value
        assertRect(tracker.frame(for: target), late.offsetBy(dx: 49, dy: 48))

        time += DeviceHubDisplayTracker.relocateInterval
        XCTAssertNotNil(tracker.refreshIfDue(window: target), "a finished capture lets the next one start")
    }

    func testWindowResizeForcesImmediateRelocation() async throws {
        let resized = CGRect(x: 300, y: 150, width: 400, height: 280)
        let capture = Capture(rects: [Capture.zoomFit, resized])
        let tracker = try await capture.makeTracker()
        let window = capture.target(frame: CGRect(x: 49, y: 48, width: 900, height: 700))

        await tracker.refreshIfDue(window: window)?.value
        await tracker.refreshIfDue(window: window)?.value

        XCTAssertEqual(capture.calls, 2)
        assertRect(tracker.frame(for: window), resized.offsetBy(dx: 49, dy: 48))
    }

    func testWindowMoveKeepsTheOffsetWithoutRecapturing() async throws {
        let capture = Capture(rects: [Capture.zoomFit])
        let tracker = try await capture.makeTracker()
        let moved = capture.target(frame: CGRect(x: 200, y: 100, width: 1100, height: 800))

        await tracker.refreshIfDue(window: moved)?.value

        XCTAssertEqual(capture.calls, 1)
        assertRect(tracker.frame(for: moved), Capture.zoomFit.offsetBy(dx: 200, dy: 100))
    }

    private func assertRect(_ actual: CGRect, _ expected: CGRect, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual.minX, expected.minX, accuracy: 0.5, file: file, line: line)
        XCTAssertEqual(actual.minY, expected.minY, accuracy: 0.5, file: file, line: line)
        XCTAssertEqual(actual.width, expected.width, accuracy: 0.5, file: file, line: line)
        XCTAssertEqual(actual.height, expected.height, accuracy: 0.5, file: file, line: line)
    }

    @MainActor
    private final class Capture {
        // Window-relative points measured on the live Duo inner panel at zoom fit.
        static let zoomFit = CGRect(x: 421.4, y: 225, width: 506.7, height: 356.4)
        var time: TimeInterval = 0
        private(set) var calls = 0
        private var rects: [CGRect?]

        init(rects: [CGRect?]) {
            self.rects = rects
        }

        var window: SimulatorOverlayTarget {
            target(frame: CGRect(x: 49, y: 48, width: 1100, height: 800))
        }

        func target(frame: CGRect) -> SimulatorOverlayTarget {
            SimulatorOverlayTarget(windowID: 1, processID: 2, frame: frame, title: "Device Hub")
        }

        func makeTracker() async throws -> DeviceHubDisplayTracker {
            let rect = await relocate()
            let initial = try XCTUnwrap(rect)
            return DeviceHubDisplayTracker(
                relativeRect: initial,
                windowSize: window.frame.size,
                now: { self.time },
                relocate: { _ in await self.relocate() }
            )
        }

        private func relocate() async -> CGRect? {
            calls += 1
            return rects.isEmpty ? nil : rects.removeFirst()
        }
    }
}
