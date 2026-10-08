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

    func testForcedIsATypedFlagNotTheReasonText() {
        let translation = GesturePoint(x: 230, y: 255)
        let point = GesturePoint(x: 187, y: 311)
        // A legacy selection whose reason text happens to read "forced" is still automatic.
        let automatic = GestureCoordinateSelection(
            strategy: .legacy, reason: "forced", normalized: .zero, offset: point
        )
        XCTAssertFalse(automatic.isForced)
        XCTAssertEqual(automatic.windowTranslation(translation), translation)
        // A forced selection stays untranslated whatever its reason text says.
        let renamed = GestureCoordinateSelection(
            strategy: .legacy, reason: "callerForced", normalized: .zero, offset: point, isForced: true
        )
        XCTAssertNil(renamed.windowTranslation(translation))

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

        // The observed centre goes through the same automatic selection as an app node and
        // lands back on the button's screen centre (417,605).
        let center = GesturePoint(x: Double(button.frame.midX), y: Double(button.frame.midY))
        let windowed = GestureCoordinateGeometry(
            app: windowSize, screen: screenSize, observation: windowSize, rotation: 0
        )
        let selection = GestureCoordinateSelection.choose(point: center, geometry: windowed)
        let translation = try XCTUnwrap(selection.windowTranslation(GesturePoint(x: 230, y: 255)))
        let offsetPoint = try XCTUnwrap(selection.offset)
        XCTAssertEqual(
            GesturePoint(x: translation.x + offsetPoint.x, y: translation.y + offsetPoint.y),
            GesturePoint(x: 417, y: 605)
        )
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
}
