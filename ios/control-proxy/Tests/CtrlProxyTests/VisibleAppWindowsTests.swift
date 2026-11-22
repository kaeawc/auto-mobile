@testable import CtrlProxy
import Foundation
import XCTest

/// #18830: observe on an iPad with several visible windows lists each window and merges the
/// background windows' nodes. Frames come from the iPad Pro 13-inch (M5) simulator on iOS 27.2
/// with Files and Settings tiled side by side (screen 1032x1376).
final class VisibleAppWindowsTests: XCTestCase {
    private let screen = ElementBounds(left: 0, top: 0, right: 1032, bottom: 1376)
    private let leftTile = ElementBounds(left: 0, top: 0, right: 511, bottom: 1253)
    private let rightTile = ElementBounds(left: 521, top: 0, right: 1032, bottom: 1253)

    func testCandidatesAreObservedAppsWithoutFocusedOrSpringBoard() {
        XCTAssertEqual(
            ElementLocator.otherWindowCandidates(
                observed: [
                    "com.apple.Preferences",
                    "com.apple.mobilesafari",
                    "com.apple.DocumentsApp",
                    "com.apple.springboard",
                ],
                focusedBundleId: "com.apple.Preferences"
            ),
            ["com.apple.DocumentsApp", "com.apple.mobilesafari"]
        )
    }

    func testTapInABackgroundWindowNamesItsApp() {
        let frames = ObservedWindowFrames(
            focused: rightTile, background: [(bundleId: "com.apple.DocumentsApp", frame: leftTile)]
        )
        // The observed centre of Files' Browse tab while Settings was focused.
        XCTAssertEqual(ElementLocator.backgroundWindowOwner(x: 341, y: 1212, in: frames), "com.apple.DocumentsApp")
        XCTAssertNil(ElementLocator.backgroundWindowOwner(x: 776, y: 378, in: frames))
        // The gap between the tiles and the dock belong to no window.
        XCTAssertNil(ElementLocator.backgroundWindowOwner(x: 516, y: 600, in: frames))
        XCTAssertNil(ElementLocator.backgroundWindowOwner(x: 300, y: 1300, in: frames))
        XCTAssertNil(ElementLocator.backgroundWindowOwner(x: .nan, y: 10, in: frames))
    }

    func testTiledWindowBesideTheFocusedOneIsVisible() {
        XCTAssertTrue(ElementLocator.isVisibleBesideFocused(leftTile, focused: rightTile, screen: screen))
    }

    func testWindowWhollyBehindTheFocusedOneOrOffScreenIsNotVisible() {
        let behind = ElementBounds(left: 600, top: 100, right: 900, bottom: 900)
        XCTAssertFalse(ElementLocator.isVisibleBesideFocused(behind, focused: rightTile, screen: screen))
        let offScreen = ElementBounds(left: 1100, top: 0, right: 1400, bottom: 500)
        XCTAssertFalse(ElementLocator.isVisibleBesideFocused(offScreen, focused: rightTile, screen: screen))
        let empty = ElementBounds(left: 10, top: 10, right: 10, bottom: 10)
        XCTAssertFalse(ElementLocator.isVisibleBesideFocused(empty, focused: rightTile, screen: screen))
    }

    func testOcclusionDropsCoveredLeavesButKeepsContainersWithVisibleChildren() {
        // A full-screen window behind a floating focused window at [329,388,704,874].
        let focused = ElementBounds(left: 329, top: 388, right: 704, bottom: 874)
        let covered = UIElementInfo(
            text: "Covered",
            bounds: ElementBounds(left: 400, top: 500, right: 600, bottom: 540)
        )
        let visible = UIElementInfo(
            text: "Browse",
            bounds: ElementBounds(left: 20, top: 1200, right: 120, bottom: 1250)
        )
        let container = UIElementInfo(
            className: "UIView",
            bounds: ElementBounds(left: 0, top: 300, right: 1032, bottom: 1300),
            node: [covered, visible]
        )
        let root = UIElementInfo(text: "Files", bounds: screen, node: [container])

        let result = ElementLocator.removingOccluded(root, by: focused)

        XCTAssertEqual(result?.node?.count, 1)
        XCTAssertEqual(result?.node?.first?.node?.map(\.text), ["Browse"])
    }

    func testFullyCoveredWindowKeepsOnlyItsRoot() {
        let leaf = UIElementInfo(text: "Hidden", bounds: ElementBounds(left: 600, top: 100, right: 700, bottom: 140))
        let root = UIElementInfo(text: "Files", bounds: leftTile, node: [leaf])
        let result = ElementLocator.removingOccluded(
            root,
            by: ElementBounds(left: 0, top: 0, right: 1032, bottom: 1253)
        )
        XCTAssertEqual(result?.text, "Files")
        XCTAssertNil(result?.node)
    }

    func testBackgroundWindowsGoBeforeTheFocusedAppsChildren() {
        let focusedChild = UIElementInfo(
            text: "General",
            bounds: ElementBounds(left: 540, top: 200, right: 1000, bottom: 250)
        )
        let root = UIElementInfo(text: "Settings", bounds: screen, node: [focusedChild])
        let files = VisibleAppWindow(
            bundleId: "com.apple.DocumentsApp",
            frame: leftTile,
            hierarchy: UIElementInfo(text: "Files", bounds: leftTile, node: [
                UIElementInfo(text: "Browse", bounds: ElementBounds(left: 300, top: 1180, right: 380, bottom: 1240)),
            ])
        )

        let merged = ElementLocator.mergingBackgroundWindows([files], into: root)

        XCTAssertEqual(merged.text, "Settings")
        XCTAssertEqual(merged.node?.map(\.text), ["Files", "General"])
        XCTAssertEqual(merged.node?.first?.node?.first?.text, "Browse")
    }

    func testNoBackgroundWindowsLeavesTheTreeAndSingleWindowUnchanged() {
        let root = UIElementInfo(text: "Settings", bounds: screen)
        let focused = WindowInfo(id: 0, type: 1, isActive: true, isFocused: true, bounds: rightTile)
        XCTAssertEqual(ElementLocator.mergingBackgroundWindows([], into: root).text, "Settings")
        let windows = ElementLocator.windowInfos(focused: focused, background: [])
        XCTAssertEqual(windows.count, 1)
        XCTAssertNil(windows[0].packageName)
    }

    /// `viewHierarchy.windows` from observe on the device (bounds as observe prints them), with
    /// Settings focused after `tapOn` reached it in the right tile.
    private let capturedWindows = """
    [{"bounds":[521,0,1032,1253],"id":0,"isActive":true,"isFocused":true,"packageName":"com.apple.Preferences","type":1},{"bounds":[0,0,511,1253],"id":1,"isActive":false,"isFocused":false,"packageName":"com.apple.DocumentsApp","type":1}]
    """

    func testWindowsEncodeAsObserveReportedThemOnDevice() throws {
        let focused = WindowInfo(
            id: 0, type: 1, isActive: true, isFocused: true, bounds: rightTile, packageName: "com.apple.Preferences"
        )
        let files = VisibleAppWindow(
            bundleId: "com.apple.DocumentsApp", frame: leftTile, hierarchy: UIElementInfo(bounds: leftTile)
        )
        let encoded = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(ElementLocator.windowInfos(focused: focused, background: [files]))
        ) as? [[String: Any]]
        let observed = try JSONSerialization.jsonObject(with: Data(capturedWindows.utf8)) as? [[String: Any]]

        let asObserved = try XCTUnwrap(encoded).map { window -> NSDictionary in
            var window = window
            if let bounds = window["bounds"] as? [String: Int] {
                window["bounds"] = [bounds["left"], bounds["top"], bounds["right"], bounds["bottom"]]
            }
            return window as NSDictionary
        }
        XCTAssertEqual(asObserved, try XCTUnwrap(observed).map { $0 as NSDictionary })
    }

    func testSingleWindowOmitsPackageName() throws {
        let window = WindowInfo(id: 0, type: 1, isActive: true, isFocused: true, bounds: screen)
        let json = try XCTUnwrap(String(data: JSONEncoder().encode(window), encoding: .utf8))
        XCTAssertFalse(json.contains("packageName"))
    }

    func testWindowsListTheFocusedWindowFirstThenBackgroundWindowsUnfocused() {
        let focused = WindowInfo(
            id: 0, type: 1, isActive: true, isFocused: true, bounds: rightTile, packageName: "com.apple.Preferences"
        )
        let files = VisibleAppWindow(
            bundleId: "com.apple.DocumentsApp", frame: leftTile, hierarchy: UIElementInfo(bounds: leftTile)
        )

        let windows = ElementLocator.windowInfos(focused: focused, background: [files])

        XCTAssertEqual(windows.map(\.packageName), ["com.apple.Preferences", "com.apple.DocumentsApp"])
        XCTAssertEqual(windows.map(\.isFocused), [true, false])
        XCTAssertEqual(windows.map(\.isActive), [true, false])
        XCTAssertEqual(windows.map(\.id), [0, 1])
        XCTAssertEqual(windows[1].bounds?.left, 0)
        XCTAssertEqual(windows[1].bounds?.right, 511)
    }
}
