import Foundation
import XCTest

/// Differential parity for `HierarchyMerger` (rewrite Phase 1) — the richest merge
/// surface. A shared XCUITest `ViewHierarchy` + SDK `SdkViewHierarchy` pair is run
/// through both modules' `merge`; the sorted-key encoding of the results must be
/// byte-identical.
///
/// The fixtures are crafted so the merge exercises all three effects: (a) enrichment
/// of matched nodes with `sdk.*` extras + projected semantic links, (b) injection of
/// an SDK-only node (`sdk.source=sdkWalker`), and (c) the safe-area inset upgrade.
final class HierarchyMergeParityTests: XCTestCase {
    private let xcuitestJSON = """
    {
      "updatedAt": 1730000000000,
      "packageName": "com.example.app",
      "hierarchy": {
        "className": "Window",
        "bounds": { "left": 0, "top": 0, "right": 393, "bottom": 852 },
        "node": [
          { "className": "Button", "text": "OK", "resource-id": "ok_button",
            "bounds": { "left": 10, "top": 20, "right": 120, "bottom": 64 } }
        ]
      },
      "screenScale": 3.0,
      "screenWidth": 393,
      "screenHeight": 852,
      "insets": { "available": false, "source": "unavailable", "units": "unknown" }
    }
    """

    private let sdkJSON = """
    {
      "timestamp": 1730000000000,
      "bundleId": "com.example.app",
      "screenScale": 3.0,
      "screenWidth": 393,
      "screenHeight": 852,
      "safeAreaInsets": { "top": 59, "right": 0, "bottom": 34, "left": 0 },
      "systemChrome": { "visibility": "visible", "statusBar": "shown",
                        "homeIndicatorAutoHideRequested": false, "source": "scene" },
      "root": {
        "className": "Window",
        "bounds": { "left": 0, "top": 0, "right": 393, "bottom": 852 },
        "backgroundColor": "#FFFFFF",
        "accessibilityTraits": ["button"],
        "children": [
          {
            "className": "Button",
            "bounds": { "left": 10, "top": 20, "right": 120, "bottom": 64 },
            "accessibilityIdentifier": "ok_button",
            "accessibilityLabel": "OK",
            "isAccessibilityElement": true,
            "cornerRadius": 8.0,
            "semanticLinks": [
              { "text": "Terms", "occurrence": 0, "start": 4, "end": 9, "centerX": 50.0, "centerY": 42.0 }
            ]
          },
          {
            "className": "SDKOnlyLabel",
            "bounds": { "left": 10, "top": 80, "right": 200, "bottom": 110 },
            "accessibilityIdentifier": "sdk_only_label",
            "accessibilityLabel": "SDK only injected",
            "isAccessibilityElement": true
          }
        ]
      }
    }
    """

    func testMergeProducesIdenticalOutputInBothModules() throws {
        let xc = Data(xcuitestJSON.utf8)
        let sdk = Data(sdkJSON.utf8)

        let reference = try ReferenceMerge.mergeAndReencode(xcuitest: xc, sdk: sdk)
        let rewrite = try RewriteMerge.mergeAndReencode(xcuitest: xc, sdk: sdk)

        if reference != rewrite {
            XCTFail(
                "merged ViewHierarchy diverged:\n" +
                    "reference: \(String(decoding: reference, as: UTF8.self))\n" +
                    "rewrite:   \(String(decoding: rewrite, as: UTF8.self))"
            )
        }

        // Sanity: prove the merge actually did meaningful work, so byte-equality of two
        // empty/no-op merges can't pass vacuously.
        let out = String(decoding: rewrite, as: UTF8.self)
        XCTAssertTrue(out.contains("sdkWalker"), "expected an injected SDK-only node")
        XCTAssertTrue(out.contains("sdk_only_label"), "expected the injected node's resource-id")
        XCTAssertTrue(out.contains("sdk.backgroundColor"), "expected enrichment extras on the matched root")
        XCTAssertTrue(out.contains("ios-sdk-safe-area"), "expected the inset upgrade from the SDK safe area")
        XCTAssertTrue(out.contains("semantic-links"), "expected projected semantic links on the matched button")
    }

    /// Merge is a no-op when there is no SDK hierarchy: the XCUITest tree round-trips
    /// identically through both modules.
    func testMergeWithoutSdkIsIdentityInBothModules() throws {
        let xc = Data(xcuitestJSON.utf8)
        let emptySdk = Data(#"{"timestamp":0,"screenScale":3.0,"screenWidth":393,"screenHeight":852}"#.utf8)

        let reference = try ReferenceMerge.mergeAndReencode(xcuitest: xc, sdk: emptySdk)
        let rewrite = try RewriteMerge.mergeAndReencode(xcuitest: xc, sdk: emptySdk)
        XCTAssertEqual(reference, rewrite, "no-SDK-root merge must match between modules")
    }
}
