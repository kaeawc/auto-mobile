@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeTapDisambiguatorTests: XCTestCase {
    func testDoubleTapCancelsPendingSingle() {
        var resolver = PrototypeTapDisambiguator()
        XCTAssertEqual(resolver.tap(at: 0), .deferSingle(deadline: 0.35))
        XCTAssertEqual(resolver.tap(at: 0.1), .fireDouble)
        XCTAssertFalse(resolver.expire(at: 1))
    }

    func testSingleTapExpiresAtWindowExactlyOnce() {
        var resolver = PrototypeTapDisambiguator()
        XCTAssertFalse(resolver.expire(at: 0))
        XCTAssertEqual(resolver.tap(at: 0), .deferSingle(deadline: 0.35))
        XCTAssertFalse(resolver.expire(at: 0.34))
        XCTAssertTrue(resolver.expire(at: 0.35))
        XCTAssertFalse(resolver.expire(at: 1))
    }

    func testExpiredPendingTapIsReplacedByNewFirstTap() {
        var resolver = PrototypeTapDisambiguator()
        XCTAssertEqual(resolver.tap(at: 0), .deferSingle(deadline: 0.35))
        XCTAssertEqual(resolver.tap(at: 1), .deferSingle(deadline: 1.35))
        XCTAssertFalse(resolver.expire(at: 1.1))
        XCTAssertTrue(resolver.expire(at: 2))
    }

    func testTripleTapStartsNewPendingSingleAfterDouble() {
        var resolver = PrototypeTapDisambiguator()
        XCTAssertEqual(resolver.tap(at: 0), .deferSingle(deadline: 0.35))
        XCTAssertEqual(resolver.tap(at: 0.1), .fireDouble)
        XCTAssertEqual(resolver.tap(at: 0.2), .deferSingle(deadline: 0.2 + 0.35))
        XCTAssertTrue(resolver.expire(at: 1))
    }

    func testDoubleTapIncludesWindowBoundary() {
        var resolver = PrototypeTapDisambiguator()
        XCTAssertEqual(resolver.tap(at: 0), .deferSingle(deadline: 0.35))
        XCTAssertEqual(resolver.tap(at: 0.35), .fireDouble)
        XCTAssertFalse(resolver.expire(at: 1))
    }

    func testWindowCanBeInjected() {
        var resolver = PrototypeTapDisambiguator(window: 0.5)
        XCTAssertEqual(resolver.tap(at: 0), .deferSingle(deadline: 0.5))
        XCTAssertFalse(resolver.expire(at: 0.35))
        XCTAssertEqual(resolver.tap(at: 0.4), .fireDouble)
        XCTAssertEqual(resolver.tap(at: 1), .deferSingle(deadline: 1.5))
        XCTAssertTrue(resolver.expire(at: 1.5))
    }
}
