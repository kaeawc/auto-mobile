import Foundation
import XCTest

/// Differential value-parity for the pure gesture/geometry helpers (rewrite Phase 1):
/// `PinchFallback`, `MultiFingerSwipeDiagnostics`, `SemanticLinkActivation`,
/// `DeviceRotation.fromOrientationName`, and `RotationCaptureSample.stableRotation`.
/// Identical inputs must yield identical outputs in both modules (the math is
/// deterministic, so scalar equality is exact).
final class GeometryParityTests: XCTestCase {
    func testPinchFallbackParametersMatch() {
        let cases: [(start: Double, end: Double, duration: TimeInterval)] = [
            (100, 200, 0.3),   // zoom in
            (200, 100, 0.3),   // zoom out
            (100, 100, 0.3),   // no-op → floored velocity
            (0, 200, 0.3),     // degenerate start
            (100, 0, 0.3),     // degenerate end
            (100, 200, 0),     // degenerate duration → default
            (1, 100000, 0.5),  // clamp to maxScale
            (100000, 1, 0.5),  // clamp to minScale
        ]
        for c in cases {
            let reference = ReferenceGeometry.pinchParameters(start: c.start, end: c.end, duration: c.duration)
            let rewrite = RewriteGeometry.pinchParameters(start: c.start, end: c.end, duration: c.duration)
            XCTAssertEqual(reference.scale, rewrite.scale, "scale mismatch for \(c)")
            XCTAssertEqual(reference.velocity, rewrite.velocity, "velocity mismatch for \(c)")
        }
    }

    func testMultiFingerFailureMessageMatches() {
        for symbolsUnavailable in [true, false] {
            for underlying in ["boom", "", "XCTest error: could not synthesize"] {
                XCTAssertEqual(
                    ReferenceGeometry.multiFingerFailure(symbolsUnavailable: symbolsUnavailable, underlying: underlying),
                    RewriteGeometry.multiFingerFailure(symbolsUnavailable: symbolsUnavailable, underlying: underlying),
                    "message mismatch for (\(symbolsUnavailable), \(underlying))"
                )
            }
        }
    }

    func testDeviceRotationFromNameMatches() {
        for name in ["portrait", "landscape_left", "portrait_upside_down", "landscape_right", "unknown", ""] {
            XCTAssertEqual(
                ReferenceGeometry.rotationFromName(name),
                RewriteGeometry.rotationFromName(name),
                "rotation mismatch for `\(name)`"
            )
        }
    }

    func testStableRotationMatches() {
        let cases: [(Int?, UInt64, Int?, UInt64)] = [
            (0, 5, 0, 5),   // equal rotation + generation → stable
            (0, 5, 0, 6),   // A→B→A (generation advanced) → nil
            (0, 5, 1, 5),   // rotation changed → nil
            (nil, 0, nil, 0), // both absent, same gen → nil rotation (equal, returns after.rotation=nil)
            (3, 9, 3, 9),
        ]
        for c in cases {
            XCTAssertEqual(
                ReferenceGeometry.stableRotation(beforeRotation: c.0, beforeGen: c.1, afterRotation: c.2, afterGen: c.3),
                RewriteGeometry.stableRotation(beforeRotation: c.0, beforeGen: c.1, afterRotation: c.2, afterGen: c.3),
                "stableRotation mismatch for \(c)"
            )
        }
    }

    // MARK: - Semantic link resolution

    /// Two owners each carrying duplicate inline "Terms" links (all occurrence 0
    /// within their owner), plus a top-level chain, to exercise both the
    /// owner-scoped and the document-order resolution paths.
    private let sdkJSON = """
    {
      "timestamp": 0, "screenScale": 3.0, "screenWidth": 393, "screenHeight": 852,
      "root": {
        "className": "Root", "bounds": { "left": 0, "top": 0, "right": 393, "bottom": 852 },
        "children": [
          {
            "className": "Label", "bounds": { "left": 0, "top": 0, "right": 200, "bottom": 40 },
            "accessibilityIdentifier": "owner_a",
            "semanticLinks": [
              { "text": "Terms", "occurrence": 0, "centerX": 10.0, "centerY": 20.0 },
              { "text": "Privacy", "occurrence": 0, "centerX": 30.0, "centerY": 20.0 }
            ]
          },
          {
            "className": "Label", "bounds": { "left": 0, "top": 40, "right": 200, "bottom": 80 },
            "accessibilityIdentifier": "owner_b",
            "semanticLinks": [
              { "text": "Terms", "occurrence": 0, "centerX": 50.0, "centerY": 60.0 }
            ]
          }
        ]
      }
    }
    """

    func testSemanticLinkCoordinateMatches() throws {
        let data = Data(sdkJSON.utf8)
        let queries: [(owner: String?, text: String, occurrence: Int)] = [
            ("owner_a", "Terms", 0),      // owner-scoped
            ("owner_b", "terms", 0),      // owner-scoped, case-insensitive
            ("owner_a", "Terms", 1),      // owner-scoped miss (no occurrence 1)
            (nil, "Terms", 0),            // document order: first Terms
            (nil, "Terms", 1),            // document order: second Terms (owner_b)
            (nil, "Terms", 2),            // document order miss
            (nil, "Missing", 0),          // no match
            ("nonexistent_owner", "Terms", 0),
        ]
        for q in queries {
            let reference = try ReferenceGeometry.semanticLinkCoordinate(sdkJSON: data, owner: q.owner, text: q.text, occurrence: q.occurrence)
            let rewrite = try RewriteGeometry.semanticLinkCoordinate(sdkJSON: data, owner: q.owner, text: q.text, occurrence: q.occurrence)
            XCTAssertEqual(reference?.x, rewrite?.x, "x mismatch for \(q)")
            XCTAssertEqual(reference?.y, rewrite?.y, "y mismatch for \(q)")
        }
    }
}
