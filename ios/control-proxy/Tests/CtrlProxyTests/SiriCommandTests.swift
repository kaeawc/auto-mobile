@testable import CtrlProxy
import Foundation
import XCTest

/// Records `activate(text:)` calls (#14109).
@MainActor
private final class FakeSiriControl: SiriControlling {
    private(set) var activations: [String] = []
    private let failure: String?

    init(failure: String? = nil) {
        self.failure = failure
    }

    func activate(text: String) throws {
        activations.append(text)
        if let failure { throw VerbatimLocalizedError(message: failure) }
    }
}

@MainActor
final class SiriCommandTests: XCTestCase {
    private func handler(control: FakeSiriControl) -> CommandHandler {
        CommandHandler(
            elementLocator: FakeElementLocator(),
            gesturePerformer: FakeGesturePerformer(),
            perf: PerfProvider(),
            siriControl: control
        )
    }

    func testDecodesAndActivatesWithTrimmedText() async throws {
        let request = try JSONDecoder().decode(WebSocketRequest.self, from: Data(
            #"{"type":"request_siri","requestId":"r1","text":"  Show my orders in Playground "}"#.utf8
        ))
        let control = FakeSiriControl()
        let result = await handler(control: control).handle(request)
        let response = try XCTUnwrap(result as? WebSocketResponse)
        XCTAssertEqual(response.type, "siri_result")
        XCTAssertEqual(response.requestId, "r1")
        XCTAssertEqual(response.success, true)
        XCTAssertEqual(control.activations, ["Show my orders in Playground"])
    }

    func testRejectsBlankTextWithoutActivating() async throws {
        let control = FakeSiriControl()
        let result = await handler(control: control).handle(
            .siri(RequestSiri(requestId: "r2", text: "   "))
        )
        let response = try XCTUnwrap(result as? WebSocketResponse)
        XCTAssertEqual(response.type, "siri_result")
        XCTAssertEqual(response.success, false)
        XCTAssertEqual(control.activations, [])
    }

    func testActivationFailureIsAnErrorResult() async throws {
        let control = FakeSiriControl(failure: "Siri unavailable")
        let result = await handler(control: control).handle(
            .siri(RequestSiri(requestId: "r3", text: "Start a workout"))
        )
        let response = try XCTUnwrap(result as? WebSocketResponse)
        XCTAssertEqual(response.success, false)
        XCTAssertEqual(response.error, "Siri unavailable")
    }
}
