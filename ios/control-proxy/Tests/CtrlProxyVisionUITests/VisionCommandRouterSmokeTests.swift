import Foundation
import XCTest

@MainActor
final class VisionCommandRouterSmokeTests: XCTestCase {
    private struct Response: Decodable {
        let type: String
        let requestId: String?
        let success: Bool?
        let data: ViewHierarchy?
    }

    func testWindowOrnamentAndFocusedTyping() throws {
        guard ProcessInfo.processInfo.environment["AM_VISIONOS_SMOKE"] == "1" else {
            throw XCTSkip("Set TEST_RUNNER_AM_VISIONOS_SMOKE=1 for the visionOS window-app smoke.")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        defer { app.terminate() }
        let router = VisionCommandRouter(application: app)
        let initial = try reply(#"{"type":"request_hierarchy","requestId":"before"}"#, router: router)
        XCTAssertEqual(initial.type, "hierarchy_update")
        XCTAssertEqual(initial.requestId, "before")
        XCTAssertTrue(try XCTUnwrap(initial.data?.hierarchy?.node).contains { $0.resourceId == "orn" })

        for identifier in ["B01", "orn", "field"] {
            let tapped = try reply(
                "{\"type\":\"request_tap_element\",\"identifier\":\"\(identifier)\"}",
                router: router
            )
            XCTAssertEqual(tapped.type, "tap_element_result")
            XCTAssertEqual(tapped.success, true)
            if identifier != "field" {
                XCTAssertEqual(app.staticTexts["last"].label, "last: \(identifier)")
            }
        }
        let focused = try reply(#"{"type":"request_hierarchy"}"#, router: router)
        XCTAssertTrue(
            try XCTUnwrap(focused.data?.hierarchy?.node)
                .contains { $0.resourceId == "field" && $0.focused == "true" }
        )
        let typed = try reply(#"{"type":"request_append_text","text":"hello"}"#, router: router)
        XCTAssertEqual(typed.type, "append_text_result")
        XCTAssertEqual(typed.success, true)
        XCTAssertEqual(app.textFields["field"].value as? String, "hello")

        // Coordinates are the hierarchy's window points: tapping B11's reported centre selects it.
        let button = try XCTUnwrap(focused.data?.hierarchy?.node?.first { $0.resourceId == "B11" }?.bounds)
        let tappedAt = try reply(
            "{\"type\":\"request_tap_coordinates\",\"x\":\(button.centerX),\"y\":\(button.centerY)}",
            router: router
        )
        XCTAssertEqual(tappedAt.type, "tap_coordinates_result")
        XCTAssertEqual(tappedAt.success, true)
        XCTAssertEqual(app.staticTexts["last"].label, "last: B11")
        let swiped = try reply(
            "{\"type\":\"request_swipe\",\"x1\":\(button.centerX),\"y1\":\(button.bottom),"
                + "\"x2\":\(button.centerX),\"y2\":\(button.top),\"duration\":300}",
            router: router
        )
        XCTAssertEqual(swiped.type, "swipe_result")
        XCTAssertEqual(swiped.success, true)
        let badSwipe = try reply(
            #"{"type":"request_swipe","x1":10,"y1":10,"x2":10,"y2":10,"duration":300}"#, router: router
        )
        XCTAssertEqual(badSwipe.type, "error")
        let home = try reply(#"{"type":"request_press_home"}"#, router: router)
        XCTAssertEqual(home.type, "press_home_result")
        XCTAssertEqual(home.success, true)

        let refused = try reply(#"{"type":"request_screenshot"}"#, router: router)
        XCTAssertEqual(refused.type, "error")
        XCTAssertEqual(refused.success, false)
    }

    private func reply(_ json: String, router: VisionCommandRouter) throws -> Response {
        try JSONDecoder().decode(Response.self, from: router.handle(Data(json.utf8)))
    }
}
