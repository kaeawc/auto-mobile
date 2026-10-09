@testable import CtrlProxyRewrite
import XCTest

/// #10858: a tap or swipe on a foreground app the runner did not pin is synthesized in screen
/// space instead of waiting on the rebound `XCUIApplication`.
final class GestureDeliveryRouteTests: XCTestCase {
    private let unpinned = GestureApplicationTarget.rebind(bundleId: "com.apple.Preferences")
    private let phone = GestureSize(width: 402, height: 874)

    private func geometry(
        app: GestureSize? = nil, screen: GestureSize? = nil, rotation: Int? = 0
    )
        -> GestureCoordinateGeometry
    {
        GestureCoordinateGeometry(
            app: app ?? phone, screen: screen ?? phone, observation: app ?? phone, rotation: rotation
        )
    }

    func testSynthesizesForUnpinnedFullScreenPortraitApp() {
        XCTAssertEqual(
            GestureDeliveryRoute.resolve(target: unpinned, forced: nil, geometry: geometry()),
            .synthesizedEventRecord(interfaceOrientation: 1)
        )
    }

    func testMapsObservedRotationToInterfaceOrientation() {
        let landscape = GestureSize(width: 874, height: 402)
        for (rotation, orientation) in [(1, 4), (2, 2), (3, 3)] {
            XCTAssertEqual(
                GestureDeliveryRoute.resolve(
                    target: unpinned, forced: nil,
                    geometry: geometry(app: rotation == 2 ? phone : landscape, rotation: rotation)
                ),
                .synthesizedEventRecord(interfaceOrientation: orientation),
                "rotation \(rotation)"
            )
        }
    }

    func testKeepsXCUICoordinateForPinnedApp() {
        XCTAssertEqual(
            GestureDeliveryRoute.resolve(target: .keepPinned, forced: nil, geometry: geometry()), .xcuiCoordinate
        )
    }

    func testKeepsXCUICoordinateWhenAStrategyIsForced() {
        for forced in [TapCoordinateStrategy.legacy, .appRelative, .displayTargetedObserved] {
            XCTAssertEqual(
                GestureDeliveryRoute.resolve(target: unpinned, forced: forced, geometry: geometry()),
                .xcuiCoordinate, "\(forced)"
            )
        }
    }

    func testKeepsXCUICoordinateWithoutAnObservationOfTheApp() {
        XCTAssertEqual(GestureDeliveryRoute.resolve(target: unpinned, forced: nil, geometry: nil), .xcuiCoordinate)
    }

    func testKeepsXCUICoordinateForMultiPanelOrInsetWindow() {
        let inset = geometry(app: GestureSize(width: 600, height: 700), screen: GestureSize(width: 1024, height: 1366))
        XCTAssertEqual(GestureDeliveryRoute.resolve(target: unpinned, forced: nil, geometry: inset), .xcuiCoordinate)
    }

    func testKeepsXCUICoordinateForInvalidSizesOrUnknownRotation() {
        let zero = GestureSize(width: 0, height: 0)
        for candidate in [geometry(app: zero), geometry(screen: zero), geometry(rotation: nil), geometry(rotation: 7)] {
            XCTAssertEqual(
                GestureDeliveryRoute.resolve(target: unpinned, forced: nil, geometry: candidate), .xcuiCoordinate
            )
        }
    }
}
