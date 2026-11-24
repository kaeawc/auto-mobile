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

    /// #19091: Files tiled left and focused, Settings floating behind it. A tap 4 pt right of the
    /// Files tile still went to Files, so it must not switch the tracked app to Settings.
    func testTapNearTheFocusedWindowEdgeDoesNotNameTheBackgroundApp() {
        let settings = ElementBounds(left: 258, top: 246, right: 773, bottom: 1015)
        let frames = ObservedWindowFrames(
            focused: leftTile, background: [(bundleId: "com.apple.Preferences", frame: settings)]
        )
        XCTAssertNil(ElementLocator.backgroundWindowOwner(x: 515, y: 513, in: frames))
        let clear = Double(leftTile.right + ElementLocator.focusedWindowTouchMargin)
        XCTAssertNil(ElementLocator.backgroundWindowOwner(x: clear - 1, y: 513, in: frames))
        XCTAssertEqual(ElementLocator.backgroundWindowOwner(x: clear, y: 513, in: frames), "com.apple.Preferences")
        XCTAssertEqual(ElementLocator.backgroundWindowOwner(x: 640, y: 1000, in: frames), "com.apple.Preferences")
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

    func testBackgroundRootsRankBehindEveryFocusedWindowLayer() {
        let layer = ElementLocator.iosWindowLayerExtra
        // The focused app shows a keyboard: its own windows are already stamped 0 (front) and 1.
        let keyboard = UIElementInfo(
            text: "Keyboard",
            bounds: ElementBounds(left: 521, top: 900, right: 1032, bottom: 1253),
            extras: [layer: "0"]
        )
        let general = UIElementInfo(
            text: "General",
            bounds: ElementBounds(left: 540, top: 200, right: 1000, bottom: 250),
            extras: [layer: "1"]
        )
        let root = UIElementInfo(text: "Settings", bounds: screen, node: [general, keyboard])
        // Files shows an alert over its own window: stamped 0 and 1 inside its tree.
        let files = VisibleAppWindow(
            bundleId: "com.apple.DocumentsApp",
            frame: leftTile,
            hierarchy: UIElementInfo(text: "Files", bounds: leftTile, node: [
                UIElementInfo(text: "Browse", bounds: leftTile, extras: [layer: "1"]),
                UIElementInfo(text: "Alert", bounds: leftTile, extras: [layer: "0"]),
            ])
        )
        let safari = VisibleAppWindow(
            bundleId: "com.apple.mobilesafari",
            frame: leftTile,
            hierarchy: UIElementInfo(text: "Safari", bounds: leftTile)
        )

        let merged = ElementLocator.mergingBackgroundWindows([files, safari], into: root)
        let children = merged.node

        XCTAssertEqual(children?.map(\.text), ["Files", "Safari", "General", "Keyboard"])
        XCTAssertEqual(children?.map { $0.extras?[layer] }, ["2", "4", "1", "0"])
        XCTAssertEqual(
            children?.first?.node?.map { $0.extras?[layer] }, ["3", "2"],
            "Files keeps its alert in front of its own window, both behind Settings"
        )
        XCTAssertEqual(
            children?.map { $0.extras?[ElementLocator.iosWindowPackageExtra] },
            ["com.apple.DocumentsApp", "com.apple.mobilesafari", nil, nil]
        )
    }

    func testUnstampedFocusedAppStillOutranksBackgroundRoots() {
        let root = UIElementInfo(text: "Settings", bounds: screen, node: [UIElementInfo(text: "General")])
        let files = VisibleAppWindow(
            bundleId: "com.apple.DocumentsApp", frame: leftTile, hierarchy: UIElementInfo(text: "Files")
        )
        let merged = ElementLocator.mergingBackgroundWindows([files], into: root)
        XCTAssertEqual(merged.node?.first?.extras?[ElementLocator.iosWindowLayerExtra], "1")
        XCTAssertNil(merged.node?.last?.extras?[ElementLocator.iosWindowLayerExtra])
    }

    private func observedLayout() -> ObservedLayout {
        var layout = ObservedLayout()
        layout.windowFrames = ObservedWindowFrames(
            focused: rightTile, background: [(bundleId: "com.apple.DocumentsApp", frame: leftTile)]
        )
        return layout
    }

    func testTapInABackgroundWindowConsumesTheObservedFrames() {
        var layout = observedLayout()
        XCTAssertEqual(layout.takeTappedBackgroundOwner(x: 341, y: 1212), "com.apple.DocumentsApp")
        XCTAssertNil(layout.takeTappedBackgroundOwner(x: 341, y: 1212))
    }

    func testLaunchOfTheSameAppDropsStaleWindowFrames() {
        var layout = observedLayout()
        layout.foregroundSwitched(appChanged: false)
        XCTAssertNil(layout.takeTappedBackgroundOwner(x: 341, y: 1212))
    }

    func testForegroundChangeAndSetApplicationDropStaleWindowFrames() {
        var switched = observedLayout()
        switched.foregroundSwitched(appChanged: true)
        XCTAssertNil(switched.takeTappedBackgroundOwner(x: 341, y: 1212))
        var invalidated = observedLayout()
        invalidated.invalidate()
        XCTAssertNil(invalidated.windowFrames)
        XCTAssertNil(invalidated.takeTappedBackgroundOwner(x: 341, y: 1212))
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

/// #19064: with Files tiled left and focused, Settings floats behind it. Frames were captured on
/// the iPad Pro 13-inch (M5) simulator, iOS 27.2: Settings' snapshot frame is window-relative
/// (0,0,524,782) while its window is drawn shrunk at (255.34,242) sized 521.32x778.
final class BackgroundWindowPlacementTests: XCTestCase {
    private let screenFrame = CGRect(x: 0, y: 0, width: 1032, height: 1376)
    private let settingsSnapshot = CGRect(x: 0, y: 0, width: 524, height: 782)
    private let settingsWindow = CGRect(x: 255.3401534526854, y: 242.0, width: 521.3196930946292, height: 778.0)
    private let filesLeftTile = ElementBounds(left: 0, top: 0, right: 511, bottom: 1253)

    private func ltrb(_ bounds: ElementBounds?) -> [Int] {
        bounds.map { [$0.left, $0.top, $0.right, $0.bottom] } ?? []
    }

    private func settingsPlacement() throws -> WindowPlacement {
        try XCTUnwrap(ElementLocator.backgroundWindowPlacement(
            appFrame: settingsSnapshot, screenFrame: screenFrame, windowFrame: { self.settingsWindow }
        ))
    }

    func testShrunkFloatingWindowMapsToItsScreenFrame() throws {
        let placement = try settingsPlacement()
        XCTAssertEqual(placement.scale, 778.0 / 782.0, accuracy: 1e-9)
        XCTAssertEqual(ltrb(placement.screenBounds(ElementBounds(clamping: settingsSnapshot))), [255, 242, 776, 1020])
    }

    func testShrunkWindowBehindATileAtTheOriginIsVisible() throws {
        let unplaced = ElementBounds(clamping: settingsSnapshot)
        let placed = try settingsPlacement().screenBounds(unplaced)
        let screen = ElementBounds(clamping: screenFrame)
        XCTAssertTrue(ElementLocator.isVisibleBesideFocused(placed, focused: filesLeftTile, screen: screen))
    }

    func testPlacedTreeKeepsNodesBesideTheFocusedTile() throws {
        // A right-hand row of Settings' window and a left-hand one that Files covers once placed.
        let right = UIElementInfo(
            text: "Language & Region",
            bounds: ElementBounds(left: 16, top: 690, right: 508, bottom: 740)
        )
        let back = UIElementInfo(text: "Back", bounds: ElementBounds(left: 80, top: 12, right: 124, bottom: 56))
        let root = UIElementInfo(
            className: "XCUIApplication", bounds: ElementBounds(clamping: settingsSnapshot), node: [back, right]
        )

        let placed = try ElementLocator.placedOnScreen(root, by: settingsPlacement())
        let visible = try XCTUnwrap(ElementLocator.removingOccluded(placed, by: filesLeftTile))

        XCTAssertEqual(ltrb(visible.bounds), [255, 242, 776, 1020])
        XCTAssertEqual(visible.node?.map(\.text), ["Language & Region"])
        let row = try XCTUnwrap(visible.node?.first?.bounds)
        XCTAssertEqual(row.left, 271)
        XCTAssertEqual(row.top, 928)
        XCTAssertEqual(row.right, 760)
        XCTAssertEqual(row.bottom, 978)
    }

    func testUnscaledTileIsOffsetOnly() throws {
        let placement = try XCTUnwrap(ElementLocator.backgroundWindowPlacement(
            appFrame: CGRect(x: 0, y: 0, width: 511, height: 1253),
            screenFrame: screenFrame,
            windowFrame: { CGRect(x: 521, y: 0, width: 511, height: 1253) }
        ))
        XCTAssertEqual(placement, WindowPlacement(origin: CGPoint(x: 521, y: 0), scale: 1))
    }

    func testScreenSizedAppIsPlacedWithoutReadingItsWindow() throws {
        let placement = try XCTUnwrap(ElementLocator.backgroundWindowPlacement(
            appFrame: screenFrame, screenFrame: screenFrame, windowFrame: {
                XCTFail("a screen-sized app needs no window frame")
                return nil
            }
        ))
        XCTAssertTrue(placement.isIdentity)
    }

    func testScreenSizedAppWithAnOriginIsNotOffsetTwice() throws {
        // Its snapshot is already in screen space, so a non-zero app origin must not move it again.
        let shifted = CGRect(x: 0, y: 24, width: 1032, height: 1376)
        let placement = try XCTUnwrap(ElementLocator.backgroundWindowPlacement(
            appFrame: shifted, screenFrame: screenFrame, windowFrame: { nil }
        ))
        XCTAssertTrue(placement.isIdentity)
        XCTAssertEqual(ltrb(placement.screenBounds(ElementBounds(clamping: shifted))), [0, 24, 1032, 1400])
    }

    func testUnplacedWindowIsReportedAsATruncationReason() {
        var reasons: Set<String> = []
        XCTAssertNil(ElementLocator.backgroundWindowPlacement(
            appFrame: settingsSnapshot, screenFrame: screenFrame, truncationReasons: &reasons, windowFrame: { nil }
        ))
        XCTAssertEqual(reasons, ["background_window_unplaced"])
    }

    func testPlacedWindowAddsNoTruncationReason() {
        var reasons: Set<String> = []
        XCTAssertNotNil(ElementLocator.backgroundWindowPlacement(
            appFrame: settingsSnapshot, screenFrame: screenFrame, truncationReasons: &reasons,
            windowFrame: { self.settingsWindow }
        ))
        XCTAssertTrue(reasons.isEmpty)
    }

    func testPlacedTreeKeepsKeyboardSubtreesInScreenSpace() throws {
        let appBounds = ElementBounds(clamping: settingsSnapshot)
        let key = UIElementInfo(
            className: "UIKeyboardKey",
            bounds: ElementBounds(left: 10, top: 1100, right: 90, bottom: 1160)
        )
        let keyboard = UIElementInfo(
            className: "UIKeyboard", bounds: ElementBounds(left: 0, top: 1028, right: 1032, bottom: 1376), node: [key]
        )
        let field = UIElementInfo(
            className: "UITextField",
            bounds: ElementBounds(left: 16, top: 100, right: 508, bottom: 140)
        )
        let root = UIElementInfo(
            className: "XCUIApplication", bounds: appBounds,
            node: [
                UIElementInfo(className: "UIWindow", bounds: appBounds, node: [field]),
                UIElementInfo(className: "UIWindow", bounds: ElementBounds(clamping: screenFrame), node: [keyboard]),
            ]
        )

        let placed = try ElementLocator.placedOnScreen(root, by: settingsPlacement())

        XCTAssertEqual(ltrb(placed.bounds), [255, 242, 776, 1020])
        XCTAssertEqual(ltrb(placed.node?[0].node?[0].bounds), [271, 341, 760, 381])
        // The keyboard's window, the keyboard and its keys are already screen space.
        XCTAssertEqual(ltrb(placed.node?[1].bounds), [0, 0, 1032, 1376])
        XCTAssertEqual(ltrb(placed.node?[1].node?[0].bounds), [0, 1028, 1032, 1376])
        XCTAssertEqual(ltrb(placed.node?[1].node?[0].node?[0].bounds), [10, 1100, 90, 1160])
    }

    func testUnknownOrDistortedWindowIsLeftOut() {
        XCTAssertNil(ElementLocator.backgroundWindowPlacement(
            appFrame: settingsSnapshot, screenFrame: screenFrame, windowFrame: { nil }
        ))
        XCTAssertNil(ElementLocator.backgroundWindowPlacement(
            appFrame: settingsSnapshot, screenFrame: screenFrame, windowFrame: {
                CGRect(x: 255, y: 242, width: 400, height: 778)
            }
        ))
        XCTAssertNil(ElementLocator.backgroundWindowPlacement(
            appFrame: settingsSnapshot, screenFrame: screenFrame, windowFrame: {
                CGRect(x: 255, y: 242, width: 131, height: 195.5)
            }
        ))
    }
}
