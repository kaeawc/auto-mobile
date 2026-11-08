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

    func testPixelSourceGivesTheSameDisplayAsPointSource() throws {
        let bounds = CGRect(x: 547, y: 225, width: 256.5, height: 355.5)
        let points = try XCTUnwrap(DeviceHubDisplayLocator.displayRect(
            deviceBounds: bounds,
            sourceSize: CGSize(width: 466, height: 678)
        ))
        let pixels = try XCTUnwrap(DeviceHubDisplayLocator.displayRect(
            deviceBounds: bounds,
            sourceSize: CGSize(width: 1398, height: 2034)
        ))
        assertRect(pixels, points)
        let inner = CGRect(x: 427, y: 226, width: 495.5, height: 354.5)
        let innerPixels = try XCTUnwrap(DeviceHubDisplayLocator.displayRect(
            deviceBounds: inner,
            sourceSize: CGSize(width: 2853, height: 2007)
        ))
        assertRect(innerPixels, CGRect(x: 437, y: 236, width: 475, height: 334))
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

    func testDaemonScaleReadsSmallThreeTimesSourceAsPixels() throws {
        // A 200x300 pt display drawn at zoom 1: the device is the display plus a 20.5 pt bezel.
        let bounds = CGRect(x: 100, y: 100, width: 241, height: 341)
        let points = try XCTUnwrap(DeviceHubDisplayLocator.displayRect(
            deviceBounds: bounds,
            sourceSize: CGSize(width: 200, height: 300),
            sourceScale: 1
        ))
        assertRect(points, CGRect(x: 120.5, y: 120.5, width: 200, height: 300))
        // Its 3x screenshot is 600x900 px, under the 1000 pt long edge the heuristic accepts as 1x.
        let pixels = try XCTUnwrap(DeviceHubDisplayLocator.displayRect(
            deviceBounds: bounds,
            sourceSize: CGSize(width: 600, height: 900),
            sourceScale: 3
        ))
        assertRect(pixels, points)
        let guessed = try XCTUnwrap(DeviceHubDisplayLocator.displayRect(
            deviceBounds: bounds,
            sourceSize: CGSize(width: 600, height: 900)
        ))
        XCTAssertGreaterThan(abs(guessed.width - points.width), 1)
    }

    func testDaemonScaleOfOneKeepsLongPointSource() {
        // A 1366 pt long edge is points when the daemon says so; the heuristic would halve it.
        let size = CGSize(width: 1024, height: 1366)
        XCTAssertEqual(DeviceHubDisplayLocator.pointSize(of: size, sourceScale: 1), size)
        XCTAssertEqual(DeviceHubDisplayLocator.pointSize(of: size), CGSize(width: 512, height: 683))
    }

    func testFractionalDaemonScaleIsUsedAsIs() {
        let size = DeviceHubDisplayLocator.pointSize(of: CGSize(width: 1080, height: 2340), sourceScale: 2.5)
        XCTAssertEqual(size, CGSize(width: 432, height: 936))
    }

    func testMissingOrInvalidDaemonScaleFallsBackToHeuristic() {
        let pixels = CGSize(width: 1398, height: 2034)
        let points = CGSize(width: 466, height: 678)
        XCTAssertEqual(DeviceHubDisplayLocator.pointSize(of: pixels), points)
        XCTAssertEqual(DeviceHubDisplayLocator.pointSize(of: pixels, sourceScale: nil), points)
        XCTAssertEqual(DeviceHubDisplayLocator.pointSize(of: pixels, sourceScale: 0), points)
        XCTAssertEqual(DeviceHubDisplayLocator.pointSize(of: pixels, sourceScale: -3), points)
        XCTAssertEqual(DeviceHubDisplayLocator.pointSize(of: pixels, sourceScale: .infinity), points)
        XCTAssertEqual(DeviceHubDisplayLocator.pointSize(of: pixels, sourceScale: .nan), points)
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
