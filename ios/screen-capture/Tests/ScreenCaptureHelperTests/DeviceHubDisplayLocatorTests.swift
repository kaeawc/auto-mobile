import CoreGraphics
@testable import ScreenCaptureHelper
import XCTest

/// Numbers come from a live Device Hub (Xcode 27.1, iOS 27.1 iPhone Duo): the window was
/// 1100x800 at (49,48); its AX tree had the sidebar splitter at x=297, the toolbar 1100x52 at
/// y=48 and the Home button at y=808; the two Duo panels were reported as groups at negative
/// coordinates whatever the zoom. The drawn bounds are the non-background box measured in
/// screenshots of the window, and the displays are where the overlay panel was seen to land.
final class DeviceHubDisplayLocatorTests: XCTestCase {
    private let window = CGRect(x: 49, y: 48, width: 1100, height: 800)
    private let captured = DeviceHubDisplayLocator.AccessibilityLayout(
        splitterX: 297,
        toolbarMaxY: 100,
        controlsMinY: 808
    )

    func testDetailRegionExcludesSidebarToolbarAndControlRow() {
        XCTAssertEqual(
            DeviceHubDisplayLocator.detailRegion(windowFrame: window, layout: captured),
            CGRect(x: 248, y: 52, width: 852, height: 704)
        )
    }

    func testDetailRegionNeedsSidebarEdgeAndToolbar() {
        XCTAssertNil(DeviceHubDisplayLocator.detailRegion(
            windowFrame: window,
            layout: .init(splitterX: nil, toolbarMaxY: 100, controlsMinY: 808)
        ))
        XCTAssertNil(DeviceHubDisplayLocator.detailRegion(
            windowFrame: window,
            layout: .init(splitterX: 297, toolbarMaxY: nil, controlsMinY: 808)
        ))
    }

    func testDetailRegionWithoutControlRowRunsToWindowBottom() {
        XCTAssertEqual(
            DeviceHubDisplayLocator.detailRegion(
                windowFrame: window,
                layout: .init(splitterX: 297, toolbarMaxY: 100, controlsMinY: nil)
            )?.maxY,
            796
        )
    }

    func testDetailRegionOutsideTheWindowIsRejected() {
        XCTAssertNil(DeviceHubDisplayLocator.detailRegion(
            windowFrame: window,
            layout: .init(splitterX: 297, toolbarMaxY: -10, controlsMinY: 808)
        ))
    }

    func testCoverPanelDisplayFollowsDrawnDevice() throws {
        let rect = try XCTUnwrap(DeviceHubDisplayLocator.displayRect(
            deviceBounds: CGRect(x: 547, y: 225, width: 256.5, height: 355.5),
            sourceSize: CGSize(width: 466, height: 678)
        ))
        assertRect(rect, CGRect(x: 557, y: 231, width: 236, height: 344))
    }

    func testInnerPanelDisplayIsLandscapeWhenDrawnLandscape() throws {
        let rect = try XCTUnwrap(DeviceHubDisplayLocator.displayRect(
            deviceBounds: CGRect(x: 427, y: 226, width: 495.5, height: 354.5),
            sourceSize: CGSize(width: 951, height: 669)
        ))
        assertRect(rect, CGRect(x: 437, y: 236, width: 475, height: 334))
    }

    func testPortraitSourceOnLandscapeDeviceIsRotated() throws {
        let rect = try XCTUnwrap(DeviceHubDisplayLocator.displayRect(
            deviceBounds: CGRect(x: 427, y: 226, width: 495.5, height: 354.5),
            sourceSize: CGSize(width: 669, height: 951)
        ))
        assertRect(rect, CGRect(x: 437, y: 236, width: 475, height: 334))
    }

    func testDisplayRectNeedsSourceSizeAndDrawnDevice() {
        XCTAssertNil(DeviceHubDisplayLocator.displayRect(
            deviceBounds: CGRect(x: 0, y: 0, width: 100, height: 100),
            sourceSize: nil
        ))
        XCTAssertNil(DeviceHubDisplayLocator.displayRect(
            deviceBounds: CGRect(x: 0, y: 0, width: 100, height: 100),
            sourceSize: CGSize(width: 0, height: 678)
        ))
        XCTAssertNil(DeviceHubDisplayLocator.displayRect(
            deviceBounds: .zero,
            sourceSize: CGSize(width: 466, height: 678)
        ))
    }

    func testDrawnBoundsIgnoresPixelsOutsideTheRegion() throws {
        // 2 pixels per point on a 20x10 point window; the region is the right half.
        var buffer = Buffer(width: 40, height: 20, background: (30, 30, 40))
        buffer.fill(x: 2 ..< 6, y: 2 ..< 6, color: (200, 200, 200)) // sidebar content, outside the region
        buffer.fill(x: 24 ..< 30, y: 6 ..< 14, color: (200, 200, 200)) // the device
        let bounds = DeviceHubDisplayLocator.drawnBounds(
            in: buffer.pixels,
            region: CGRect(x: 10, y: 0, width: 10, height: 10),
            windowSize: CGSize(width: 20, height: 10)
        )
        XCTAssertEqual(bounds, CGRect(x: 12, y: 3, width: 3, height: 4))
    }

    func testDrawnBoundsIsNilForAnEmptyDetailArea() {
        let buffer = Buffer(width: 40, height: 20, background: (30, 30, 40))
        XCTAssertNil(DeviceHubDisplayLocator.drawnBounds(
            in: buffer.pixels,
            region: CGRect(x: 10, y: 0, width: 10, height: 10),
            windowSize: CGSize(width: 20, height: 10)
        ))
    }

    func testDrawnBoundsIgnoresFaintDifferences() {
        var buffer = Buffer(width: 40, height: 20, background: (30, 30, 40))
        buffer.fill(x: 24 ..< 30, y: 6 ..< 14, color: (33, 33, 43))
        XCTAssertNil(DeviceHubDisplayLocator.drawnBounds(
            in: buffer.pixels,
            region: CGRect(x: 10, y: 0, width: 10, height: 10),
            windowSize: CGSize(width: 20, height: 10)
        ))
    }

    private func assertRect(_ actual: CGRect, _ expected: CGRect, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual.minX, expected.minX, accuracy: 1.5, file: file, line: line)
        XCTAssertEqual(actual.minY, expected.minY, accuracy: 1.5, file: file, line: line)
        XCTAssertEqual(actual.width, expected.width, accuracy: 1.5, file: file, line: line)
        XCTAssertEqual(actual.height, expected.height, accuracy: 1.5, file: file, line: line)
    }

    private struct Buffer {
        let width: Int
        let height: Int
        private var bytes: [UInt8]

        init(width: Int, height: Int, background: (UInt8, UInt8, UInt8)) {
            self.width = width
            self.height = height
            bytes = []
            for _ in 0 ..< width * height {
                bytes += [background.0, background.1, background.2, 255]
            }
        }

        mutating func fill(x: Range<Int>, y: Range<Int>, color: (UInt8, UInt8, UInt8)) {
            for row in y {
                for column in x {
                    let offset = (row * width + column) * 4
                    bytes[offset] = color.0
                    bytes[offset + 1] = color.1
                    bytes[offset + 2] = color.2
                }
            }
        }

        var pixels: DeviceHubDisplayLocator.PixelBuffer {
            .init(width: width, height: height, bytesPerRow: width * 4, bytes: bytes)
        }
    }
}
