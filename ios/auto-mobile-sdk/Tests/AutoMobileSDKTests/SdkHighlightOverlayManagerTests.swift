@testable import AutoMobileSDK
import XCTest

#if DEBUG && canImport(UIKit) && canImport(QuartzCore) && !os(watchOS)
final class SdkHighlightOverlayManagerTests: XCTestCase {
    func testBuildsBoxRenderCommand() {
        let shape = SdkHighlightShape(
            type: "box",
            bounds: SdkHighlightBounds(x: 10, y: 20, width: 30, height: 40, sourceWidth: nil, sourceHeight: nil),
            points: nil,
            style: SdkHighlightStyle(
                strokeColor: "#00FF00",
                strokeWidth: 4,
                dashPattern: [6, 3],
                capStyle: nil,
                joinStyle: nil
            )
        )

        let command = SdkHighlightCommandBuilder.command(for: shape)

        XCTAssertEqual(command?.shapeType, "box")
        XCTAssertEqual(command?.bounds?.x, 10)
        XCTAssertEqual(command?.strokeColor, "#00FF00")
        XCTAssertEqual(command?.strokeWidth, 4)
        XCTAssertEqual(command?.dashPattern, [6, 3])
    }

    func testScalesScreenshotCoordinatesToTargetSize() {
        let shape = SdkHighlightShape(
            type: "path",
            bounds: SdkHighlightBounds(x: 30, y: 60, width: 90, height: 120, sourceWidth: 300, sourceHeight: 600),
            points: [
                SdkHighlightPoint(x: 30, y: 60),
                SdkHighlightPoint(x: 90, y: 120),
            ],
            style: nil
        )
        let command = SdkHighlightCommandBuilder.command(for: shape)

        let scaled = command.flatMap {
            SdkHighlightCommandScaler.scaled(
                $0,
                targetSize: SdkHighlightTargetSize(width: 100, height: 200)
            )
        }

        XCTAssertEqual(scaled?.bounds?.x, 10)
        XCTAssertEqual(scaled?.bounds?.y, 20)
        XCTAssertEqual(scaled?.bounds?.width, 30)
        XCTAssertEqual(scaled?.bounds?.height, 40)
        XCTAssertEqual(scaled?.points[0].x, 10)
        XCTAssertEqual(scaled?.points[0].y, 20)
        XCTAssertEqual(scaled?.points[1].x, 30)
        XCTAssertEqual(scaled?.points[1].y, 40)
    }

    func testRejectsInvalidShape() {
        let shape = SdkHighlightShape(type: "box", bounds: nil, points: nil, style: nil)

        XCTAssertNil(SdkHighlightCommandBuilder.command(for: shape))
    }
}
#endif
