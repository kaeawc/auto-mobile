import Foundation
import XCTest

/// Differential parity for the ViewHierarchy model layer + `StructuralHasher`
/// (rewrite Phase 1). A golden `ViewHierarchy` JSON that exercises the kebab-case
/// `UIElementInfo` `CodingKeys`, nested elements, windows, insets, and system chrome
/// is decoded through BOTH modules; then:
///
///   1. re-encoding with sorted keys is idempotent and preserves every wire field the
///      golden carried (proves the model's field set + kebab-case `CodingKeys`), and
///   2. `StructuralHasher.computeHash` is deterministic + non-trivial.
///
/// Phase-7E re-anchor: was differential (decode→re-encode through BOTH modules, byte-diff +
/// cross-module hash equality). With the reference retired it is reference-free
/// (idempotence + `JSONGolden` containment + the kebab-key survival check that was already here).
final class HierarchyModelParityTests: XCTestCase {
    /// Rich enough to cover every kebab-case key and one level of nesting.
    private let goldenJSON = """
    {
      "updatedAt": 1730000000000,
      "packageName": "com.example.app",
      "hierarchy": {
        "className": "Window",
        "content-desc": "root container",
        "resource-id": "root_id",
        "view-id": "abc123def456",
        "clickable": "true",
        "enabled": "true",
        "long-clickable": "false",
        "accessibility-focused": "true",
        "state-description": "expanded",
        "hint-text": "enter your name",
        "role": "group",
        "testTag": "root-tag",
        "semantic-links": [
          { "text": "Terms", "occurrence": 0, "start": 4, "end": 9 }
        ],
        "bounds": { "left": 0, "top": 0, "right": 393, "bottom": 852 },
        "extras": { "sdk.alpha": "1.0", "sdk.isLayerNode": "false" },
        "actions": ["tap", "scroll"],
        "node": [
          {
            "className": "Button",
            "text": "OK",
            "resource-id": "ok_button",
            "clickable": "true",
            "bounds": { "left": 10, "top": 20, "right": 120, "bottom": 64 }
          }
        ]
      },
      "windowInfo": { "id": 1, "type": 0, "isActive": true, "isFocused": false,
                      "bounds": { "left": 0, "top": 0, "right": 393, "bottom": 852 } },
      "windows": [
        { "id": 1, "type": 0, "isActive": true, "isFocused": true,
          "bounds": { "left": 0, "top": 0, "right": 393, "bottom": 852 } }
      ],
      "screenScale": 3.0,
      "screenWidth": 393,
      "screenHeight": 852,
      "nativeScale": 3.0,
      "pixelWidth": 1179,
      "pixelHeight": 2556,
      "rotation": 0,
      "systemInsets": { "top": 59, "right": 0, "bottom": 34, "left": 0 },
      "insets": {
        "available": true,
        "source": "safeAreaInsets",
        "units": "points",
        "safeArea": { "top": 59, "right": 0, "bottom": 34, "left": 0 },
        "systemChrome": {
          "visibility": "visible",
          "statusBar": "shown",
          "homeIndicatorAutoHideRequested": false,
          "source": "scene"
        }
      },
      "fallbackToSpringboard": false
    }
    """

    func testViewHierarchyReencodesFaithfully() throws {
        let data = Data(goldenJSON.utf8)
        let first = try RewriteHierarchyDecoder.decodeReencodeAndHash(data)
        // Idempotent: decoding + re-encoding the sorted-key output yields identical bytes.
        let second = try RewriteHierarchyDecoder.decodeReencodeAndHash(first.encoded)
        XCTAssertEqual(first.encoded, second.encoded, "ViewHierarchy re-encode is not idempotent")

        // Every wire field the golden carried survives the round trip (no drop/rename/change).
        if let inputObject = JSONGolden.object(data), let outputObject = JSONGolden.object(first.encoded) {
            JSONGolden.assertContains(outputObject, contains: inputObject, context: "ViewHierarchy")
        }

        // Sanity: the kebab-case wire keys actually survived the round trip.
        let encodedString = String(decoding: first.encoded, as: UTF8.self)
        for key in ["content-desc", "resource-id", "semantic-links", "accessibility-focused", "long-clickable", "view-id", "state-description", "hint-text"] {
            XCTAssertTrue(encodedString.contains("\"\(key)\""), "rewrite dropped wire key `\(key)`")
        }
    }

    func testStructuralHashIsDeterministic() throws {
        let data = Data(goldenJSON.utf8)
        let a = try RewriteHierarchyDecoder.decodeReencodeAndHash(data).structuralHash
        let b = try RewriteHierarchyDecoder.decodeReencodeAndHash(data).structuralHash
        XCTAssertEqual(a, b, "StructuralHasher must be deterministic (stable combine sequence)")
        XCTAssertNotEqual(a, 0, "hash should be non-trivial for a populated hierarchy")
    }
}
