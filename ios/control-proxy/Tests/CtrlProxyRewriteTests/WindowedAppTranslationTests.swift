@testable import CtrlProxyRewrite
import Foundation
import XCTest

/// #6635: an iPadOS windowed app reports its application frame and snapshot hierarchy relative
/// to the window, while touches land in screen space. Sizes and origins below come from the
/// iPad Pro 11-inch (M5) simulator on iOS 27.0 with Playground in a 375x585 window.
@MainActor
final class WindowedAppTranslationTests: XCTestCase {
    private let windowSize = GestureSize(width: 375, height: 585)
    private let screenSize = GestureSize(width: 834, height: 1210)

    func testInsetWindowTranslatesByItsScreenOrigin() {
        XCTAssertEqual(
            windowedAppTranslation(
                appOrigin: .zero, appSize: windowSize,
                windowOrigin: GesturePoint(x: 230, y: 255), windowSize: windowSize
            ),
            GesturePoint(x: 230, y: 255)
        )
    }

    func testFullScreenAndOriginWindowsAreNoOps() {
        XCTAssertNil(windowedAppTranslation(
            appOrigin: .zero, appSize: screenSize, windowOrigin: .zero, windowSize: screenSize
        ))
        // A window tiled to the top-left corner is smaller than the screen but already at the origin.
        XCTAssertNil(windowedAppTranslation(
            appOrigin: .zero, appSize: windowSize, windowOrigin: .zero, windowSize: windowSize
        ))
        XCTAssertNil(windowedAppTranslation(
            appOrigin: .zero, appSize: windowSize,
            windowOrigin: GesturePoint(x: 0.4, y: -0.4), windowSize: windowSize
        ))
    }

    func testTranslationIsRelativeToTheReportedAppOrigin() {
        XCTAssertEqual(
            windowedAppTranslation(
                appOrigin: GesturePoint(x: 10, y: 20), appSize: windowSize,
                windowOrigin: GesturePoint(x: 417, y: 20), windowSize: windowSize
            ),
            GesturePoint(x: 407, y: 0)
        )
    }

    func testDifferentlySizedOrInvalidWindowsAreIgnored() {
        let origin = GesturePoint(x: 230, y: 255)
        XCTAssertNil(windowedAppTranslation(
            appOrigin: .zero, appSize: windowSize, windowOrigin: origin, windowSize: screenSize
        ))
        XCTAssertNil(windowedAppTranslation(
            appOrigin: .zero, appSize: windowSize, windowOrigin: origin,
            windowSize: GestureSize(width: 376.5, height: 585)
        ))
        XCTAssertEqual(
            windowedAppTranslation(
                appOrigin: .zero, appSize: windowSize, windowOrigin: origin,
                windowSize: GestureSize(width: 376, height: 584)
            ),
            origin
        )
        XCTAssertNil(windowedAppTranslation(
            appOrigin: .zero, appSize: windowSize, windowOrigin: origin, windowSize: GestureSize(width: 0, height: 0)
        ))
        XCTAssertNil(windowedAppTranslation(
            appOrigin: .zero, appSize: windowSize,
            windowOrigin: GesturePoint(x: .nan, y: 255), windowSize: windowSize
        ))
        XCTAssertNil(windowedAppTranslation(
            appOrigin: GesturePoint(x: 0, y: .infinity), appSize: windowSize,
            windowOrigin: origin, windowSize: windowSize
        ))
    }

    func testOnlyAutomaticPointOffsetSelectionsAreTranslated() {
        let translation = GesturePoint(x: 230, y: 255)
        let windowed = GestureCoordinateGeometry(
            app: windowSize, screen: screenSize, observation: windowSize, rotation: 0
        )
        let point = GesturePoint(x: 187, y: 311)
        // The captured inset window: mismatch, but no multi-panel mapping, so a point offset.
        let automatic = GestureCoordinateSelection.choose(point: point, geometry: windowed)
        XCTAssertEqual(automatic.strategy, .legacy)
        XCTAssertEqual(automatic.reason, "mappingUndefined(rotation=0,geometryOrPoint)")
        XCTAssertEqual(automatic.offset, point)
        XCTAssertEqual(automatic.windowTranslation(translation), translation)
        XCTAssertNil(automatic.windowTranslation(nil))

        XCTAssertNil(
            GestureCoordinateSelection.choose(point: point, geometry: windowed, forced: .legacy)
                .windowTranslation(translation)
        )
        let normalized = GestureCoordinateSelection.choose(
            point: point, geometry: windowed, forced: .appRelativeObserved
        )
        XCTAssertEqual(normalized.strategy, .appRelativeObserved)
        XCTAssertNil(normalized.windowTranslation(translation))
    }
}
