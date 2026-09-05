import CtrlProxyRewrite
import Foundation
import XCTest

/// Covers the display-cutout propagation `HierarchyMerger.merge` folds from the SDK
/// hierarchy into the observation insets (#5787). Reference-free: it drives the public
/// merge entry point and asserts the resulting `ObservationInsetsInfo` directly.
///
/// Mirrors the retired reference `HierarchyMergerTests`' cutout cases without the
/// reference oracle: (1) SDK-supplied cutout metadata surfaces on the merged insets,
/// and (2) with no SDK cutout the merged insets keep the `.unknown` sentinel.
final class HierarchyMergerCutoutTests: XCTestCase {
    func testMergePropagatesDisplayCutoutMetadata() {
        // Empty XCUITest hierarchy (insets default to `.unavailable`); the SDK side carries
        // safe-area + cutout, so the merge enters the SDK-enriched insets branch.
        let xcuitest = ViewHierarchy(packageName: "com.test.app")
        let sdk = SdkViewHierarchy(
            timestamp: 1000,
            bundleId: "com.test.app",
            screenScale: 3.0,
            screenWidth: 375,
            screenHeight: 812,
            safeAreaInsets: SdkEdgeInsets(top: 59, right: 0, bottom: 34, left: 0),
            displayCutoutInfo: SdkDisplayCutoutInfo(
                classification: "dynamic_island",
                bounds: [SdkBounds(left: 128, top: 11, right: 247, bottom: 48)]
            ),
            root: nil
        )

        let result = HierarchyMerger.merge(xcuitest: xcuitest, sdk: sdk)

        XCTAssertEqual(result.insets.displayCutoutInfo?.classification, "dynamic_island")
        let bounds = result.insets.displayCutoutInfo?.bounds?.first
        XCTAssertEqual(bounds?.left, 128)
        XCTAssertEqual(bounds?.top, 11)
        XCTAssertEqual(bounds?.right, 247)
        XCTAssertEqual(bounds?.bottom, 48)
    }

    func testMergeKeepsUnknownCutoutWhenSdkSuppliesNone() {
        // SDK reports system chrome but neither safe-area nor cutout: the merge retains the
        // `.unavailable` source and the `.unknown` cutout sentinel from the XCUITest insets.
        let xcuitest = ViewHierarchy(packageName: "com.test.app")
        let sdk = SdkViewHierarchy(
            timestamp: 1000,
            bundleId: "com.test.app",
            screenScale: 3.0,
            screenWidth: 375,
            screenHeight: 812,
            safeAreaInsets: nil,
            displayCutoutInfo: nil,
            systemChrome: SdkSystemChrome(visibility: "hidden", statusBar: "hidden", source: "scene"),
            root: nil
        )

        let result = HierarchyMerger.merge(xcuitest: xcuitest, sdk: sdk)

        XCTAssertEqual(result.insets.source, "unavailable")
        XCTAssertEqual(result.insets.displayCutoutInfo?.classification, "unknown")
        XCTAssertNil(result.insets.displayCutoutInfo?.bounds)
        XCTAssertEqual(result.insets.systemChrome?.visibility, "hidden")
    }
}
