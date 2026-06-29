@testable import CtrlProxy
import XCTest

final class HighlightOverlayManagerTests: XCTestCase {
    func testBuildsBoxRenderCommandWithStyle() throws {
        let shape = HighlightShape(
            type: "box",
            bounds: HighlightBounds(x: 10, y: 20, width: 100, height: 50),
            style: HighlightStyle(strokeColor: "#00FF00", strokeWidth: 4, dashPattern: [6, 3])
        )

        let command = try HighlightOverlayCommandBuilder.command(for: shape)

        XCTAssertEqual(command.shapeType, "box")
        XCTAssertEqual(command.bounds?.x, 10)
        XCTAssertEqual(command.bounds?.y, 20)
        XCTAssertEqual(command.bounds?.width, 100)
        XCTAssertEqual(command.bounds?.height, 50)
        XCTAssertEqual(command.strokeColor, "#00FF00")
        XCTAssertEqual(command.strokeWidth, 4)
        XCTAssertEqual(command.dashPattern, [6, 3])
    }

    func testBuildsCircleRenderCommand() throws {
        let shape = HighlightShape(
            type: "circle",
            bounds: HighlightBounds(x: 30, y: 40, width: 80, height: 80)
        )

        let command = try HighlightOverlayCommandBuilder.command(for: shape)

        XCTAssertEqual(command.shapeType, "circle")
        XCTAssertEqual(command.bounds?.x, 30)
        XCTAssertEqual(command.bounds?.width, 80)
        XCTAssertEqual(command.strokeColor, "#FF0000")
        XCTAssertEqual(command.strokeWidth, 8)
    }

    func testBuildsPathRenderCommand() throws {
        let points = [
            HighlightPoint(x: 1, y: 2),
            HighlightPoint(x: 3, y: 4),
            HighlightPoint(x: 5, y: 6),
        ]
        let shape = HighlightShape(
            type: "path",
            points: points,
            style: HighlightStyle(strokeColor: "#FF3B30", strokeWidth: 2, smoothing: "catmull-rom", tension: 0.6)
        )

        let command = try HighlightOverlayCommandBuilder.command(for: shape)

        XCTAssertEqual(command.shapeType, "path")
        XCTAssertEqual(command.points.count, 3)
        XCTAssertEqual(command.points[0].x, 1)
        XCTAssertEqual(command.points[0].y, 2)
        XCTAssertEqual(command.points[2].x, 5)
        XCTAssertEqual(command.points[2].y, 6)
        XCTAssertEqual(command.strokeColor, "#FF3B30")
        XCTAssertEqual(command.strokeWidth, 2)
        XCTAssertEqual(command.smoothing, "catmull-rom")
        XCTAssertEqual(command.tension, 0.6)
    }

    func testBuildsHandDrawnEllipseSegmentsWithJitterAndWidthVariation() {
        let segments = HighlightOverlayHandDrawnSegments.ellipseSegments(
            bounds: HighlightBounds(x: 10, y: 20, width: 100, height: 80),
            baseStrokeWidth: 8,
            phaseX: 0,
            phaseY: 0,
            startAngleJitter: 0
        )

        XCTAssertEqual(segments.count, 160)
        XCTAssertLessThan(segments.map(\.strokeWidth).min() ?? 0, 7)
        XCTAssertGreaterThan(segments.map(\.strokeWidth).max() ?? 0, 15)
        XCTAssertNotEqual(segments[0].startX, segments[40].startX)
        XCTAssertNotEqual(segments[0].strokeWidth, segments[40].strokeWidth)
    }

    func testBuildsHandDrawnPathSegmentsWithDefaultSmoothingAndTaper() {
        let points = [
            HighlightPoint(x: 10, y: 20),
            HighlightPoint(x: 40, y: 35),
            HighlightPoint(x: 80, y: 25),
        ]

        let segments = HighlightOverlayHandDrawnSegments.pathSegments(
            points: points,
            smoothing: nil,
            tension: nil,
            baseStrokeWidth: 8
        )

        XCTAssertGreaterThan(segments.count, points.count - 1)
        XCTAssertEqual(segments.first?.startX, 10)
        XCTAssertEqual(segments.first?.startY, 20)
        XCTAssertEqual(segments.last?.endX, 80)
        XCTAssertEqual(segments.last?.endY, 25)
        XCTAssertLessThan(segments.first?.strokeWidth ?? 0, 8)
        XCTAssertLessThan(segments.last?.strokeWidth ?? 0, 8)
        XCTAssertGreaterThan(segments.map(\.strokeWidth).max() ?? 0, 7)
    }

    func testScalesScreenshotBoundsToOverlayTargetSize() throws {
        let shape = HighlightShape(
            type: "box",
            bounds: HighlightBounds(
                x: 30,
                y: 60,
                width: 90,
                height: 120,
                sourceWidth: 300,
                sourceHeight: 600
            )
        )
        let command = try HighlightOverlayCommandBuilder.command(for: shape)

        let scaled = HighlightOverlayCommandScaler.scaled(
            command,
            targetSize: HighlightOverlayTargetSize(width: 100, height: 200)
        )

        XCTAssertEqual(scaled?.bounds?.x, 10)
        XCTAssertEqual(scaled?.bounds?.y, 20)
        XCTAssertEqual(scaled?.bounds?.width, 30)
        XCTAssertEqual(scaled?.bounds?.height, 40)
    }

    func testScalesScreenshotPathPointsToOverlayTargetSize() throws {
        let shape = HighlightShape(
            type: "path",
            bounds: HighlightBounds(
                x: 0,
                y: 0,
                width: 300,
                height: 600,
                sourceWidth: 300,
                sourceHeight: 600
            ),
            points: [
                HighlightPoint(x: 30, y: 60),
                HighlightPoint(x: 90, y: 120),
            ]
        )
        let command = try HighlightOverlayCommandBuilder.command(for: shape)

        let scaled = HighlightOverlayCommandScaler.scaled(
            command,
            targetSize: HighlightOverlayTargetSize(width: 100, height: 200)
        )

        XCTAssertEqual(scaled?.points[0].x, 10)
        XCTAssertEqual(scaled?.points[0].y, 20)
        XCTAssertEqual(scaled?.points[1].x, 30)
        XCTAssertEqual(scaled?.points[1].y, 40)
    }

    func testParsesEightDigitColorsAsAndroidArgb() {
        let color = HighlightOverlayColorComponents.parse(hex: "#80FF0000")

        XCTAssertEqual(color.red, 1)
        XCTAssertEqual(color.green, 0)
        XCTAssertEqual(color.blue, 0)
        XCTAssertEqual(color.alpha, 128.0 / 255.0)
    }

    func testManagerRendersAndSchedulesAutoExpire() {
        let renderer = FakeHighlightOverlayRenderer()
        let scheduler = FakeHighlightOverlayScheduler()
        let manager = HighlightOverlayManager(renderer: renderer, scheduler: scheduler, ttlSeconds: 3)
        let shape = HighlightShape(type: "box", bounds: HighlightBounds(x: 1, y: 2, width: 3, height: 4))

        XCTAssertTrue(manager.show(id: "highlight-1", shape: shape))
        XCTAssertEqual(renderer.rendered.first?.id, "highlight-1")
        XCTAssertEqual(scheduler.scheduled.first?.seconds, 3)

        scheduler.scheduled.first?.block()
        XCTAssertEqual(renderer.removedIds, ["highlight-1"])
    }

    func testManagerRejectsInvalidShape() {
        let renderer = FakeHighlightOverlayRenderer()
        let scheduler = FakeHighlightOverlayScheduler()
        let manager = HighlightOverlayManager(renderer: renderer, scheduler: scheduler)
        let shape = HighlightShape(type: "box")

        XCTAssertFalse(manager.show(id: "highlight-1", shape: shape))
        XCTAssertTrue(renderer.rendered.isEmpty)
        XCTAssertTrue(scheduler.scheduled.isEmpty)
    }

    func testLiveOverlayDefaultsEnabledWhenEnvironmentFlagIsUnset() {
        XCTAssertTrue(DefaultHighlightOverlayRenderer.liveOverlayEnabled(environment: [:]))
    }

    func testLiveOverlayEnvironmentFlagCanDisableOverlay() {
        XCTAssertFalse(DefaultHighlightOverlayRenderer.liveOverlayEnabled(environment: [
            "AUTOMOBILE_IOS_LIVE_HIGHLIGHTS": "false",
        ]))
        XCTAssertFalse(DefaultHighlightOverlayRenderer.liveOverlayEnabled(environment: [
            "AUTOMOBILE_IOS_LIVE_HIGHLIGHTS": "0",
        ]))
        XCTAssertFalse(DefaultHighlightOverlayRenderer.liveOverlayEnabled(environment: [
            "AUTOMOBILE_IOS_LIVE_HIGHLIGHTS": "no",
        ]))
        XCTAssertFalse(DefaultHighlightOverlayRenderer.liveOverlayEnabled(environment: [
            "AUTOMOBILE_IOS_LIVE_HIGHLIGHTS": " FALSE ",
        ]))
    }

    func testLiveOverlayEnvironmentFlagCanExplicitlyEnableOverlay() {
        XCTAssertTrue(DefaultHighlightOverlayRenderer.liveOverlayEnabled(environment: [
            "AUTOMOBILE_IOS_LIVE_HIGHLIGHTS": "true",
        ]))
        XCTAssertTrue(DefaultHighlightOverlayRenderer.liveOverlayEnabled(environment: [
            "AUTOMOBILE_IOS_LIVE_HIGHLIGHTS": "1",
        ]))
        XCTAssertTrue(DefaultHighlightOverlayRenderer.liveOverlayEnabled(environment: [
            "AUTOMOBILE_IOS_LIVE_HIGHLIGHTS": "yes",
        ]))
    }
}

private final class FakeHighlightOverlayRenderer: HighlightOverlayRendering {
    var rendered: [(id: String, command: HighlightOverlayRenderCommand)] = []
    var removedIds: [String] = []

    func render(id: String, command: HighlightOverlayRenderCommand) -> Bool {
        rendered.append((id, command))
        return true
    }

    func remove(id: String) {
        removedIds.append(id)
    }
}

private final class FakeHighlightOverlayScheduler: HighlightOverlayScheduling {
    var scheduled: [(seconds: TimeInterval, block: () -> Void)] = []

    func schedule(after seconds: TimeInterval, _ block: @escaping () -> Void) {
        scheduled.append((seconds, block))
    }
}
