@testable import CtrlProxy
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

    func testInsetWindowPointOffsetsAreDeliveredAsScreenPoints() {
        let windowed = GestureCoordinateGeometry(
            app: windowSize, screen: screenSize, observation: screenSize, rotation: 0,
            appOrigin: .zero, windowTranslation: GesturePoint(x: 230, y: 255)
        )
        // A screen point inside the inset window: mismatch, but no multi-panel mapping, so the
        // observed point is the delivered offset with no window origin added (#18830).
        let point = GesturePoint(x: 417, y: 566)
        let automatic = GestureCoordinateSelection.choose(point: point, geometry: windowed)
        XCTAssertEqual(automatic.strategy, .legacy)
        XCTAssertEqual(automatic.reason, "mappingUndefined(rotation=0,geometryOrPoint)")
        XCTAssertEqual(automatic.offset, point)
        XCTAssertEqual(
            GestureCoordinateSelection.choose(point: point, geometry: windowed, forced: .legacy).offset,
            point
        )
    }

    func testForcedIsATypedFlagNotTheReasonText() {
        let point = GesturePoint(x: 187, y: 311)
        // A legacy selection whose reason text happens to read "forced" is still automatic.
        let automatic = GestureCoordinateSelection(
            strategy: .legacy, reason: "forced", normalized: .zero, offset: point
        )
        XCTAssertFalse(automatic.isForced)
        let renamed = GestureCoordinateSelection(
            strategy: .legacy, reason: "callerForced", normalized: .zero, offset: point, isForced: true
        )
        XCTAssertTrue(renamed.isForced)

        let windowed = GestureCoordinateGeometry(
            app: windowSize, screen: screenSize, observation: windowSize, rotation: 0
        )
        XCTAssertTrue(GestureCoordinateSelection.choose(point: point, geometry: windowed, forced: .legacy).isForced)
        XCTAssertTrue(
            GestureCoordinateSelection.choose(point: point, geometry: windowed, forced: .appRelativeObserved).isForced
        )
        XCTAssertFalse(GestureCoordinateSelection.choose(point: point, geometry: windowed).isForced)
    }

    func testSpringboardAlertsMoveIntoTheWindowSpaceTheGesturePathTranslatesBack() throws {
        let appFrame = CGRect(x: 0, y: 0, width: 375, height: 585)
        let springboardFrame = CGRect(x: 0, y: 0, width: 834, height: 1210)
        let windowFrame = CGRect(x: 230, y: 255, width: 375, height: 585)
        var windowReads = 0
        let offset = ElementLocator.springboardAlertOffset(
            appFrame: appFrame, springboardFrame: springboardFrame,
            windowFrame: { windowReads += 1; return windowFrame }
        )
        XCTAssertEqual(offset, CGPoint(x: -230, y: -255))
        XCTAssertEqual(windowReads, 1)

        // A SpringBoard alert and its button, in screen space, keep their nesting after the shift.
        let alert = ElementLocator.screenFrame(
            CGRect(x: 267, y: 480, width: 300, height: 250), enclosingFrame: nil, coordinateOffset: offset
        )
        let button = ElementLocator.screenFrame(
            CGRect(x: 287, y: 585, width: 260, height: 40), enclosingFrame: alert.frame, coordinateOffset: alert.offset
        )
        XCTAssertEqual(button.frame, CGRect(x: 57, y: 330, width: 260, height: 40))

        // Moving the merged hierarchy into screen space lands the button back on its screen frame.
        let translation = try XCTUnwrap(ElementLocator.windowScreenTranslation(
            appFrame: appFrame, screenFrame: springboardFrame, windowFrame: { windowFrame }
        ))
        let merged = UIElementInfo(
            bounds: ElementBounds(clamping: appFrame),
            node: [UIElementInfo(bounds: ElementBounds(clamping: button.frame))]
        )
        let screen = ElementLocator.translatedToScreen(merged, by: translation)
        XCTAssertEqual(screen.node?.first?.bounds?.left, 287)
        XCTAssertEqual(screen.node?.first?.bounds?.top, 585)
        XCTAssertEqual(screen.node?.first?.bounds?.right, 547)
        XCTAssertEqual(screen.node?.first?.bounds?.bottom, 625)
    }

    func testSpringboardAlertsStayPutWithoutAnInsetWindow() {
        var windowReads = 0
        let read: () -> CGRect? = { windowReads += 1; return CGRect(x: 230, y: 255, width: 375, height: 585) }
        let screen = CGRect(x: 0, y: 0, width: 834, height: 1210)
        // Full-screen and rotated full-screen apps never query the window.
        XCTAssertEqual(
            ElementLocator.springboardAlertOffset(appFrame: screen, springboardFrame: screen, windowFrame: read),
            .zero
        )
        XCTAssertEqual(
            ElementLocator.springboardAlertOffset(
                appFrame: CGRect(x: 0, y: 0, width: 1210, height: 834), springboardFrame: screen, windowFrame: read
            ),
            .zero
        )
        XCTAssertEqual(windowReads, 0)

        let inset = CGRect(x: 0, y: 0, width: 375, height: 585)
        // An unavailable window, or one that is not the app's, leaves screen-space bounds alone.
        XCTAssertEqual(
            ElementLocator.springboardAlertOffset(appFrame: inset, springboardFrame: screen, windowFrame: { nil }),
            .zero
        )
        XCTAssertEqual(
            ElementLocator.springboardAlertOffset(
                appFrame: inset, springboardFrame: screen, windowFrame: { screen }
            ),
            .zero
        )
        // An unreadable SpringBoard frame has no mismatch to act on.
        XCTAssertEqual(
            ElementLocator.springboardAlertOffset(appFrame: inset, springboardFrame: .zero, windowFrame: read),
            .zero
        )
        XCTAssertEqual(windowReads, 0)
    }

    /// #18830, mt0098c on an iPad Pro 13-inch (M5), iOS 27.2: Files resized to a 1201x865 window
    /// at screen (-135,83). Observe reported the Search button at window-relative [1151,14,1187,50]
    /// and the keyboard at screen [2,596,1378,1016] in one tree.
    func testInsetWindowHierarchyMovesIntoScreenSpaceExceptTheKeyboard() throws {
        let appFrame = CGRect(x: 0, y: 0, width: 1201, height: 865)
        let translation = try XCTUnwrap(ElementLocator.windowScreenTranslation(
            appFrame: appFrame,
            screenFrame: CGRect(x: 0, y: 0, width: 1376, height: 1032),
            windowFrame: { CGRect(x: -135, y: 83, width: 1201, height: 865) }
        ))
        XCTAssertEqual(translation, CGPoint(x: -135, y: 83))

        let appBounds = ElementBounds(clamping: appFrame)
        let screenBounds = ElementBounds(left: 0, top: 0, right: 1376, bottom: 1032)
        let key = UIElementInfo(
            className: "UIKeyboardKey",
            bounds: ElementBounds(left: 10, top: 700, right: 90, bottom: 760)
        )
        let keyboard = UIElementInfo(
            className: "UIKeyboard", bounds: ElementBounds(left: 2, top: 596, right: 1378, bottom: 1016), node: [key]
        )
        let assistantBar = UIElementInfo(
            className: "UIView",
            bounds: ElementBounds(left: 2, top: 541, right: 1378, bottom: 596)
        )
        let observed = UIElementInfo(
            className: "XCUIApplication",
            bounds: appBounds,
            node: [
                UIElementInfo(className: "UIWindow", bounds: appBounds, node: [
                    UIElementInfo(
                        text: "Search", className: "UIButton",
                        bounds: ElementBounds(left: 1151, top: 14, right: 1187, bottom: 50)
                    ),
                ]),
                UIElementInfo(className: "UIWindow", bounds: screenBounds, node: [assistantBar, keyboard]),
            ]
        )
        let screen = ElementLocator.translatedToScreen(observed, by: translation)
        let bounds = { (node: UIElementInfo?) in
            node?.bounds.map { [$0.left, $0.top, $0.right, $0.bottom] }
        }
        XCTAssertEqual(bounds(screen), [-135, 83, 1066, 948])
        // The Search button's screen centre (1034,115) matches where the tap landed on the device.
        XCTAssertEqual(bounds(screen.node?[0].node?[0]), [1016, 97, 1052, 133])
        // The keyboard's own window, its assistant bar and its keys are already screen space.
        XCTAssertEqual(bounds(screen.node?[1]), [0, 0, 1376, 1032])
        XCTAssertEqual(bounds(screen.node?[1].node?[0]), [2, 541, 1378, 596])
        XCTAssertEqual(bounds(screen.node?[1].node?[1]), [2, 596, 1378, 1016])
        XCTAssertEqual(bounds(screen.node?[1].node?[1].node?[0]), [10, 700, 90, 760])

        // Hosts read the screen size from the root, so the root reports the screen.
        XCTAssertEqual(bounds(ElementLocator.withRootBounds(screen, screenBounds)), [0, 0, 1376, 1032])
    }

    func testKeyboardInsideTheAppWindowKeepsOnlyTheKeyboardInScreenSpace() throws {
        let appBounds = ElementBounds(left: 0, top: 0, right: 596, bottom: 775)
        let keyboard = UIElementInfo(
            className: "UIKeyboard",
            bounds: ElementBounds(left: 0, top: 1028, right: 1032, bottom: 1373)
        )
        let label = UIElementInfo(
            className: "UILabel",
            bounds: ElementBounds(left: 20, top: 67, right: 150, bottom: 108)
        )
        let observed = UIElementInfo(
            className: "XCUIApplication", bounds: appBounds,
            node: [UIElementInfo(className: "UIWindow", bounds: appBounds, node: [label, keyboard])]
        )
        let screen = ElementLocator.translatedToScreen(observed, by: CGPoint(x: 218, y: 243))
        XCTAssertEqual(screen.node?[0].node?[0].bounds?.left, 238)
        XCTAssertEqual(screen.node?[0].node?[0].bounds?.top, 310)
        XCTAssertEqual(screen.node?[0].node?[1].bounds?.top, 1028)
    }

    func testScreenSizedAppIsNotTranslated() {
        var windowReads = 0
        let screen = CGRect(x: 0, y: 0, width: 1032, height: 1376)
        XCTAssertNil(ElementLocator.windowScreenTranslation(
            appFrame: screen, screenFrame: screen, windowFrame: { windowReads += 1; return screen }
        ))
        XCTAssertEqual(windowReads, 0)
        let node = UIElementInfo(bounds: ElementBounds(left: 1, top: 2, right: 3, bottom: 4))
        XCTAssertEqual(ElementLocator.translatedToScreen(node, by: .zero).bounds?.right, 3)
    }
}
