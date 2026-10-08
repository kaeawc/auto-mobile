@testable import CtrlProxyRewrite
import XCTest

private struct ContradictingVoiceOverStateProvider: VoiceOverStateProviding {
    func isVoiceOverRunning() -> Bool? { false }
}

@MainActor
private final class RecordingVoiceOverToggle: VoiceOverToggling {
    private(set) var requests: [Bool] = []
    var failure: VoiceOverToggleError?

    func setVoiceOver(enabled: Bool) throws {
        requests.append(enabled)
        if let failure { throw failure }
    }
}

@MainActor
final class SetVoiceOverStateCommandTests: XCTestCase {
    private func handler(toggle: RecordingVoiceOverToggle) -> CommandHandler {
        CommandHandler(
            elementLocator: RewriteFakeElementLocator(),
            gesturePerformer: RewriteFakeGesturePerformer(),
            perf: PerfProvider(),
            voiceOverStateProvider: ContradictingVoiceOverStateProvider(),
            voiceOverToggle: toggle
        )
    }

    func testForwardsBothRequestedStatesEvenWhenProviderReportsFalse() async throws {
        let toggle = RecordingVoiceOverToggle()
        let handler = handler(toggle: toggle)

        for enabled in [true, false] {
            let result = await handler.handle(.setVoiceOverState(RequestSetVoiceOverState(
                requestId: "voiceover-test", enabled: enabled
            )))
            let response = try XCTUnwrap(result as? VoiceOverSetResponse)
            XCTAssertEqual(response.requestId, "voiceover-test")
            XCTAssertTrue(response.success)
            XCTAssertNil(response.error)
        }
        XCTAssertEqual(toggle.requests, [true, false])
    }

    func testToggleFailureReturnsErrorText() async throws {
        let toggle = RecordingVoiceOverToggle()
        toggle.failure = .switchStateUnreadable
        let result = await handler(toggle: toggle).handle(.setVoiceOverState(RequestSetVoiceOverState(
            requestId: "voiceover-error", enabled: false
        )))
        let response = try XCTUnwrap(result as? VoiceOverSetResponse)

        XCTAssertEqual(toggle.requests, [false])
        XCTAssertEqual(response.requestId, "voiceover-error")
        XCTAssertFalse(response.success)
        XCTAssertEqual(response.error, VoiceOverToggleError.switchStateUnreadable.localizedDescription)
    }
}
