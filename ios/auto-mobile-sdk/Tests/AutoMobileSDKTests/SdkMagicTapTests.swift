@testable import AutoMobileSDK
import XCTest

@MainActor
private final class FakeMagicTapResponder: MagicTapResponding {
    var magicTapNext: (any MagicTapResponding)?
    var handled = false
    var calls = 0
    func performMagicTap() -> Bool {
        calls += 1
        return handled
    }
}

@MainActor
final class SdkMagicTapTests: XCTestCase {
    func testStopsAtFirstHandler() {
        let first = FakeMagicTapResponder()
        let handler = FakeMagicTapResponder()
        let last = FakeMagicTapResponder()
        first.magicTapNext = handler
        handler.magicTapNext = last
        handler.handled = true
        XCTAssertTrue(SdkMagicTap.perform(start: first, fallbacks: [last]))
        XCTAssertEqual(first.calls, 1)
        XCTAssertEqual(handler.calls, 1)
        XCTAssertEqual(last.calls, 0)
    }

    func testMissingFirstResponderUsesWindowThenApplication() {
        let window = FakeMagicTapResponder()
        let application = FakeMagicTapResponder()
        application.handled = true
        XCTAssertTrue(SdkMagicTap.perform(start: nil, fallbacks: [window, application]))
        XCTAssertEqual(window.calls, 1)
        XCTAssertEqual(application.calls, 1)
    }

    func testUnhandledChainAndOverlappingFallbacksAreVisitedOnce() {
        let first = FakeMagicTapResponder()
        let application = FakeMagicTapResponder()
        first.magicTapNext = application
        application.magicTapNext = first
        XCTAssertFalse(SdkMagicTap.perform(start: first, fallbacks: [first, application]))
        XCTAssertEqual(first.calls, 1)
        XCTAssertEqual(application.calls, 1)
        application.magicTapNext = nil
        first.magicTapNext = nil
    }
}
