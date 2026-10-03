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

        #if canImport(UIKit)
            @MainActor
            func testEmptyIdDoesNotCreateWindow() {
                let manager = SdkHighlightOverlayManager(now: { 0 })
                let shape = SdkHighlightShape(bounds: SdkHighlightBounds(
                    x: 0, y: 0, width: 10, height: 10, sourceWidth: 100, sourceHeight: 100
                ))

                XCTAssertFalse(manager.show(id: "", shape: shape))
                XCTAssertNil(manager.renderTargetSize())
                XCTAssertNil(manager.renderedPathBounds(id: ""))
            }

            @MainActor
            func testMissingSourceDimensionsReturnsFalse() {
                let manager = SdkHighlightOverlayManager(now: { 0 })
                defer { manager.remove(id: "invalid") }
                let shape = SdkHighlightShape(bounds: SdkHighlightBounds(
                    x: 0, y: 0, width: 10, height: 10, sourceWidth: nil, sourceHeight: nil
                ))

                XCTAssertFalse(manager.show(id: "invalid", shape: shape))
                XCTAssertNil(manager.renderedPathBounds(id: "invalid"))
            }

            @MainActor
            func testShowReplacesHighlightAndRemoveReleasesWindow() throws {
                let manager = SdkHighlightOverlayManager(now: { 0 })
                defer { manager.remove(id: "circle") }
                let bounds = SdkHighlightBounds(
                    x: 10, y: 20, width: 30, height: 40, sourceWidth: 100, sourceHeight: 200
                )

                XCTAssertTrue(manager.show(id: "circle", shape: SdkHighlightShape(bounds: bounds)))
                let size = try XCTUnwrap(manager.renderTargetSize())
                XCTAssertEqual(manager.renderedPathBounds(id: "circle"), bounds.scaled(to: size))

                let replacement = SdkHighlightBounds(
                    x: 20, y: 40, width: 50, height: 60, sourceWidth: 100, sourceHeight: 200
                )
                XCTAssertTrue(manager.show(id: "circle", shape: SdkHighlightShape(bounds: replacement)))
                XCTAssertEqual(manager.renderedPathBounds(id: "circle"), replacement.scaled(to: size))

                manager.remove(id: "circle")
                XCTAssertNil(manager.renderedPathBounds(id: "circle"))
                XCTAssertNil(manager.renderTargetSize())
            }
        #endif
    }
#endif
