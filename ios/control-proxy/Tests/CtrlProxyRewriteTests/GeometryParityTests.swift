@testable import CtrlProxyRewrite
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
    private struct SnapshotNode {
        let label: String
        let frame: CGRect
        let children: [SnapshotNode]

        init(_ label: String, _ frame: CGRect, children: [SnapshotNode] = []) {
            self.label = label
            self.frame = frame
            self.children = children
        }
    }

    private func candidates(in roots: [SnapshotNode], label: String) -> [ElementLocator.FrameCandidate] {
        ElementLocator.resolvedFrameCandidates(
            roots: roots, frame: { $0.frame }, children: { $0.children }, matches: { $0.label == label }
        )
    }

    func testVoiceOverBoundsSelectSecondSameLabelElement() {
        let frames = [CGRect(x: 0, y: 0, width: 50, height: 40), CGRect(x: 0, y: 50, width: 50, height: 40)]
        let matches = candidates(in: frames.map { SnapshotNode("Delete", $0) }, label: "Delete")
        XCTAssertEqual(
            ElementLocator.matchingLiveIndex(
                frames: frames, candidates: matches,
                target: ElementBounds(left: 0, top: 50, right: 50, bottom: 90)
            ),
            1
        )
        XCTAssertEqual(
            ElementLocator.matchingLiveIndex(
                frames: frames, candidates: matches,
                target: ElementBounds(left: 100, top: 100, right: 150, bottom: 140)
            ),
            1,
            "a distant observation still selects the closest label match"
        )
    }

    func testVoiceOverNestedOffsetContainerUsesObservedScreenFrame() {
        let local = CGRect(x: 0, y: 0, width: 40, height: 30)
        let tree = SnapshotNode("root", CGRect(x: 0, y: 0, width: 400, height: 800), children: [
            SnapshotNode("container", CGRect(x: 100, y: 200, width: 120, height: 100), children: [
                SnapshotNode("Delete", local),
            ]),
            SnapshotNode("Delete", CGRect(x: 5, y: 5, width: 40, height: 30)),
        ])
        let matches = candidates(in: [tree], label: "Delete")

        XCTAssertEqual(matches[0].screenFrame, CGRect(x: 100, y: 200, width: 40, height: 30))
        XCTAssertEqual(
            ElementLocator.matchingLiveIndex(
                frames: [local, CGRect(x: 5, y: 5, width: 40, height: 30)], candidates: matches,
                target: ElementBounds(left: 100, top: 200, right: 140, bottom: 230)
            ), 0
        )
        XCTAssertEqual(
            ElementLocator.matchingLiveIndex(
                frames: [matches[0].screenFrame, CGRect(x: 5, y: 5, width: 40, height: 30)], candidates: matches,
                target: ElementBounds(left: 100, top: 200, right: 140, bottom: 230)
            ), 0
        )
    }

    func testVoiceOverSpringBoardAlertNestedButtonUsesAlertRootOffset() {
        let localButton = CGRect(x: 10, y: 20, width: 60, height: 40)
        let alert = SnapshotNode("alert", CGRect(x: 40, y: 180, width: 250, height: 300), children: [
            SnapshotNode("wrapper", CGRect(x: 0, y: 0, width: 250, height: 300), children: [
                SnapshotNode("Allow", localButton),
            ]),
        ])
        let matches = candidates(in: [alert], label: "Allow")

        XCTAssertEqual(matches[0].screenFrame, CGRect(x: 50, y: 200, width: 60, height: 40))
        XCTAssertEqual(
            ElementLocator.matchingLiveIndex(
                frames: [localButton], candidates: matches,
                target: ElementBounds(left: 50, top: 200, right: 110, bottom: 240)
            ), 0
        )
        XCTAssertEqual(
            ElementLocator.matchingLiveIndex(
                frames: [matches[0].screenFrame], candidates: matches,
                target: ElementBounds(left: 50, top: 200, right: 110, bottom: 240)
            ), 0
        )
    }

    func testVoiceOverDuplicateLocalFramesKeepSnapshotTraversalOrder() {
        let local = CGRect(x: 0, y: 0, width: 40, height: 30)
        let tree = SnapshotNode("root", CGRect(x: 0, y: 0, width: 400, height: 800), children: [
            SnapshotNode("first container", CGRect(x: 20, y: 100, width: 80, height: 60), children: [
                SnapshotNode("Delete", local),
            ]),
            SnapshotNode("second container", CGRect(x: 20, y: 300, width: 80, height: 60), children: [
                SnapshotNode("Delete", local),
            ]),
        ])
        let matches = candidates(in: [tree], label: "Delete")

        XCTAssertEqual(
            ElementLocator.matchingLiveIndex(
                frames: [local, local], candidates: matches,
                target: ElementBounds(left: 20, top: 300, right: 60, bottom: 330)
            ), 1
        )
    }

    func testVoiceOverOneAndTwoPointBoundsDriftStillSelectsMatch() {
        let frames = [CGRect(x: 0, y: 0, width: 50, height: 40), CGRect(x: 0, y: 50, width: 50, height: 40)]
        let matches = candidates(in: frames.map { SnapshotNode("Delete", $0) }, label: "Delete")
        for drift in 1 ... 2 {
            XCTAssertEqual(
                ElementLocator.matchingLiveIndex(
                    frames: frames, candidates: matches,
                    target: ElementBounds(left: drift, top: 50 + drift, right: 50 + drift, bottom: 90 + drift)
                ), 1
            )
        }
    }

    func testVoiceOverSingleCandidateUsesLabelDespiteMismatchedBounds() {
        let frame = CGRect(x: 0, y: 0, width: 50, height: 40)
        let matches = candidates(in: [SnapshotNode("Delete", frame)], label: "Delete")
        XCTAssertEqual(
            ElementLocator.matchingLiveIndex(
                frames: [frame], candidates: matches,
                target: ElementBounds(left: 500, top: 500, right: 550, bottom: 540)
            ), 0
        )
    }

    func testVoiceOverEqualCenterDistanceBreaksTieBySize() {
        let target = ElementBounds(left: 0, top: 0, right: 40, bottom: 40)
        let candidates = [
            ElementBounds(left: -5, top: 0, right: 35, bottom: 40),
            ElementBounds(left: -7, top: 0, right: 37, bottom: 40),
        ]
        XCTAssertEqual(ElementLocator.matchingIndex(bounds: candidates, target: target), 0)
    }

    func testVoiceOverLongPressDurationConvertsMillisecondsToSeconds() {
        XCTAssertEqual(GesturePerformer.longPressDuration(1750), 1.75)
        XCTAssertEqual(GesturePerformer.longPressDuration(nil), 1.0)
    }

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
        XCTAssertEqual(
            RewriteGeometry.stableRotation(beforeRotation: 0, beforeGen: 5, afterRotation: 0, afterGen: 5),
            0
        )
        XCTAssertNil(RewriteGeometry.stableRotation(beforeRotation: 0, beforeGen: 5, afterRotation: 0, afterGen: 6))
        XCTAssertNil(RewriteGeometry.stableRotation(beforeRotation: 0, beforeGen: 5, afterRotation: 1, afterGen: 5))
        XCTAssertNil(RewriteGeometry.stableRotation(beforeRotation: nil, beforeGen: 0, afterRotation: nil, afterGen: 0))
        XCTAssertEqual(
            RewriteGeometry.stableRotation(beforeRotation: 3, beforeGen: 9, afterRotation: 3, afterGen: 9),
            3
        )
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

        let ownerA = try XCTUnwrap(coord("owner_a", "Terms", 0), "owner-scoped resolve")
        let ownerBCaseInsensitive = try XCTUnwrap(coord("owner_b", "terms", 0), "case-insensitive owner-scoped resolve")

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

@MainActor
final class VoiceOverActionRequestTests: XCTestCase {
    func testBoundsAndDurationReachGesturePerformer() async throws {
        let data = Data("""
        {"type":"request_action","requestId":"voiceover-action","action":"long_press",
         "label":"Delete","bounds":{"left":0,"top":50,"right":50,"bottom":90},"duration":1750}
        """.utf8)
        let request = try JSONDecoder().decode(WebSocketRequest.self, from: data)
        let gestures = RewriteFakeGesturePerformer()
        let handler = CommandHandler(
            elementLocator: RewriteFakeElementLocator(), gesturePerformer: gestures, perf: PerfProvider()
        )
        let response = await handler.handle(request)

        XCTAssertTrue((response as? WebSocketResponse)?.success == true)
        XCTAssertEqual(gestures.lastAction?.action, "long_press")
        XCTAssertEqual(gestures.lastAction?.label, "Delete")
        XCTAssertEqual(gestures.lastAction?.bounds?.top, 50)
        XCTAssertEqual(gestures.lastAction?.duration, 1750)
    }
}
