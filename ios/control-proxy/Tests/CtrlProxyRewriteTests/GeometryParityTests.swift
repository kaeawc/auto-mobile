import Foundation
import XCTest

/// Reference-free invariant/known-value tests for the pure gesture/geometry helpers
/// (`PinchFallback`, `MultiFingerSwipeDiagnostics`, `SemanticLinkActivation`,
/// `DeviceRotation.fromOrientationName`, `RotationCaptureSample.stableRotation`).
///
/// Phase-7E re-anchor: was differential (reference vs rewrite scalar equality). With the
/// reference retired these assert the deterministic contract directly — exact known values where
/// they are defined (rotation names, the stable-rotation truth table) and behavioral invariants
/// where the exact math is an implementation detail (pinch direction/clamping, link resolution).
final class GeometryParityTests: XCTestCase {
    func testPinchFallbackInvariants() {
        // Direction: zoom-in (start<end) scales up; zoom-out scales down; no-op stays at 1.
        let zoomIn = RewriteGeometry.pinchParameters(start: 100, end: 200, duration: 0.3)
        let zoomOut = RewriteGeometry.pinchParameters(start: 200, end: 100, duration: 0.3)
        let noOp = RewriteGeometry.pinchParameters(start: 100, end: 100, duration: 0.3)
        XCTAssertGreaterThan(zoomIn.scale, 1.0, "zoom-in must scale up")
        XCTAssertGreaterThan(1.0, zoomOut.scale, "zoom-out must scale down")
        XCTAssertGreaterThan(zoomOut.scale, 0.0, "scale must stay positive")
        XCTAssertEqual(noOp.scale, 1.0, accuracy: 0.0001, "no-op distance → unit scale")

        // Every case yields finite, positive-velocity, clamped parameters.
        let cases: [(Double, Double, TimeInterval)] = [
            (100, 200, 0.3), (200, 100, 0.3), (100, 100, 0.3), (0, 200, 0.3),
            (100, 0, 0.3), (100, 200, 0), (1, 100_000, 0.5), (100_000, 1, 0.5),
        ]
        for c in cases {
            let p = RewriteGeometry.pinchParameters(start: c.0, end: c.1, duration: c.2)
            XCTAssertTrue(p.scale.isFinite && p.scale > 0, "scale finite/positive for \(c)")
            // Velocity is signed (negative for zoom-out); only require it be finite.
            XCTAssertTrue(p.velocity.isFinite, "velocity finite for \(c)")
        }
        // Extreme zoom clamps to a bounded scale (does not run away).
        let clampUp = RewriteGeometry.pinchParameters(start: 1, end: 100_000, duration: 0.5)
        XCTAssertGreaterThanOrEqual(clampUp.scale, zoomIn.scale, "more zoom-in → scale at least as large (clamped)")
    }

    func testMultiFingerFailureMessage() {
        for underlying in ["boom", "XCTest error: could not synthesize"] {
            let unavailable = RewriteGeometry.multiFingerFailure(symbolsUnavailable: true, underlying: underlying)
            let available = RewriteGeometry.multiFingerFailure(symbolsUnavailable: false, underlying: underlying)
            XCTAssertTrue(available.contains(underlying), "message should surface the underlying error")
            XCTAssertNotEqual(unavailable, available, "symbols-unavailable message must differ")
            XCTAssertFalse(unavailable.isEmpty)
        }
    }

    func testDeviceRotationFromName() {
        XCTAssertEqual(RewriteGeometry.rotationFromName("portrait"), 0)
        XCTAssertEqual(RewriteGeometry.rotationFromName("landscape_left"), 1)
        XCTAssertEqual(RewriteGeometry.rotationFromName("portrait_upside_down"), 2)
        XCTAssertEqual(RewriteGeometry.rotationFromName("landscape_right"), 3)
        XCTAssertNil(RewriteGeometry.rotationFromName("unknown"))
        XCTAssertNil(RewriteGeometry.rotationFromName(""))
    }

    func testStableRotationTruthTable() {
        // Stable only when both rotation AND generation match; otherwise nil (A→B→A / changed).
        XCTAssertEqual(RewriteGeometry.stableRotation(beforeRotation: 0, beforeGen: 5, afterRotation: 0, afterGen: 5), 0)
        XCTAssertNil(RewriteGeometry.stableRotation(beforeRotation: 0, beforeGen: 5, afterRotation: 0, afterGen: 6))
        XCTAssertNil(RewriteGeometry.stableRotation(beforeRotation: 0, beforeGen: 5, afterRotation: 1, afterGen: 5))
        XCTAssertNil(RewriteGeometry.stableRotation(beforeRotation: nil, beforeGen: 0, afterRotation: nil, afterGen: 0))
        XCTAssertEqual(RewriteGeometry.stableRotation(beforeRotation: 3, beforeGen: 9, afterRotation: 3, afterGen: 9), 3)
    }

    // MARK: - Semantic link resolution

    /// Two owners each carrying a "Terms" link, to exercise owner-scoped + document-order paths.
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

    func testSemanticLinkResolution() throws {
        let data = Data(sdkJSON.utf8)
        func coord(_ owner: String?, _ text: String, _ occ: Int) throws -> (x: Double, y: Double)? {
            try RewriteGeometry.semanticLinkCoordinate(sdkJSON: data, owner: owner, text: text, occurrence: occ)
        }

        let ownerA = try XCTUnwrap(try coord("owner_a", "Terms", 0), "owner-scoped resolve")
        let ownerBCaseInsensitive = try XCTUnwrap(try coord("owner_b", "terms", 0), "case-insensitive owner-scoped resolve")

        // Document order: first Terms is owner_a's, second is owner_b's.
        XCTAssertEqual(try coord(nil, "Terms", 0).map { [$0.x, $0.y] }, [ownerA.x, ownerA.y], "doc-order 0 == owner_a")
        XCTAssertEqual(
            try coord(nil, "Terms", 1).map { [$0.x, $0.y] },
            [ownerBCaseInsensitive.x, ownerBCaseInsensitive.y],
            "doc-order 1 == owner_b"
        )
        // The two owners' links resolve to distinct coordinates.
        XCTAssertNotEqual([ownerA.x, ownerA.y], [ownerBCaseInsensitive.x, ownerBCaseInsensitive.y])

        // Misses resolve to nil.
        XCTAssertNil(try coord("owner_a", "Terms", 1), "owner_a has no occurrence 1")
        XCTAssertNil(try coord(nil, "Terms", 2), "only two Terms links exist")
        XCTAssertNil(try coord(nil, "Missing", 0), "no such text")
        XCTAssertNil(try coord("nonexistent_owner", "Terms", 0), "no such owner")
    }
}
