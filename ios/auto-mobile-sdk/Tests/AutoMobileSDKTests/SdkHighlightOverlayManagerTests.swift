@testable import AutoMobileSDK
import XCTest

#if DEBUG && !os(watchOS)
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

    func testRejectsWhenSourceDimensionsAreMissing() {
        // Issue #2682: without source dims the SDK cannot map device coordinates
        // into its view space, so it must reject rather than draw unscaled.
        let shape = SdkHighlightShape(
            type: "box",
            bounds: SdkHighlightBounds(x: 10, y: 20, width: 30, height: 40, sourceWidth: nil, sourceHeight: nil),
            points: nil,
            style: nil
        )
        let command = SdkHighlightCommandBuilder.command(for: shape)

        let scaled = command.flatMap {
            SdkHighlightCommandScaler.scaled(
                $0,
                targetSize: SdkHighlightTargetSize(width: 100, height: 200)
            )
        }

        XCTAssertNil(scaled)
    }

    func testScalesForHighDensityDeviceWithAnisotropicScale() {
        // Source observation space 300x600, drawn into a 900x1200 view: scaleX=3, scaleY=2.
        let shape = SdkHighlightShape(
            type: "box",
            bounds: SdkHighlightBounds(x: 30, y: 60, width: 90, height: 120, sourceWidth: 300, sourceHeight: 600),
            points: nil,
            style: nil
        )
        let command = SdkHighlightCommandBuilder.command(for: shape)

        let scaled = command.flatMap {
            SdkHighlightCommandScaler.scaled(
                $0,
                targetSize: SdkHighlightTargetSize(width: 900, height: 1200)
            )
        }

        // Drawn frame must match the element bounds mapped into view space.
        XCTAssertEqual(scaled?.bounds?.x, 90)
        XCTAssertEqual(scaled?.bounds?.y, 120)
        XCTAssertEqual(scaled?.bounds?.width, 270)
        XCTAssertEqual(scaled?.bounds?.height, 240)
    }

    func testScalesAcrossOrientationChange() {
        // Portrait observation 400x800 mapped into a landscape 800x400 view.
        let shape = SdkHighlightShape(
            type: "circle",
            bounds: SdkHighlightBounds(x: 100, y: 200, width: 40, height: 80, sourceWidth: 400, sourceHeight: 800),
            points: nil,
            style: nil
        )
        let command = SdkHighlightCommandBuilder.command(for: shape)

        let scaled = command.flatMap {
            SdkHighlightCommandScaler.scaled(
                $0,
                targetSize: SdkHighlightTargetSize(width: 800, height: 400)
            )
        }

        XCTAssertEqual(scaled?.bounds?.x, 200)
        XCTAssertEqual(scaled?.bounds?.y, 100)
        XCTAssertEqual(scaled?.bounds?.width, 80)
        XCTAssertEqual(scaled?.bounds?.height, 40)
    }

    func testRejectsNonPositiveSourceOrTargetDimensions() {
        let shape = SdkHighlightShape(
            type: "box",
            bounds: SdkHighlightBounds(x: 10, y: 20, width: 30, height: 40, sourceWidth: 0, sourceHeight: 600),
            points: nil,
            style: nil
        )
        let command = SdkHighlightCommandBuilder.command(for: shape)

        let scaled = command.flatMap {
            SdkHighlightCommandScaler.scaled(
                $0,
                targetSize: SdkHighlightTargetSize(width: 900, height: 1200)
            )
        }

        XCTAssertNil(scaled)
    }

    func testParsesEightDigitColorsAsAndroidArgb() {
        let color = SdkHighlightColorComponents.parse(hex: "#80FF0000")

        XCTAssertEqual(color.red, 1)
        XCTAssertEqual(color.green, 0)
        XCTAssertEqual(color.blue, 0)
        XCTAssertEqual(color.alpha, 128.0 / 255.0)
    }

    func testRejectsInvalidShape() {
        let shape = SdkHighlightShape(type: "box", bounds: nil, points: nil, style: nil)

        XCTAssertNil(SdkHighlightCommandBuilder.command(for: shape))
    }
}
#endif
