@testable import CtrlProxy
import Foundation
import XCTest

/// Records `setAppearance` calls and answers `appearance()` from its current state (#14092).
@MainActor
private final class FakeAppearanceControl: AppearanceControlling {
    private(set) var setCalls: [Bool] = []
    private var current: String
    private let failure: String?

    init(current: String = "light", failure: String? = nil) {
        self.current = current
        self.failure = failure
    }

    func appearance() throws -> String {
        current
    }

    func setAppearance(dark: Bool) throws {
        setCalls.append(dark)
        if let failure { throw VerbatimLocalizedError(message: failure) }
        current = dark ? "dark" : "light"
    }
}

@MainActor
final class AppearanceCommandTests: XCTestCase {
    private func handler(control: FakeAppearanceControl) -> CommandHandler {
        CommandHandler(
            elementLocator: FakeElementLocator(),
            gesturePerformer: FakeGesturePerformer(),
            perf: PerfProvider(),
            appearanceControl: control
        )
    }

    func testDecodesSetsAndReadsBackDark() async throws {
        let request = try JSONDecoder().decode(WebSocketRequest.self, from: Data(
            #"{"type":"request_appearance","requestId":"r1","appearance":"dark"}"#.utf8
        ))
        let control = FakeAppearanceControl()
        let result = await handler(control: control).handle(request)
        let response = try XCTUnwrap(result as? WebSocketResponse)
        XCTAssertEqual(response.type, "appearance_result")
        XCTAssertEqual(response.requestId, "r1")
        XCTAssertEqual(response.success, true)
        XCTAssertEqual(response.text, "dark")
        XCTAssertEqual(control.setCalls, [true])
    }

    func testReadOnlyRequestDoesNotSet() async throws {
        let control = FakeAppearanceControl(current: "unspecified")
        let result = await handler(control: control).handle(
            .appearance(RequestAppearance(requestId: "r2", appearance: nil))
        )
        let response = try XCTUnwrap(result as? WebSocketResponse)
        XCTAssertEqual(response.success, true)
        XCTAssertEqual(response.text, "unspecified")
        XCTAssertEqual(control.setCalls, [])
    }

    func testRejectsUnknownAppearanceWithoutSetting() async throws {
        let control = FakeAppearanceControl()
        let result = await handler(control: control).handle(
            .appearance(RequestAppearance(requestId: "r3", appearance: "sepia"))
        )
        let response = try XCTUnwrap(result as? WebSocketResponse)
        XCTAssertEqual(response.type, "appearance_result")
        XCTAssertEqual(response.success, false)
        XCTAssertEqual(control.setCalls, [])
    }

    func testSetFailureIsAnErrorResult() async throws {
        let control = FakeAppearanceControl(failure: "appearance unavailable")
        let result = await handler(control: control).handle(
            .appearance(RequestAppearance(requestId: "r4", appearance: "light"))
        )
        let response = try XCTUnwrap(result as? WebSocketResponse)
        XCTAssertEqual(response.success, false)
        XCTAssertEqual(response.error, "appearance unavailable")
    }
}
