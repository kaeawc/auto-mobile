import Foundation
import XCTest

@MainActor
final class TVCommandRouterSmokeTests: XCTestCase {
    private struct Response: Decodable {
        let type: String
        let requestId: String?
        let success: Bool?
        let errorCode: String?
        let format: String?
        let data: String?
    }

    func testTextScreenshotAndTile() throws {
        guard ProcessInfo.processInfo.environment["AM_TVOS_SMOKE"] == "1" else {
            throw XCTSkip("Set TEST_RUNNER_AM_TVOS_SMOKE=1 to run the advisory tvOS smoke.")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        defer { app.terminate() }
        let field = app.textFields["am-text-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        try focus(field, in: app, tile: false)
        XCUIRemote.shared.press(.select)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))

        let router = TVCommandRouter(application: app)
        let appended = try response(
            #"{"type":"request_append_text","requestId":"smoke-append","text":"hello"}"#,
            router: router
        )
        XCTAssertEqual(appended.type, ResponseType.appendTextResult.rawValue)
        XCTAssertEqual(appended.requestId, "smoke-append")
        XCTAssertEqual(appended.success, true)
        XCTAssertEqual(field.value as? String, "hello")

        let screenshot = try response(
            #"{"type":"request_screenshot","requestId":"smoke-shot"}"#,
            router: router
        )
        XCTAssertEqual(screenshot.requestId, "smoke-shot")
        XCTAssertEqual(screenshot.format, "png")
        let png = try XCTUnwrap(Data(base64Encoded: XCTUnwrap(screenshot.data)))
        XCTAssertGreaterThan(png.count, 4)
        XCTAssertEqual(Array(png.prefix(4)), [0x89, 0x50, 0x4E, 0x47])

        XCUIRemote.shared.press(.menu)
        let keyboardGone = NSPredicate(format: "exists == false")
        expectation(for: keyboardGone, evaluatedWith: app.keyboards.firstMatch)
        waitForExpectations(timeout: 5)
        let unfocused = try response(
            #"{"type":"request_append_text","requestId":"smoke-unfocused","text":"unexpected"}"#,
            router: router
        )
        XCTAssertTrue(unfocused.errorCode != nil || unfocused.success == false)
        XCTAssertEqual(field.value as? String, "hello")

        let tile = app.buttons["B00"]
        try focus(tile, in: app, tile: true)
        let last = app.staticTexts["last"]
        let previous = last.label
        XCUIRemote.shared.press(.select)
        expectation(for: NSPredicate(format: "label == %@", "last: B00"), evaluatedWith: last)
        waitForExpectations(timeout: 5)
        XCTAssertNotEqual(last.label, previous)
    }

    private func response(_ json: String, router: TVCommandRouter) throws -> Response {
        try JSONDecoder().decode(Response.self, from: router.handle(Data(json.utf8)))
    }

    private func focusedIdentifier(_ snapshot: any XCUIElementSnapshot) -> String? {
        if snapshot.hasFocus, !snapshot.identifier.isEmpty { return snapshot.identifier }
        return snapshot.children.lazy.compactMap { self.focusedIdentifier($0) }.first
    }

    private func focus(_ target: XCUIElement, in app: XCUIApplication, tile: Bool) throws {
        // Observe after every move: tvOS remembers focus per column, so a planned
        // sequence alone cannot establish where the remote actually landed.
        var snapshot = try app.snapshot()
        for _ in 0 ..< 20 {
            if try target.snapshot().hasFocus { return }
            let identifier = focusedIdentifier(snapshot) ?? ""
            let direction: XCUIRemote.Button
            if !tile {
                direction = .up
            } else if identifier == "am-text-field" {
                direction = .down
            } else if identifier.hasPrefix("B"), identifier.count == 3 {
                direction = identifier.last == "0" ? .up : .left
            } else {
                direction = .up
            }
            XCUIRemote.shared.press(direction)
            snapshot = try app.snapshot()
        }
        XCTAssertTrue(try target.snapshot().hasFocus, "Remote focus did not reach \(target.identifier)")
    }
}
