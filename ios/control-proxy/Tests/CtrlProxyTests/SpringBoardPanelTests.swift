@testable import CtrlProxy
import Foundation
import XCTest

/// Window display ids of the SpringBoard home-screen snapshot captured on an iOS 27.1 iPhone Duo
/// simulator, in snapshot order (#17046). Display 1 is the cover (main) and 3 the inner panel.
final class SpringBoardPanelTests: XCTestCase {
    private let foldedWindows: [UInt64] = [
        1, 3, 1, 3, 1, 3, 1, 3, 1, 1, 1, 1, 3, 3, 3, 1, 1, 1, 1, 3, 3, 3, 3, 1, 1, 3, 3, 1, 1, 1, 3, 1, 3, 1, 3,
        1, 3, 1, 3,
    ]
    private let unfoldedWindows: [UInt64] = [
        1, 3, 1, 3, 1, 3, 1, 3, 1, 1, 1, 1, 3, 3, 3, 3, 1, 1, 1, 1, 3, 3, 3, 3, 1, 1, 3, 3, 3, 3, 1, 3, 1, 3, 1,
        3, 1, 3, 1, 3, 1, 3,
    ]

    func testFoldedSnapshotSelectsTheCoverPanel() {
        XCTAssertEqual(
            SpringBoardPanel.select(windowDisplayIds: foldedWindows, mainDisplayId: 1),
            SpringBoardPanel.Selection(displayId: 1, isMainDisplay: true)
        )
    }

    func testUnfoldedSnapshotSelectsTheInnerPanel() {
        XCTAssertEqual(
            SpringBoardPanel.select(windowDisplayIds: unfoldedWindows, mainDisplayId: 1),
            SpringBoardPanel.Selection(displayId: 3, isMainDisplay: false)
        )
    }

    func testSinglePanelAmbiguousAndUnknownMainSelectNothing() {
        XCTAssertNil(SpringBoardPanel.select(windowDisplayIds: [1, 1, 1], mainDisplayId: 1))
        XCTAssertNil(SpringBoardPanel.select(windowDisplayIds: [1, 3, 1, 3], mainDisplayId: 1))
        XCTAssertNil(SpringBoardPanel.select(windowDisplayIds: [], mainDisplayId: 1))
        XCTAssertNil(SpringBoardPanel.select(windowDisplayIds: unfoldedWindows, mainDisplayId: nil))
    }

    /// Portrait window frames from the captured unfolded snapshot against the landscape bounds the
    /// same observe reported for them, which match the icons on the inner panel's screenshot.
    func testLandscapeBoundsMatchTheCapturedHomeScreen() {
        func rotated(_ left: Int, _ top: Int, _ right: Int, _ bottom: Int) -> [Int] {
            let bounds = SpringBoardPanel.landscapeBounds(
                ElementBounds(left: left, top: top, right: right, bottom: bottom), portraitHeight: 951
            )
            return [bounds.left, bounds.top, bounds.right, bounds.bottom]
        }
        // Settings icon and the Spotlight button, as the runner's snapshot framed them.
        XCTAssertEqual(rotated(52, 814, 138, 882), [69, 52, 137, 138])
        XCTAssertEqual(rotated(597, 23, 645, 71), [880, 597, 928, 645])
    }

    func testRotationKeepsSizeAndTurnsTheWindowIntoLandscape() {
        let window = SpringBoardPanel.landscapeBounds(
            ElementBounds(left: 0, top: 0, right: 669, bottom: 951), portraitHeight: 951
        )
        XCTAssertEqual([window.left, window.top, window.right, window.bottom], [0, 0, 951, 669])
    }

    func testAlertButtonIsRotatedIntoTheInnerPanelAndUntouchedOnTheCover() {
        let button = UIElementInfo(
            text: "Allow", bounds: ElementBounds(left: 52, top: 814, right: 139, bottom: 882)
        )
        let alert = UIElementInfo(
            className: "Alert", bounds: ElementBounds(left: 20, top: 700, right: 446, bottom: 900), node: [button]
        )
        let inner = ElementLocator.alertsInObservedSpace([alert], innerPanelPortraitHeight: 951)
        let moved = inner.first?.node?.first?.bounds
        XCTAssertEqual([moved?.left, moved?.top, moved?.right, moved?.bottom], [69, 52, 137, 139])
        XCTAssertEqual(inner.first?.bounds?.left, 951 - 900)

        let cover = ElementLocator.alertsInObservedSpace([alert], innerPanelPortraitHeight: nil)
        let kept = cover.first?.node?.first?.bounds
        XCTAssertEqual([kept?.left, kept?.top, kept?.right, kept?.bottom], [52, 814, 139, 882])
        XCTAssertEqual(cover.first?.bounds?.left, 20)
    }

    func testFreshSpringBoardAlertOverAnotherAppUsesItsOwningPanelSpace() {
        // OK in the captured VoiceOver system alert, while Settings is the foreground app.
        let button = UIElementInfo(text: "OK", bounds: ElementBounds(left: 502, top: 331, right: 550, bottom: 619))
        // The lit inner panel's window (display 3, portrait 669x951) is the only window in the snapshot.
        let height = SpringBoardPanel.alertPortraitHeight(
            windowDisplayId: 3, mainDisplayId: 1, windowPortraitHeight: 951
        )
        let rotated = ElementLocator.alertsInObservedSpace([button], innerPanelPortraitHeight: height)[0]
        XCTAssertEqual(height, 951)
        XCTAssertEqual(
            [rotated.bounds?.left, rotated.bounds?.top, rotated.bounds?.right, rotated.bounds?.bottom],
            [332, 502, 620, 550]
        )
        // Cover-panel windows, unknown displays and a missing main display stay untouched.
        for (owner, main) in [(UInt64(1), UInt64?(1)), (nil, 1), (3, nil)] {
            let unchangedHeight = SpringBoardPanel.alertPortraitHeight(
                windowDisplayId: owner, mainDisplayId: main, windowPortraitHeight: 951
            )
            XCTAssertNil(unchangedHeight)
            let unchanged = ElementLocator.alertsInObservedSpace([button], innerPanelPortraitHeight: unchangedHeight)[0]
            XCTAssertEqual(
                [unchanged.bounds?.left, unchanged.bounds?.top, unchanged.bounds?.right, unchanged.bounds?.bottom],
                [502, 331, 550, 619]
            )
        }
    }

    func testRotatedTreeRotatesEveryDescendantAndReplacesTheRootBounds() {
        let child = UIElementInfo(
            text: "Settings", bounds: ElementBounds(left: 52, top: 814, right: 139, bottom: 882)
        )
        let root = UIElementInfo(
            className: "Application", bounds: ElementBounds(left: 0, top: 0, right: 466, bottom: 678), node: [child]
        )
        let rotated = ElementLocator.rotatedIntoLandscape(
            root, portraitHeight: 951, rootBounds: ElementBounds(left: 0, top: 0, right: 951, bottom: 669)
        )
        XCTAssertEqual(rotated.bounds?.right, 951)
        XCTAssertEqual(rotated.bounds?.bottom, 669)
        let moved = rotated.node?.first
        XCTAssertEqual(moved?.text, "Settings")
        XCTAssertEqual(moved?.bounds?.left, 69)
        XCTAssertEqual(moved?.bounds?.top, 52)
        XCTAssertEqual(moved?.bounds?.right, 137)
        XCTAssertEqual(moved?.bounds?.bottom, 139)
    }
}

/// Frames captured on an iPhone 18 Pro Max simulator (iOS 27.2) with Maps rotated to landscape
/// (`rotation` 1) and its location alert up (#18858). SpringBoard's root frame was 956x440, but the
/// window hosting the alert stayed 440x956 and framed the alert in portrait space.
final class PortraitSpringBoardRotationTests: XCTestCase {
    private let alertWindow = CGRect(x: 0, y: 0, width: 440, height: 956)
    private let landscapeApp = CGRect(x: 0, y: 0, width: 956, height: 440)

    private func resolve(window: CGRect, app: CGRect, rotation: Int?) -> PortraitSpringBoardRotation? {
        PortraitSpringBoardRotation.resolve(alertWindowFrame: window, appFrame: app, deviceRotation: rotation)
    }

    private func box(_ bounds: ElementBounds?) -> [Int?] {
        [bounds?.left, bounds?.top, bounds?.right, bounds?.bottom]
    }

    func testCapturedLandscapeAlertIsRotatedOntoTheButtonsTheScreenshotShows() throws {
        let rotation = try XCTUnwrap(
            resolve(window: alertWindow, app: landscapeApp, rotation: 1)
        )
        let buttons = [
            UIElementInfo(text: "Allow Once", bounds: ElementBounds(left: 175, top: 334, right: 223, bottom: 622)),
            UIElementInfo(
                text: "Allow While Using App", bounds: ElementBounds(left: 119, top: 334, right: 167, bottom: 622)
            ),
            UIElementInfo(text: "Don’t Allow", bounds: ElementBounds(left: 63, top: 334, right: 111, bottom: 622)),
        ]
        let alert = UIElementInfo(
            text: "Allow “Maps” to use your location?",
            className: "UIAlertController",
            bounds: ElementBounds(left: 47, top: 318, right: 413, bottom: 638),
            node: buttons
        )

        let rotated = ElementLocator.rotatedIntoLandscape(alert, portraitSpringBoard: rotation)

        // The bounds the fixed runner reported on the same device; "Don’t Allow" is drawn at
        // x 334-622, y 329-375 in the landscape screenshot, below the other two buttons.
        XCTAssertEqual(box(rotated.bounds), [318, 27, 638, 393])
        XCTAssertEqual(rotated.node?.map { box($0.bounds) }, [
            [334, 217, 622, 265],
            [334, 273, 622, 321],
            [334, 329, 622, 377],
        ])
        XCTAssertEqual(rotated.node?.map(\.text), ["Allow Once", "Allow While Using App", "Don’t Allow"])
    }

    func testLandscapeRightIsTheOppositeQuarterTurn() throws {
        let rotation = try XCTUnwrap(
            resolve(window: alertWindow, app: landscapeApp, rotation: 3)
        )
        let moved = rotation.landscapeBounds(ElementBounds(left: 63, top: 334, right: 111, bottom: 622))
        XCTAssertEqual(box(moved), [956 - 622, 63, 956 - 334, 111])
    }

    func testWindowsThatAlreadyMatchTheAppAreLeftAlone() {
        // Portrait app over a portrait window, and SpringBoard's own (landscape) root frame.
        XCTAssertNil(
            PortraitSpringBoardRotation.resolve(alertWindowFrame: alertWindow, appFrame: alertWindow, deviceRotation: 0)
        )
        XCTAssertNil(
            resolve(window: landscapeApp, app: landscapeApp, rotation: 1)
        )
        // A transposed window without landscape evidence, or with an unsupported rotation.
        for rotation in [nil, 0, 2] {
            XCTAssertNil(
                PortraitSpringBoardRotation.resolve(
                    alertWindowFrame: alertWindow, appFrame: landscapeApp, deviceRotation: rotation
                )
            )
        }
        // Different sizes (an inset iPad window) and empty frames.
        XCTAssertNil(
            PortraitSpringBoardRotation.resolve(
                alertWindowFrame: alertWindow, appFrame: CGRect(x: 0, y: 0, width: 800, height: 440), deviceRotation: 1
            )
        )
        XCTAssertNil(
            PortraitSpringBoardRotation.resolve(alertWindowFrame: .zero, appFrame: landscapeApp, deviceRotation: 1)
        )
    }
}
