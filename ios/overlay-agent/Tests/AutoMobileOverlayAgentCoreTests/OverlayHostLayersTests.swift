@testable import AutoMobileOverlayAgentCore
import XCTest

/// #10899: the page and the layer above it are separate hosting views, so an open dialog can hide
/// the page with UIKit's `accessibilityElementsHidden`, which the XCUITest snapshot honours.
final class OverlayHostLayersTests: XCTestCase {
    private func spec(_ json: String) throws -> OverlaySpec {
        try JSONDecoder().decode(OverlaySpec.self, from: Data(json.utf8))
    }

    private func dialogSpec(placement: String) throws -> OverlaySpec {
        try spec("""
        {"id":"d","window":{"placement":{"type":"\(placement)"}},"state":{"open":false},
         "root":{"type":"column","children":[
           {"type":"button","label":"Open","onTap":[{"type":"setState","key":"open","value":true}]},
           {"type":"dialog","testTag":"edit","title":"Edit","openWhen":{"key":"open","equals":true},
            "confirm":{"label":"Save"}},
           {"type":"snackbar","text":"Saved","openWhen":{"key":"saved","equals":true}}]}}
        """)
    }

    // MARK: Hit-rect ownership

    func testHostChromeModalsAndModalAnchorsBelongToTheTopLayer() {
        for key in ["dismiss", "dismissBar", "modal.0", "modal.3", "anchor.modal0.child", "anchor.modal1.children[2]"] {
            XCTAssertEqual(OverlayHostLayer(hitRectKey: key), .top, key)
        }
        for key in ["content", "anchor.root", "anchor.root.children[4]"] {
            XCTAssertEqual(OverlayHostLayer(hitRectKey: key), .page, key)
        }
    }

    func testTheTopLayerTakesATouchWhereItsRectOverlapsThePage() {
        let rects: [String: CGRect] = [
            "content": CGRect(x: 0, y: 106, width: 400, height: 700),
            "dismissBar": CGRect(x: 0, y: 0, width: 400, height: 106),
            "modal.0": CGRect(x: 0, y: 106, width: 400, height: 700),
        ]
        XCTAssertEqual(OverlayHostLayer.owner(of: CGPoint(x: 20, y: 300), hitRects: rects), .top)
        XCTAssertEqual(OverlayHostLayer.owner(of: CGPoint(x: 20, y: 50), hitRects: rects), .top)
        XCTAssertNil(OverlayHostLayer.owner(of: CGPoint(x: 20, y: 900), hitRects: rects))
    }

    func testThePageTakesATouchOutsideASnackbar() {
        let rects: [String: CGRect] = [
            "content": CGRect(x: 0, y: 106, width: 400, height: 700),
            "modal.0": CGRect(x: 0, y: 700, width: 400, height: 60),
            "anchor.root.children[1]": CGRect(x: 300, y: 820, width: 40, height: 40),
        ]
        XCTAssertEqual(OverlayHostLayer.owner(of: CGPoint(x: 20, y: 300), hitRects: rects), .page)
        XCTAssertEqual(OverlayHostLayer.owner(of: CGPoint(x: 20, y: 720), hitRects: rects), .top)
        XCTAssertEqual(OverlayHostLayer.owner(of: CGPoint(x: 310, y: 830), hitRects: rects), .page)
    }

    // MARK: Accessibility flags

    func testAnOpenDialogHidesThePageAndMakesTheTopLayerModal() throws {
        var session = OverlaySession()
        try session.show(dialogSpec(placement: "fullscreen"))
        XCTAssertEqual(
            OverlayHostAccessibility(session: session, windowShown: true),
            OverlayHostAccessibility(pageElementsHidden: false, topIsModal: false, coversApp: true)
        )
        _ = session.change(key: "open", value: .bool(true))
        XCTAssertEqual(
            OverlayHostAccessibility(session: session, windowShown: true),
            OverlayHostAccessibility(pageElementsHidden: true, topIsModal: true, coversApp: true)
        )
    }

    func testADialogInAFloatingOverlayCoversTheAppButASnackbarDoesNot() throws {
        var session = OverlaySession()
        try session.show(dialogSpec(placement: "floating"))
        XCTAssertEqual(OverlayHostAccessibility(session: session, windowShown: true), .hidden)
        _ = session.change(key: "saved", value: .bool(true))
        XCTAssertEqual(OverlayHostAccessibility(session: session, windowShown: true), .hidden, "snackbar only")
        _ = session.change(key: "open", value: .bool(true))
        XCTAssertEqual(
            OverlayHostAccessibility(session: session, windowShown: true),
            OverlayHostAccessibility(pageElementsHidden: true, topIsModal: true, coversApp: true)
        )
    }

    func testAHiddenWindowOrNoSpecSetsNothing() throws {
        var session = OverlaySession()
        XCTAssertEqual(OverlayHostAccessibility(session: session, windowShown: true), .hidden)
        try session.show(dialogSpec(placement: "fullscreen"))
        _ = session.change(key: "open", value: .bool(true))
        XCTAssertEqual(OverlayHostAccessibility(session: session, windowShown: false), .hidden)
    }
}
