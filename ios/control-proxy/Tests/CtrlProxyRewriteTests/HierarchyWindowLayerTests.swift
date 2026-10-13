@testable import CtrlProxyRewrite
import Foundation
import XCTest

/// Window identity coverage using test/fixtures/observe-output/ios-prototype-sheet.
/// Regenerate the runner golden with AUTOMOBILE_UPDATE_FIXTURES=1 when running this suite.
final class HierarchyWindowLayerTests: XCTestCase {
    private struct HierarchyDocument: Codable {
        let hierarchy: UIElementInfo
    }

    private var fixtureDirectory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/observe-output/ios-prototype-sheet")
    }

    private func loadCapture() throws -> UIElementInfo {
        let url = fixtureDirectory.appendingPathComponent("ios-sheet-prototype-over-playground.raw-xcuitest.json")
        return try JSONDecoder().decode(HierarchyDocument.self, from: Data(contentsOf: url)).hierarchy
    }

    private func optimizedRoot(_ root: UIElementInfo) throws -> UIElementInfo {
        let roots = ElementLocator.optimizeHierarchy(root, isRoot: true)
        XCTAssertEqual(roots.count, 1)
        return try XCTUnwrap(roots.first)
    }

    private func encoded<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
        return try encoder.encode(value)
    }

    private func removingStamps(_ element: UIElementInfo) -> UIElementInfo {
        var extras = element.extras
        extras?.removeValue(forKey: ElementLocator.iosWindowLayerExtra)
        if extras?.isEmpty == true { extras = nil }
        return ElementLocator.copying(element, node: element.node?.map(removingStamps), extras: extras)
    }

    private func assertUnstamped(_ element: UIElementInfo, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertNil(element.extras?[ElementLocator.iosWindowLayerExtra], file: file, line: line)
        for child in element.node ?? [] {
            assertUnstamped(child, file: file, line: line)
        }
    }

    private func assertNoWindows(_ element: UIElementInfo, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertNotEqual(element.className, "UIWindow", file: file, line: line)
        for child in element.node ?? [] {
            assertNoWindows(child, file: file, line: line)
        }
    }

    private func assertSheetChildren(_ root: UIElementInfo, file: StaticString = #filePath, line: UInt = #line) {
        let children = root.node ?? []
        XCTAssertEqual(children.map(\.className), [
            "UINavigationBar", "UICollectionView", "UIToolbar", "UITabBar",
            "UILabel", "UIButton", "UITextField", "UIButton",
        ], file: file, line: line)
        XCTAssertEqual(children.map(\.resourceId), [
            "Discover", nil, "Toolbar", nil, "s6", "b6", "tf6", "automobile-prototype-dismiss",
        ], file: file, line: line)
        XCTAssertEqual(children.map { $0.extras?[ElementLocator.iosWindowLayerExtra] }, [
            "1", "1", "1", "1", "0", "0", "0", "0",
        ], file: file, line: line)
        XCTAssertNil(root.extras?[ElementLocator.iosWindowLayerExtra], file: file, line: line)
        for child in children {
            for descendant in child.node ?? [] {
                assertUnstamped(descendant, file: file, line: line)
            }
        }
    }

    func testCapturedSheetStampsOnlyPromotedWindowChildren() throws {
        let capture = try loadCapture()
        XCTAssertEqual(capture.className, "XCUIApplication")
        XCTAssertEqual(capture.node?.map(\.className), ["UIWindow", "UIWindow"])
        let optimized = try optimizedRoot(capture)
        assertSheetChildren(optimized)
        assertNoWindows(optimized)
    }

    func testStampingPreservesUnstampedRootSurvivors() throws {
        let capture = try loadCapture()
        let stamped = ElementLocator.optimizeHierarchy(capture, isRoot: true)
        let unstamped = ElementLocator.optimizeHierarchyUnstampedRoot(capture)
        XCTAssertEqual(try encoded(stamped.map(removingStamps)), try encoded(unstamped))
    }

    func testSingleContributingWindowIsUnchanged() throws {
        let capture = try loadCapture()
        let appWindow = try XCTUnwrap(capture.node?.first)
        let singleWindow = ElementLocator.copying(capture, node: [appWindow])
        let optimized = ElementLocator.optimizeHierarchy(singleWindow, isRoot: true)
        XCTAssertEqual(try encoded(optimized), try encoded(ElementLocator.optimizeHierarchyUnstampedRoot(singleWindow)))
        for root in optimized {
            assertUnstamped(root)
        }
    }

    func testEmptyWindowDoesNotCountTowardLayers() throws {
        let capture = try loadCapture()
        let windows = try XCTUnwrap(capture.node)
        XCTAssertEqual(windows.count, 2)
        let emptyWindow = UIElementInfo(className: "UIWindow", node: [UIElementInfo(className: "UIView")])
        let root = ElementLocator.copying(capture, node: [windows[0], emptyWindow, windows[1]])
        let optimized = try optimizedRoot(root)
        assertSheetChildren(optimized)
        XCTAssertEqual(try encoded(optimized), try encoded(optimizedRoot(capture)))
    }

    func testWindowRemovedByRootCleanupDoesNotCountOrProtectNoise() throws {
        let noise = UIElementInfo(text: "Dictation", className: "UILabel", role: "text")
        let button = UIElementInfo(text: "App", className: "UIButton", clickable: "true")
        let root = UIElementInfo(className: "XCUIApplication", node: [
            UIElementInfo(className: "UIWindow", node: [button, noise]),
            UIElementInfo(className: "UIWindow", node: [noise]),
        ])
        let optimized = try optimizedRoot(root)
        XCTAssertEqual(optimized.node?.map(\.text), ["App", "Dictation"])
        assertUnstamped(optimized)
        XCTAssertEqual(try encoded(optimized.node), try encoded([button, noise]))
    }

    func testStampedSurvivorPreservesExistingSDKExtras() throws {
        let capture = try loadCapture()
        let baseline = try XCTUnwrap(ElementLocator.optimizeHierarchyUnstampedRoot(capture).first)
        let original = try XCTUnwrap(baseline.node?.first { $0.resourceId == "b6" })
        let stamped = try XCTUnwrap(optimizedRoot(capture).node?.first { $0.resourceId == "b6" })
        XCTAssertEqual(original.extras?["sdk.isLayerNode"], "true")
        XCTAssertEqual(original.extras?["sdk.isUserInteractionEnabled"], "false")
        var expected = try XCTUnwrap(original.extras)
        expected[ElementLocator.iosWindowLayerExtra] = "0"
        XCTAssertEqual(stamped.extras, expected)
    }

    func testNonWindowRootChildStaysUnstamped() throws {
        let capture = try loadCapture()
        let button = UIElementInfo(text: "Outside windows", className: "UIButton", clickable: "true")
        let root = ElementLocator.copying(capture, node: (capture.node ?? []) + [button])
        let optimized = try optimizedRoot(root)
        let children = try XCTUnwrap(optimized.node)
        XCTAssertEqual(children.count, 9)
        assertSheetChildren(ElementLocator.copying(optimized, node: Array(children.dropLast())))
        let last = try XCTUnwrap(children.last)
        XCTAssertEqual(try encoded(last), try encoded(button))
        assertUnstamped(last)
    }

    func testRunnerOptimizedGolden() throws {
        let optimized = try optimizedRoot(loadCapture())
        assertSheetChildren(optimized)
        var actual = try encoded(HierarchyDocument(hierarchy: optimized))
        actual.append(0x0A)
        let url = fixtureDirectory.appendingPathComponent("ios-sheet-prototype-over-playground.runner-optimized.json")
        if ProcessInfo.processInfo.environment["AUTOMOBILE_UPDATE_FIXTURES"] == "1" {
            try actual.write(to: url, options: .atomic)
            return
        }
        guard FileManager.default.fileExists(atPath: url.path) else {
            XCTFail(
                "Missing runner golden. Regenerate with AUTOMOBILE_UPDATE_FIXTURES=1 swift test " +
                    "--package-path ios/control-proxy --filter HierarchyWindowLayerTests"
            )
            return
        }
        XCTAssertEqual(actual, try Data(contentsOf: url))
    }
}
