@testable import CtrlProxyRewrite
import XCTest

private struct StubDefaultsReader: VoiceOverDefaultsReading {
    let value: Bool?
    func bool(forKey _: String, inDomain _: String) -> Bool? { value }
}

private struct StubStateProvider: VoiceOverStateProviding {
    let value: Bool?
    func isVoiceOverRunning() -> Bool? { value }
}

@MainActor
final class GetVoiceOverStateCommandTests: XCTestCase {
    private func state(_ value: Bool?) async throws -> VoiceOverStateResponse {
        let handler = CommandHandler(
            elementLocator: RewriteFakeElementLocator(),
            gesturePerformer: RewriteFakeGesturePerformer(),
            perf: PerfProvider(),
            voiceOverStateProvider: StubStateProvider(value: value)
        )
        let result = await handler.handle(.getVoiceOverState(RequestEnvelope(requestId: "vo-state")))
        return try XCTUnwrap(result as? VoiceOverStateResponse)
    }

    func testProviderPassesThroughReaderState() {
        for value in [true, false] {
            let provider = DefaultVoiceOverStateProvider(defaultsReader: StubDefaultsReader(value: value))
            XCTAssertEqual(provider.isVoiceOverRunning(), value)
        }
    }

    func testUnreadableDefaultsStayUnknown() {
        let provider = DefaultVoiceOverStateProvider(defaultsReader: StubDefaultsReader(value: nil))
        XCTAssertNil(provider.isVoiceOverRunning())
    }

    func testReadableStateIsSuccess() async throws {
        let response = try await state(true)
        XCTAssertTrue(response.success)
        XCTAssertTrue(response.enabled)
        XCTAssertNil(response.error)
    }

    func testUnreadableStateIsNotReportedAsOff() async throws {
        let response = try await state(nil)
        XCTAssertFalse(response.success)
        XCTAssertEqual(response.requestId, "vo-state")
        XCTAssertNotNil(response.error)
    }
}
