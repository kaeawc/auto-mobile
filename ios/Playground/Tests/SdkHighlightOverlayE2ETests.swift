@testable import AutoMobileSDK
import XCTest

#if DEBUG && canImport(UIKit) && !os(watchOS)
import UIKit

/// End-to-end coverage for issue #2682 on the Playground host app: drive the real
/// `SdkHighlightOverlayManager` against a live `UIWindow`/`CAShapeLayer` on the
/// simulator and assert the drawn overlay frame lands on the intended element
/// bounds (within tolerance) after device-coordinate → view-space mapping.
final class SdkHighlightOverlayE2ETests: XCTestCase {
    private let tolerance: CGFloat = 2

    private func boxShape(
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        sourceWidth: Int?,
        sourceHeight: Int?
    ) -> SdkHighlightShape {
        SdkHighlightShape(
            type: "box",
            bounds: SdkHighlightBounds(
                x: x,
                y: y,
                width: width,
                height: height,
                sourceWidth: sourceWidth,
                sourceHeight: sourceHeight
            ),
            points: nil,
            style: nil
        )
    }

    private func assertFrame(
        _ frame: CGRect?,
        x: CGFloat,
        y: CGFloat,
        width: CGFloat,
        height: CGFloat,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard let frame else {
            XCTFail("Expected a rendered highlight frame", file: file, line: line)
            return
        }
        XCTAssertEqual(frame.origin.x, x, accuracy: tolerance, file: file, line: line)
        XCTAssertEqual(frame.origin.y, y, accuracy: tolerance, file: file, line: line)
        XCTAssertEqual(frame.size.width, width, accuracy: tolerance, file: file, line: line)
        XCTAssertEqual(frame.size.height, height, accuracy: tolerance, file: file, line: line)
    }

    @MainActor
    func testHighlightLandsOnElementWhenSourceMatchesView() {
        let manager = SdkHighlightOverlayManager(ttlSeconds: 60)
        let id = "e2e-identity"
        defer { manager.remove(id: id) }

        // First render to materialize the overlay window so we can read its size.
        let screen = UIScreen.main.bounds.size
        let shape = boxShape(
            x: 40, y: 80, width: 120, height: 60,
            sourceWidth: Int(screen.width.rounded()),
            sourceHeight: Int(screen.height.rounded())
        )
        XCTAssertTrue(manager.show(id: id, shape: shape))

        guard let target = manager.renderTargetSize() else {
            return XCTFail("Overlay window was not created")
        }
        // Overlay window should fill the screen, so source==target => identity mapping.
        XCTAssertEqual(target.width, screen.width, accuracy: tolerance)
        XCTAssertEqual(target.height, screen.height, accuracy: tolerance)
        assertFrame(manager.renderedPathBounds(id: id), x: 40, y: 80, width: 120, height: 60)
    }

    @MainActor
    func testHighlightScalesAcrossSourceViewMismatch() {
        let manager = SdkHighlightOverlayManager(ttlSeconds: 60)
        let id = "e2e-scale"
        defer { manager.remove(id: id) }

        // Source space is half the view in width and double in height:
        // scaleX = 2, scaleY = 0.5, independent of the concrete screen size.
        let screen = UIScreen.main.bounds.size
        let shape = boxShape(
            x: 30, y: 200, width: 50, height: 80,
            sourceWidth: Int((screen.width / 2).rounded()),
            sourceHeight: Int((screen.height * 2).rounded())
        )
        XCTAssertTrue(manager.show(id: id, shape: shape))

        guard let target = manager.renderTargetSize() else {
            return XCTFail("Overlay window was not created")
        }
        let scaleX = target.width / (screen.width / 2).rounded()
        let scaleY = target.height / (screen.height * 2).rounded()
        assertFrame(
            manager.renderedPathBounds(id: id),
            x: 30 * scaleX,
            y: 200 * scaleY,
            width: 50 * scaleX,
            height: 80 * scaleY
        )
    }

    @MainActor
    func testHighlightIsRejectedWhenSourceDimensionsMissing() {
        let manager = SdkHighlightOverlayManager(ttlSeconds: 60)
        let id = "e2e-reject"
        defer { manager.remove(id: id) }

        let shape = boxShape(
            x: 40, y: 80, width: 120, height: 60,
            sourceWidth: nil, sourceHeight: nil
        )
        XCTAssertFalse(manager.show(id: id, shape: shape))
        XCTAssertNil(manager.renderedPathBounds(id: id))
    }
}
#endif
