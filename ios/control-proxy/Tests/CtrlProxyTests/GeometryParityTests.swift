import AutoMobileSdkWire
@testable import CtrlProxy
import Foundation
import XCTest

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
        let zoomIn = Geometry.pinchParameters(start: 100, end: 200, duration: 0.3)
        let zoomOut = Geometry.pinchParameters(start: 200, end: 100, duration: 0.3)
        let noOp = Geometry.pinchParameters(start: 100, end: 100, duration: 0.3)
        XCTAssertGreaterThan(zoomIn.scale, 1.0, "zoom-in must scale up")
        XCTAssertGreaterThan(1.0, zoomOut.scale, "zoom-out must scale down")
        XCTAssertGreaterThan(zoomOut.scale, 0.0, "scale must stay positive")
        XCTAssertEqual(noOp.scale, 1.0, accuracy: 0.0001, "no-op distance → unit scale")

        // Every case yields finite, positive-velocity, clamped parameters.
        let cases: [(Double, Double, TimeInterval)] = [
            (100, 200, 0.3), (200, 100, 0.3), (100, 100, 0.3), (0, 200, 0.3),
            (100, 0, 0.3), (100, 200, 0), (1, 100_000, 0.5), (100_000, 1, 0.5),
        ]
        for testCase in cases {
            let parameters = Geometry.pinchParameters(start: testCase.0, end: testCase.1, duration: testCase.2)
            XCTAssertTrue(parameters.scale.isFinite && parameters.scale > 0, "scale finite/positive for \(testCase)")
            // Velocity is signed (negative for zoom-out); only require it be finite.
            XCTAssertTrue(parameters.velocity.isFinite, "velocity finite for \(testCase)")
        }
        // Extreme zoom clamps to a bounded scale (does not run away).
        let clampUp = Geometry.pinchParameters(start: 1, end: 100_000, duration: 0.5)
        XCTAssertGreaterThanOrEqual(clampUp.scale, zoomIn.scale, "more zoom-in → scale at least as large (clamped)")
    }

    func testMultiFingerFailureMessage() {
        for underlying in ["boom", "XCTest error: could not synthesize"] {
            let unavailable = Geometry.multiFingerFailure(symbolsUnavailable: true, underlying: underlying)
            let available = Geometry.multiFingerFailure(symbolsUnavailable: false, underlying: underlying)
            XCTAssertTrue(available.contains(underlying), "message should surface the underlying error")
            XCTAssertNotEqual(unavailable, available, "symbols-unavailable message must differ")
            XCTAssertFalse(unavailable.isEmpty)
        }
    }

    func testDeviceRotationFromName() {
        XCTAssertEqual(Geometry.rotationFromName("portrait"), 0)
        XCTAssertEqual(Geometry.rotationFromName("landscape_left"), 1)
        XCTAssertEqual(Geometry.rotationFromName("portrait_upside_down"), 2)
        XCTAssertEqual(Geometry.rotationFromName("landscape_right"), 3)
        XCTAssertNil(Geometry.rotationFromName("unknown"))
        XCTAssertNil(Geometry.rotationFromName(""))
    }

    func testStableRotationTruthTable() {
        // Stable only when both rotation AND generation match; otherwise nil (A→B→A / changed).
        XCTAssertEqual(
            Geometry.stableRotation(beforeRotation: 0, beforeGen: 5, afterRotation: 0, afterGen: 5),
            0
        )
        XCTAssertNil(Geometry.stableRotation(beforeRotation: 0, beforeGen: 5, afterRotation: 0, afterGen: 6))
        XCTAssertNil(Geometry.stableRotation(beforeRotation: 0, beforeGen: 5, afterRotation: 1, afterGen: 5))
        XCTAssertNil(Geometry.stableRotation(beforeRotation: nil, beforeGen: 0, afterRotation: nil, afterGen: 0))
        XCTAssertEqual(
            Geometry.stableRotation(beforeRotation: 3, beforeGen: 9, afterRotation: 3, afterGen: 9),
            3
        )
    }

    // MARK: - Semantic link resolution

    /// Two owners each carrying a "Terms" link, to exercise the first-owner rule.
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
            try Geometry.semanticLinkCoordinate(sdkJSON: data, owner: owner, text: text, occurrence: occ)
        }

        let ownerA = try XCTUnwrap(coord("owner_a", "Terms", 0), "owner-scoped resolve")
        let ownerBCaseInsensitive = try XCTUnwrap(coord("owner_b", "terms", 0), "case-insensitive owner-scoped resolve")

        // Owner-less requests choose owner_a; occurrence never advances to owner_b.
        XCTAssertEqual(try coord(nil, "Terms", 0).map { [$0.x, $0.y] }, [ownerA.x, ownerA.y], "first owner == owner_a")
        XCTAssertNil(try coord(nil, "Terms", 1), "owner_a has no occurrence 1; do not skip to owner_b")
        // The two owners' links resolve to distinct coordinates.
        XCTAssertNotEqual([ownerA.x, ownerA.y], [ownerBCaseInsensitive.x, ownerBCaseInsensitive.y])

        // Misses resolve to nil.
        XCTAssertNil(try coord("owner_a", "Terms", 1), "owner_a has no occurrence 1")
        XCTAssertNil(try coord(nil, "Terms", 2), "first owner has no occurrence 2")
        XCTAssertNil(try coord(nil, "Missing", 0), "no such text")
        XCTAssertNil(try coord("nonexistent_owner", "Terms", 0), "no such owner")
    }

    private func link(_ occurrence: Int, x: Double? = nil) -> SdkSemanticLink {
        SdkSemanticLink(text: "Terms", occurrence: occurrence, centerX: x, centerY: x.map { $0 + 10 })
    }

    private func owner(_ id: String?, links: [SdkSemanticLink], children: [SdkViewNode]? = nil) -> SdkViewNode {
        SdkViewNode(
            className: "Label",
            bounds: SdkBounds(left: 0, top: 0, right: 200, bottom: 40),
            accessibilityIdentifier: id,
            semanticLinks: links,
            children: children
        )
    }

    private func hierarchy(_ owners: [SdkViewNode]) -> SdkViewHierarchy {
        SdkViewHierarchy(
            timestamp: 0, bundleId: nil, screenScale: 3, screenWidth: 393, screenHeight: 852,
            root: owner(nil, links: [], children: owners)
        )
    }

    private func resolve(
        _ hierarchy: SdkViewHierarchy,
        owner: String? = nil,
        text: String = "terms",
        occurrence: Int
    )
        -> SemanticLinkActivation.Resolution?
    {
        SemanticLinkActivation.coordinate(in: hierarchy, ownerResourceId: owner, text: text, occurrence: occurrence)
    }

    func testSemanticLinkOccurrencesStayWithinFirstOwner() throws {
        // Nest owner_b under owner_a to also exercise parent-before-child order.
        let ownerB = owner("owner_b", links: [link(0, x: 50), link(1, x: 60)])
        let tree = hierarchy([owner("owner_a", links: [link(0, x: 10), link(1, x: 20)], children: [ownerB])])
        for (id, xCoordinates) in [("owner_a", [10.0, 20.0]), ("owner_b", [50.0, 60.0])] {
            for occurrence in xCoordinates.indices {
                let result = try XCTUnwrap(resolve(tree, owner: id, occurrence: occurrence))
                XCTAssertEqual(result.coordinate, .init(x: xCoordinates[occurrence], y: xCoordinates[occurrence] + 10))
                XCTAssertNil(result.ownerNote)
            }
        }
        for (occurrence, x) in [10.0, 20.0].enumerated() {
            let result = try XCTUnwrap(resolve(tree, occurrence: occurrence))
            XCTAssertEqual(result.coordinate, .init(x: x, y: x + 10))
            let note = try XCTUnwrap(result.ownerNote)
            XCTAssertTrue(note.contains("owner_a"))
            XCTAssertTrue(note.contains("2 candidate owners"))
            XCTAssertTrue(note.contains("container/subtext"))
        }
    }

    func testUniqueSemanticLinkOwnerUsesNonMonotonicOccurrenceValues() throws {
        let tree = hierarchy([owner("unique", links: [link(1, x: 20), link(0, x: 10)])])
        for (occurrence, x) in [10.0, 20.0].enumerated() {
            let unscoped = try XCTUnwrap(resolve(tree, occurrence: occurrence))
            let scoped = try XCTUnwrap(resolve(tree, owner: "unique", occurrence: occurrence))
            XCTAssertEqual(unscoped.coordinate, .init(x: x, y: x + 10))
            XCTAssertEqual(unscoped, scoped)
            XCTAssertNil(unscoped.ownerNote)
        }
    }

    func testSemanticLinkMissingOccurrenceDoesNotSkipFirstOwner() {
        let tree = hierarchy([
            owner("first", links: [link(0, x: 10)]),
            owner("second", links: [link(0, x: 50), link(1, x: 60)]),
        ])
        XCTAssertNil(resolve(tree, occurrence: 1))
        XCTAssertEqual(resolve(tree, owner: "second", occurrence: 1)?.coordinate, .init(x: 60, y: 70))
    }

    func testSemanticLinkMissingGeometryDoesNotSkipFirstOwner() {
        let tree = hierarchy([
            owner("first", links: [link(1), link(0, x: 10)]),
            owner("second", links: [link(1, x: 60)]),
        ])
        XCTAssertNil(resolve(tree, occurrence: 1))
        XCTAssertNil(resolve(tree, owner: "first", occurrence: 1))
        XCTAssertEqual(resolve(tree, owner: "second", occurrence: 1)?.coordinate, .init(x: 60, y: 70))
    }

    func testSemanticLinkUnnamedOwnerNoteAndSingleLinkMisses() throws {
        let single = hierarchy([owner(nil, links: [link(0, x: 10)])])
        let result = try XCTUnwrap(resolve(single, text: "TERMS", occurrence: 0))
        XCTAssertEqual(result.coordinate, .init(x: 10, y: 20))
        XCTAssertNil(result.ownerNote)
        XCTAssertNil(resolve(single, text: "Missing", occurrence: 0))
        XCTAssertNil(resolve(single, owner: "missing", occurrence: 0))
        XCTAssertNil(resolve(hierarchy([owner(nil, links: [link(0)])]), occurrence: 0))

        let multiple = hierarchy([
            owner("irrelevant", links: [SdkSemanticLink(text: "Privacy", occurrence: 0)]),
            owner(nil, links: [link(0, x: 10)]),
            owner("second", links: [link(0, x: 50)]),
        ])
        let note = try XCTUnwrap(resolve(multiple, occurrence: 0)?.ownerNote)
        XCTAssertTrue(note.contains("Label (candidate owner 1)"))
        XCTAssertTrue(note.contains("2 candidate owners"))
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
        let gestures = FakeGesturePerformer()
        let handler = CommandHandler(
            elementLocator: FakeElementLocator(), gesturePerformer: gestures, perf: PerfProvider()
        )
        let response = await handler.handle(request)

        XCTAssertTrue((response as? WebSocketResponse)?.success == true)
        XCTAssertEqual(gestures.lastAction?.action, "long_press")
        XCTAssertEqual(gestures.lastAction?.label, "Delete")
        XCTAssertEqual(gestures.lastAction?.bounds?.top, 50)
        XCTAssertEqual(gestures.lastAction?.duration, 1750)
    }
}
