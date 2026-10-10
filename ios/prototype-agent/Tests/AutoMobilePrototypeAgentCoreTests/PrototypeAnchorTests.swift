@testable import AutoMobilePrototypeAgentCore
import XCTest

/// Node anchors on iOS (#9316): the host sends screen bounds in points, the agent decodes them,
/// refuses element anchors it was never meant to see, lists anchored nodes for the window-level
/// layer (#10803), and places each one by the same rules as Android's `prototypeAnchorRect`.
final class PrototypeAnchorTests: XCTestCase {
    private func fixture(_ name: String) throws -> PrototypeSpec {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/prototype-spec/valid/\(name).json")
        return try JSONDecoder().decode(PrototypeSpec.self, from: Data(contentsOf: url))
    }

    private func node(_ json: String) throws -> PrototypeNode {
        try JSONDecoder().decode(PrototypeNode.self, from: Data(json.utf8))
    }

    private func anchor(_ json: String) throws -> PrototypeAnchor {
        try JSONDecoder().decode(PrototypeAnchor.self, from: Data(json.utf8))
    }

    /// Settings' General row in the captured iPhone 17 hierarchy (402x874 pt), in points.
    private let general = PrototypeRect(x: 16, y: 380, width: 370, height: 52)

    // MARK: Decoding

    func testTheSharedFixtureDecodesBoundsAlignmentAndOffset() throws {
        let spec = try fixture("bounds-anchor-aligned")
        let children = try XCTUnwrap(spec.root.children)
        XCTAssertEqual(children[0].anchor, PrototypeAnchor(
            bounds: PrototypeRect(x: 209.52380952380952, y: 605.3333333333334, width: 169.9047619047619, height: 48),
            alignment: .cover
        ))
        XCTAssertEqual(children[1].anchor, PrototypeAnchor(
            bounds: PrototypeRect(x: 16, y: 556, width: 379, height: 224),
            alignment: .bottom,
            offsetX: 0,
            offsetY: 8
        ))
        XCTAssertNil(spec.root.anchor)
    }

    func testAnAbsentAlignmentCoversAndAnUnknownOneFailsTheSpec() throws {
        let bounds = #"{"x": 1, "y": 2, "width": 3, "height": 4}"#
        XCTAssertEqual(try anchor(#"{"type": "bounds", "bounds": \#(bounds)}"#).alignment, .cover)
        XCTAssertThrowsError(try anchor(#"{"type": "bounds", "bounds": \#(bounds), "alignment": "middle"}"#))
        XCTAssertThrowsError(try anchor(#"{"type": "bounds"}"#), "a bounds anchor needs bounds")
        XCTAssertThrowsError(try anchor(#"{"type": "pixels", "bounds": \#(bounds)}"#))
    }

    func testAnElementAnchorDecodesUnresolvedAndIsReportedByPath() throws {
        let element = try anchor(#"{"type": "element", "selector": {"text": "General"}, "alignment": "top"}"#)
        XCTAssertNil(element.bounds)
        XCTAssertNil(element.screenRect(nodeWidth: 10, nodeHeight: 10, rightToLeft: false))
        let tree = try node("""
        {"type": "column", "children": [
          {"type": "text", "text": "ok", "anchor": {"type": "bounds", "bounds": {"x": 0, "y": 0, "width": 1, "height": 1}}},
          {"type": "box", "child": {"type": "box", "anchor": {"type": "element", "selector": {"text": "General"}}}}
        ]}
        """)
        XCTAssertEqual(tree.unresolvedAnchorPath(), "root.children[1].child.anchor")
        XCTAssertNil(try fixture("bounds-anchor-aligned").root.unresolvedAnchorPath())
    }

    func testTheAgentAdvertisesAnchorSupport() {
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains("prototype_anchor_v1"))
        XCTAssertEqual(PrototypeAgentProtocol.anchorCapability, "prototype_anchor_v1")
    }

    // MARK: Placement

    func testCoverAdoptsTheBoundsWhateverTheNodeMeasures() {
        let cover = PrototypeAnchor(bounds: general, alignment: .cover)
        XCTAssertEqual(cover.screenRect(nodeWidth: 10, nodeHeight: 999, rightToLeft: false), general)
        XCTAssertEqual(cover.screenRect(nodeWidth: 10, nodeHeight: 999, rightToLeft: true), general)
    }

    func testEdgesKeepTheNodeSizeAndCentreOnTheOtherAxis() {
        let rect = { (alignment: PrototypeAnchorAlignment, rtl: Bool) in
            PrototypeAnchor(bounds: self.general, alignment: alignment)
                .screenRect(nodeWidth: 100, nodeHeight: 20, rightToLeft: rtl)
        }
        XCTAssertEqual(rect(.top, false), PrototypeRect(x: 151, y: 380, width: 100, height: 20))
        XCTAssertEqual(rect(.bottom, false), PrototypeRect(x: 151, y: 412, width: 100, height: 20))
        XCTAssertEqual(rect(.start, false), PrototypeRect(x: 16, y: 396, width: 100, height: 20))
        XCTAssertEqual(rect(.end, false), PrototypeRect(x: 286, y: 396, width: 100, height: 20))
    }

    func testStartAndEndSwapInRightToLeft() {
        let rect = { (alignment: PrototypeAnchorAlignment) in
            PrototypeAnchor(bounds: self.general, alignment: alignment)
                .screenRect(nodeWidth: 100, nodeHeight: 20, rightToLeft: true)
        }
        XCTAssertEqual(rect(.start), PrototypeRect(x: 286, y: 396, width: 100, height: 20))
        XCTAssertEqual(rect(.end), PrototypeRect(x: 16, y: 396, width: 100, height: 20))
        XCTAssertEqual(rect(.top), PrototypeRect(x: 151, y: 380, width: 100, height: 20), "top ignores direction")
    }

    func testTheOffsetIsAppliedLastInScreenAxes() {
        let below = PrototypeAnchor(bounds: general, alignment: .bottom, offsetX: -4, offsetY: 8)
        XCTAssertEqual(
            below.screenRect(nodeWidth: 100, nodeHeight: 20, rightToLeft: true),
            PrototypeRect(x: 147, y: 420, width: 100, height: 20)
        )
        let cover = PrototypeAnchor(bounds: general, alignment: .cover, offsetX: 2, offsetY: 3)
        XCTAssertEqual(
            cover.screenRect(nodeWidth: 0, nodeHeight: 0, rightToLeft: false),
            PrototypeRect(x: 18, y: 383, width: 370, height: 52)
        )
    }

    func testAFullscreenLayerBelowTheDismissBarSubtractsTheBarOnce() {
        // iPhone 17: a 62 pt top inset, so the fullscreen content area (and its anchor layer)
        // starts 106 pt down the window; the window itself sits at the screen origin.
        let barHeight = PrototypeHostChrome(placementType: "fullscreen").dismissBarHeight(safeTop: 62)
        let cover = PrototypeAnchor(bounds: general, alignment: .cover)
        XCTAssertEqual(
            cover.layerRect(nodeWidth: 0, nodeHeight: 0, rightToLeft: false, layerOriginX: 0, layerOriginY: barHeight),
            PrototypeRect(x: 16, y: 380 - 106, width: 370, height: 52)
        )
    }

    func testAWindowOffTheScreenOriginIsSubtractedToo() {
        // A floating or sheet layer spans the window; a window not at the screen origin (a
        // resized scene) moves every anchored node back by its own origin.
        let top = PrototypeAnchor(bounds: general, alignment: .top)
        XCTAssertEqual(
            top.layerRect(nodeWidth: 100, nodeHeight: 20, rightToLeft: false, layerOriginX: 10, layerOriginY: 30),
            PrototypeRect(x: 141, y: 350, width: 100, height: 20)
        )
    }

    // MARK: Window-level layer

    private let layered = """
    {"type": "column", "children": [
      {"type": "text", "text": "in place"},
      {"type": "box", "id": "wrap", "children": [
        {"type": "box", "id": "a", "anchor": {"type": "bounds", "bounds": {"x": 0, "y": 0, "width": 1, "height": 1}},
         "children": [
           {"type": "text", "id": "nested", "text": "n",
            "anchor": {"type": "bounds", "bounds": {"x": 0, "y": 0, "width": 1, "height": 1}}}
         ]}
      ]},
      {"type": "box", "visibleWhen": {"key": "show", "equals": true}, "children": [
        {"type": "text", "id": "hidden", "text": "h",
         "anchor": {"type": "bounds", "bounds": {"x": 0, "y": 0, "width": 1, "height": 1}}}
      ]},
      {"type": "pager", "id": "p", "children": [
        {"type": "text", "id": "page0", "text": "0",
         "anchor": {"type": "bounds", "bounds": {"x": 0, "y": 0, "width": 1, "height": 1}}},
        {"type": "text", "id": "page1", "text": "1",
         "anchor": {"type": "bounds", "bounds": {"x": 0, "y": 0, "width": 1, "height": 1}}}
      ]},
      {"type": "button", "label": "b", "id": "self",
       "visibleWhen": {"key": "show", "equals": true},
       "anchor": {"type": "bounds", "bounds": {"x": 0, "y": 0, "width": 1, "height": 1}}}
    ]}
    """

    func testAnchoredNodesUnderShownAncestorsAreLayeredInTreeOrder() throws {
        let root = try node(layered)
        let hidden = root.layeredAnchors(state: [:], pages: [:])
        XCTAssertEqual(hidden.map(\.path), [
            "root.children[1].children[0]",
            "root.children[1].children[0].children[0]",
            "root.children[3].children[0]",
            // Its own visibleWhen is the renderer's, so its show/hide is not skipped here.
            "root.children[4]",
        ])
        let shown = root.layeredAnchors(state: ["show": .bool(true)], pages: ["p": 1])
        XCTAssertEqual(shown.map { $0.node.id }, ["a", "nested", "hidden", "page1", "self"])
    }

    func testAPagerPastItsLastPageShowsTheLastLikeTheRenderer() throws {
        let root = try node(layered)
        let ids = root.layeredAnchors(state: [:], pages: ["p": 7]).compactMap { $0.node.id }
        XCTAssertTrue(ids.contains("page1"))
        XCTAssertFalse(ids.contains("page0"))
    }

    func testTheRootIsNeverLayeredButLeadsTheWindowLayerWhenAnchored() throws {
        let root = try node("""
        {"type": "box", "anchor": {"type": "bounds", "bounds": {"x": 5, "y": 6, "width": 7, "height": 8}},
         "children": [{"type": "text", "text": "t", "id": "t",
           "anchor": {"type": "bounds", "bounds": {"x": 0, "y": 0, "width": 1, "height": 1}}}]}
        """)
        XCTAssertEqual(root.layeredAnchors(state: [:], pages: [:]).map(\.path), ["root.children[0]"])
        XCTAssertEqual(root.windowAnchorLayer(state: [:], pages: [:]).map(\.path), ["root", "root.children[0]"])
        let plain = try node(#"{"type": "text", "text": "t"}"#)
        XCTAssertTrue(plain.windowAnchorLayer(state: [:], pages: [:]).isEmpty)
    }

    func testModalAndClosedSheetContentIsNotInTheWindowLayer() throws {
        let root = try node("""
        {"type": "column", "children": [
          {"type": "dialog", "title": "d", "openWhen": {"key": "open", "equals": true},
           "child": {"type": "text", "text": "in dialog", "id": "d",
             "anchor": {"type": "bounds", "bounds": {"x": 0, "y": 0, "width": 1, "height": 1}}}},
          {"type": "bottomSheet", "openWhen": {"key": "open", "equals": true},
           "child": {"type": "text", "text": "in sheet", "id": "s",
             "anchor": {"type": "bounds", "bounds": {"x": 0, "y": 0, "width": 1, "height": 1}}}}
        ]}
        """)
        XCTAssertTrue(root.layeredAnchors(state: [:], pages: [:]).isEmpty)
        XCTAssertEqual(
            root.layeredAnchors(state: ["open": .bool(true)], pages: [:]).compactMap { $0.node.id },
            ["s"],
            "an open dialog's body is layered by the modal layer above it, not here"
        )
        let dialog = try XCTUnwrap(root.openModals(state: ["open": .bool(true)], pages: [:]).first)
        XCTAssertEqual(
            PrototypeNode.layeredAnchors(in: dialog.childEntries(path: "modal0"), state: [:], pages: [:]).map(\.path),
            ["modal0.child"]
        )
    }

    // MARK: Anchor fade and sheet clip (#10912)

    private func fadingSpec(transition: String?) throws -> PrototypeNode {
        let transitionField = transition.map { #", "transition": "\#($0)""# } ?? ""
        return try node("""
        {"type": "column", "children": [
          {"type": "card", "visibleWhen": {"key": "show", "equals": true}\(transitionField), "children": [
            {"type": "text", "text": "badge", "id": "badge",
             "anchor": {"type": "bounds", "bounds": {"x": 0, "y": 0, "width": 1, "height": 1}}}
          ]}
        ]}
        """)
    }

    func testAnchorsStayListedWhileAnAnimatedAncestorExits() throws {
        let root = try fadingSpec(transition: nil)
        let exiting = root.layeredAnchors(state: [:], pages: [:], retainExiting: true)
        XCTAssertEqual(exiting.map { $0.node.id }, ["badge"])
        XCTAssertEqual(exiting.map(\.ancestorsShown), [false])
        let shown = root.layeredAnchors(state: ["show": .bool(true)], pages: [:], retainExiting: true)
        XCTAssertEqual(shown.map(\.ancestorsShown), [true])
    }

    func testAnchorsAreDroppedAtOnceWithoutMotionOrForANoneTransition() throws {
        XCTAssertTrue(try fadingSpec(transition: nil).layeredAnchors(state: [:], pages: [:]).isEmpty)
        XCTAssertTrue(
            try fadingSpec(transition: "none")
                .layeredAnchors(state: [:], pages: [:], retainExiting: true).isEmpty
        )
        for transition in ["fade", "expand", "slide"] {
            XCTAssertEqual(
                try fadingSpec(transition: transition).layeredAnchors(state: [:], pages: [:], retainExiting: true)
                    .count,
                1,
                transition
            )
        }
    }

    func testTheOutermostHiddenAncestorDecidesWhetherToRetain() throws {
        let root = try node("""
        {"type": "column", "children": [
          {"type": "box", "visibleWhen": {"key": "a", "equals": true}, "children": [
            {"type": "box", "visibleWhen": {"key": "b", "equals": true}, "transition": "none", "children": [
              {"type": "text", "text": "t", "id": "t",
               "anchor": {"type": "bounds", "bounds": {"x": 0, "y": 0, "width": 1, "height": 1}}}
            ]}
          ]}
        ]}
        """)
        XCTAssertEqual(root.layeredAnchors(state: [:], pages: [:], retainExiting: true).count, 1)
        XCTAssertTrue(root.layeredAnchors(state: ["a": .bool(true)], pages: [:], retainExiting: true).isEmpty)
        XCTAssertEqual(
            root.layeredAnchors(state: ["a": .bool(true), "b": .bool(true)], pages: [:], retainExiting: true)
                .map(\.ancestorsShown),
            [true]
        )
    }

    func testTheWindowLayerPassesRetentionThrough() throws {
        let root = try fadingSpec(transition: "fade")
        XCTAssertEqual(root.windowAnchorLayer(state: [:], pages: [:], retainExiting: true).count, 1)
        XCTAssertTrue(root.windowAnchorLayer(state: [:], pages: [:]).isEmpty)
    }

    func testSheetFrameSitsOnItsEdgeAndNeverExceedsTheWindow() {
        XCTAssertEqual(
            PrototypeSheetFrame.rect(containerWidth: 400, containerHeight: 800, edge: nil, height: nil),
            PrototypeRect(x: 0, y: 600, width: 400, height: 200)
        )
        XCTAssertEqual(
            PrototypeSheetFrame.rect(containerWidth: 400, containerHeight: 800, edge: "top", height: 120),
            PrototypeRect(x: 0, y: 0, width: 400, height: 120)
        )
        XCTAssertEqual(
            PrototypeSheetFrame.rect(containerWidth: 400, containerHeight: 150, edge: "bottom", height: 500),
            PrototypeRect(x: 0, y: 0, width: 400, height: 150)
        )
    }

    func testHitRectsClipToTheSheet() {
        let sheet = PrototypeSheetFrame.rect(containerWidth: 400, containerHeight: 800, edge: nil, height: 200)
        let straddling = PrototypeRect(x: 300, y: 550, width: 200, height: 100)
        XCTAssertEqual(straddling.intersection(sheet), PrototypeRect(x: 300, y: 600, width: 100, height: 50))
        XCTAssertNil(PrototypeRect(x: 10, y: 100, width: 50, height: 50).intersection(sheet))
        XCTAssertNil(
            PrototypeRect(x: 0, y: 500, width: 50, height: 100).intersection(sheet),
            "touching edges do not overlap"
        )
    }
}
