@testable import AutoMobileSDK
import XCTest

#if DEBUG && !os(watchOS)
    final class SdkHighlightOverlayManagerTests: XCTestCase {
        func testCircleScalesDevicePixelsToViewCoordinates() {
            let bounds = SdkHighlightBounds(
                x: 100,
                y: 200,
                width: 300,
                height: 400,
                sourceWidth: 1000,
                sourceHeight: 2000
            )
            XCTAssertEqual(
                bounds.scaled(to: CGSize(width: 100, height: 200)),
                CGRect(x: 10, y: 20, width: 30, height: 40)
            )
        }

        func testMissingSourceDimensionsCannotRender() {
            let bounds = SdkHighlightBounds(x: 0, y: 0, width: 10, height: 10, sourceWidth: nil, sourceHeight: nil)
            XCTAssertNil(bounds.scaled(to: CGSize(width: 100, height: 200)))
        }

        func testRejectsLegacyShapes() {
            for type in ["box", "path"] {
                XCTAssertThrowsError(try JSONDecoder().decode(
                    SdkHighlightShape.self,
                    from: Data("{\"type\":\"\(type)\",\"bounds\":{\"x\":0,\"y\":0,\"width\":10,\"height\":10}}".utf8)
                ))
            }
        }
    }
#endif
