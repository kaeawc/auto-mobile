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
