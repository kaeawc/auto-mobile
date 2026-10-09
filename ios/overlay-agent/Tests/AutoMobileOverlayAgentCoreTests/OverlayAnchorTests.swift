@testable import AutoMobileOverlayAgentCore
import XCTest

/// Node anchors on iOS (#9316): the host sends screen bounds in points, the agent decodes them,
/// refuses element anchors it was never meant to see, lists anchored nodes for the window-level
/// layer (#10803), and places each one by the same rules as Android's `overlayAnchorRect`.
final class OverlayAnchorTests: XCTestCase {
    private func fixture(_ name: String) throws -> OverlaySpec {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/overlay-spec/valid/\(name).json")
        return try JSONDecoder().decode(OverlaySpec.self, from: Data(contentsOf: url))
    }

    private func node(_ json: String) throws -> OverlayNode {
        try JSONDecoder().decode(OverlayNode.self, from: Data(json.utf8))
    }

    private func anchor(_ json: String) throws -> OverlayAnchor {
        try JSONDecoder().decode(OverlayAnchor.self, from: Data(json.utf8))
    }

    /// Settings' General row in the captured iPhone 17 hierarchy (402x874 pt), in points.
    private let general = OverlayRect(x: 16, y: 380, width: 370, height: 52)

    // MARK: Decoding

    func testTheSharedFixtureDecodesBoundsAlignmentAndOffset() throws {
        let spec = try fixture("bounds-anchor-aligned")
        let children = try XCTUnwrap(spec.root.children)
        XCTAssertEqual(children[0].anchor, OverlayAnchor(
            bounds: OverlayRect(x: 209.52380952380952, y: 605.3333333333334, width: 169.9047619047619, height: 48),
            alignment: .cover
        ))
        XCTAssertEqual(children[1].anchor, OverlayAnchor(
            bounds: OverlayRect(x: 16, y: 556, width: 379, height: 224),
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
        XCTAssertTrue(OverlayAgentProtocol.capabilities.contains("overlay_anchor_v1"))
        XCTAssertEqual(OverlayAgentProtocol.anchorCapability, "overlay_anchor_v1")
    }

    // MARK: Placement

    func testCoverAdoptsTheBoundsWhateverTheNodeMeasures() {
        let cover = OverlayAnchor(bounds: general, alignment: .cover)
        XCTAssertEqual(cover.screenRect(nodeWidth: 10, nodeHeight: 999, rightToLeft: false), general)
        XCTAssertEqual(cover.screenRect(nodeWidth: 10, nodeHeight: 999, rightToLeft: true), general)
    }

    func testEdgesKeepTheNodeSizeAndCentreOnTheOtherAxis() {
        let rect = { (alignment: OverlayAnchorAlignment, rtl: Bool) in
            OverlayAnchor(bounds: self.general, alignment: alignment)
                .screenRect(nodeWidth: 100, nodeHeight: 20, rightToLeft: rtl)
        }
        XCTAssertEqual(rect(.top, false), OverlayRect(x: 151, y: 380, width: 100, height: 20))
        XCTAssertEqual(rect(.bottom, false), OverlayRect(x: 151, y: 412, width: 100, height: 20))
        XCTAssertEqual(rect(.start, false), OverlayRect(x: 16, y: 396, width: 100, height: 20))
        XCTAssertEqual(rect(.end, false), OverlayRect(x: 286, y: 396, width: 100, height: 20))
    }

    func testStartAndEndSwapInRightToLeft() {
        let rect = { (alignment: OverlayAnchorAlignment) in
            OverlayAnchor(bounds: self.general, alignment: alignment)
                .screenRect(nodeWidth: 100, nodeHeight: 20, rightToLeft: true)
        }
        XCTAssertEqual(rect(.start), OverlayRect(x: 286, y: 396, width: 100, height: 20))
        XCTAssertEqual(rect(.end), OverlayRect(x: 16, y: 396, width: 100, height: 20))
        XCTAssertEqual(rect(.top), OverlayRect(x: 151, y: 380, width: 100, height: 20), "top ignores direction")
    }

    func testTheOffsetIsAppliedLastInScreenAxes() {
        let below = OverlayAnchor(bounds: general, alignment: .bottom, offsetX: -4, offsetY: 8)
        XCTAssertEqual(
            below.screenRect(nodeWidth: 100, nodeHeight: 20, rightToLeft: true),
            OverlayRect(x: 147, y: 420, width: 100, height: 20)
        )
        let cover = OverlayAnchor(bounds: general, alignment: .cover, offsetX: 2, offsetY: 3)
        XCTAssertEqual(
            cover.screenRect(nodeWidth: 0, nodeHeight: 0, rightToLeft: false),
            OverlayRect(x: 18, y: 383, width: 370, height: 52)
        )
    }

    func testAFullscreenLayerBelowTheDismissBarSubtractsTheBarOnce() {
        // iPhone 17: a 62 pt top inset, so the fullscreen content area (and its anchor layer)
        // starts 106 pt down the window; the window itself sits at the screen origin.
        let barHeight = OverlayHostChrome(placementType: "fullscreen").dismissBarHeight(safeTop: 62)
        let cover = OverlayAnchor(bounds: general, alignment: .cover)
        XCTAssertEqual(
            cover.layerRect(nodeWidth: 0, nodeHeight: 0, rightToLeft: false, layerOriginX: 0, layerOriginY: barHeight),
            OverlayRect(x: 16, y: 380 - 106, width: 370, height: 52)
        )
    }

    func testAWindowOffTheScreenOriginIsSubtractedToo() {
        // A floating or sheet layer spans the window; a window not at the screen origin (a
        // resized scene) moves every anchored node back by its own origin.
        let top = OverlayAnchor(bounds: general, alignment: .top)
        XCTAssertEqual(
            top.layerRect(nodeWidth: 100, nodeHeight: 20, rightToLeft: false, layerOriginX: 10, layerOriginY: 30),
            OverlayRect(x: 141, y: 350, width: 100, height: 20)
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
            OverlayNode.layeredAnchors(in: dialog.childEntries(path: "modal0"), state: [:], pages: [:]).map(\.path),
            ["modal0.child"]
        )
    }
}
