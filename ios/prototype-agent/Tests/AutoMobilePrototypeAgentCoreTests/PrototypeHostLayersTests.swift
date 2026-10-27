@testable import AutoMobilePrototypeAgentCore
import XCTest

/// #10899: the page and the layer above it are separate hosting views, so an open dialog can hide
/// the page with UIKit's `accessibilityElementsHidden`, which the XCUITest snapshot honours.
final class PrototypeHostLayersTests: XCTestCase {
    private func spec(_ json: String) throws -> PrototypeSpec {
        try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
    }

    /// A contract-valid placement: a sheet needs its `edge` and `height`, a floating window its
    /// `gravity` and `offset`.
    private func placementJSON(_ type: String) -> String {
        switch type {
        case "sheet": #"{"type":"sheet","edge":"bottom","height":200}"#
        case "floating": #"{"type":"floating","gravity":"center","offset":{"x":0,"y":0}}"#
        default: #"{"type":"\#(type)"}"#
        }
    }

    private func dialogSpec(placement: String) throws -> PrototypeSpec {
        try spec("""
        {"id":"d","window":{"placement":\(placementJSON(placement))},"state":{"open":false},
         "root":{"type":"column","children":[
           {"type":"button","label":"Open","onTap":[{"type":"setState","key":"open","value":true}]},
           {"type":"dialog","testTag":"edit","title":"Edit","openWhen":{"key":"open","equals":true},
            "confirm":{"label":"Save"}},
           {"type":"snackbar","text":"Saved","openWhen":{"key":"saved","equals":true}}]}}
        """)
    }

    // MARK: Hit-rect ownership

    func testHostChromeModalsAndModalAnchorsBelongToTheTopLayer() {
        for key in [
            "dismiss",
            "dismissBar",
            "escape",
            "modal.0",
            "modal.3",
            "anchor.modal0.child",
            "anchor.modal1.children[2]",
        ] {
            XCTAssertEqual(PrototypeHostLayer(hitRectKey: key), .top, key)
        }
        for key in ["content", "anchor.root", "anchor.root.children[4]"] {
            XCTAssertEqual(PrototypeHostLayer(hitRectKey: key), .page, key)
        }
    }

    func testEscapeRectRemainsOwnedWhenAnOutgoingDismissRectIsRemoved() {
        let pill = CGRect(x: 120, y: 60, width: 160, height: 44)
        var rects = ["escape": pill, "dismiss": pill]
        rects["dismiss"] = nil
        XCTAssertEqual(PrototypeHostLayer.owner(of: CGPoint(x: 200, y: 80), hitRects: rects), .top)
        rects = ["escape": pill, "dismiss": pill]
        rects["escape"] = nil
        XCTAssertEqual(PrototypeHostLayer.owner(of: CGPoint(x: 200, y: 80), hitRects: rects), .top)
    }

    func testTheTopLayerTakesATouchWhereItsRectOverlapsThePage() {
        let rects: [String: CGRect] = [
            "content": CGRect(x: 0, y: 106, width: 400, height: 700),
            "dismissBar": CGRect(x: 0, y: 0, width: 400, height: 106),
            "modal.0": CGRect(x: 0, y: 106, width: 400, height: 700),
        ]
        XCTAssertEqual(PrototypeHostLayer.owner(of: CGPoint(x: 20, y: 300), hitRects: rects), .top)
        XCTAssertEqual(PrototypeHostLayer.owner(of: CGPoint(x: 20, y: 50), hitRects: rects), .top)
        XCTAssertNil(PrototypeHostLayer.owner(of: CGPoint(x: 20, y: 900), hitRects: rects))
    }

    func testThePageTakesATouchOutsideASnackbar() {
        let rects: [String: CGRect] = [
            "content": CGRect(x: 0, y: 106, width: 400, height: 700),
            "modal.0": CGRect(x: 0, y: 700, width: 400, height: 60),
            "anchor.root.children[1]": CGRect(x: 300, y: 820, width: 40, height: 40),
        ]
        XCTAssertEqual(PrototypeHostLayer.owner(of: CGPoint(x: 20, y: 300), hitRects: rects), .page)
        XCTAssertEqual(PrototypeHostLayer.owner(of: CGPoint(x: 20, y: 720), hitRects: rects), .top)
        XCTAssertEqual(PrototypeHostLayer.owner(of: CGPoint(x: 310, y: 830), hitRects: rects), .page)
    }

    // MARK: Accessibility flags

    func testAnOpenDialogHidesThePageAndMakesTheTopLayerModal() throws {
        var session = PrototypeSession()
        try session.show(dialogSpec(placement: "fullscreen"))
        XCTAssertEqual(
            PrototypeHostAccessibility(session: session, windowShown: true),
            PrototypeHostAccessibility(
                pageElementsHidden: false,
                topIsModal: false,
                coversApp: true,
                windowMarked: true
            )
        )
        _ = session.change(key: "open", value: .bool(true))
        XCTAssertEqual(
            PrototypeHostAccessibility(session: session, windowShown: true),
            PrototypeHostAccessibility(pageElementsHidden: true, topIsModal: true, coversApp: true, windowMarked: true)
        )
    }

    func testADialogInAFloatingPrototypeCoversTheAppButASnackbarDoesNot() throws {
        var session = PrototypeSession()
        try session.show(dialogSpec(placement: "floating"))
        XCTAssertEqual(PrototypeHostAccessibility(session: session, windowShown: true), .hidden)
        _ = session.change(key: "saved", value: .bool(true))
        XCTAssertEqual(PrototypeHostAccessibility(session: session, windowShown: true), .hidden, "snackbar only")
        _ = session.change(key: "open", value: .bool(true))
        XCTAssertEqual(
            PrototypeHostAccessibility(session: session, windowShown: true),
            PrototypeHostAccessibility(pageElementsHidden: true, topIsModal: true, coversApp: true)
        )
    }

    func testWindowMarkerTracksOnlyShownChromelessFullscreenSessions() throws {
        var session = PrototypeSession()
        for placement in ["fullscreen", "sheet", "floating"] {
            for chrome in ["none", "bar", "none"] {
                try session.show(spec("""
                {"id":"marker","window":{"placement":\(placementJSON(placement)),"chrome":"\(chrome)"},
                 "root":{"type":"text","text":"Marker"}}
                """))
                XCTAssertEqual(
                    PrototypeHostAccessibility(session: session, windowShown: true).windowMarked,
                    placement == "fullscreen" && chrome == "none"
                )
                XCTAssertFalse(PrototypeHostAccessibility(session: session, windowShown: false).windowMarked)
                if placement == "fullscreen" {
                    XCTAssertEqual(
                        PrototypeHostAccessibility(session: session, windowShown: true),
                        PrototypeHostAccessibility(
                            pageElementsHidden: false, topIsModal: false, coversApp: true,
                            windowMarked: chrome == "none"
                        )
                    )
                }
            }
        }
        // A replacing show must reapply even when the other accessibility flags are unchanged.
        try session.show(dialogSpec(placement: "fullscreen"))
        XCTAssertTrue(PrototypeHostAccessibility(session: session, windowShown: true).windowMarked)
        _ = session.dismiss(reason: .user)
        XCTAssertFalse(PrototypeHostAccessibility(session: session, windowShown: true).windowMarked)
    }

    func testAHiddenWindowOrNoSpecSetsNothing() throws {
        var session = PrototypeSession()
        XCTAssertEqual(PrototypeHostAccessibility(session: session, windowShown: true), .hidden)
        try session.show(dialogSpec(placement: "fullscreen"))
        _ = session.change(key: "open", value: .bool(true))
        XCTAssertEqual(PrototypeHostAccessibility(session: session, windowShown: false), .hidden)
    }
}
