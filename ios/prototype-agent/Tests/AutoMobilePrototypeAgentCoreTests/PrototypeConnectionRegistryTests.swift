@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeConnectionRegistryTests: XCTestCase {
    func testNoConnectionHasNoHost() {
        XCTAssertNil(PrototypeConnectionRegistry<Int>().current)
    }

    func testTheNewerConnectionIsTheHost() {
        var registry = PrototypeConnectionRegistry<Int>()
        registry.register(1)
        registry.register(2)
        XCTAssertEqual(registry.current, 2)
        XCTAssertEqual(registry.all, [1, 2])
    }

    func testUnregisteringTheNewerConnectionFallsBackToTheOlder() {
        var registry = PrototypeConnectionRegistry<Int>()
        registry.register(1)
        registry.register(2)
        registry.unregister(2)
        XCTAssertEqual(registry.current, 1)
        registry.unregister(1)
        XCTAssertNil(registry.current)
    }

    func testUnregisteringTheOlderConnectionKeepsTheNewerAsHost() {
        var registry = PrototypeConnectionRegistry<Int>()
        registry.register(1)
        registry.register(2)
        registry.unregister(1)
        XCTAssertEqual(registry.current, 2)
    }

    func testAuthenticatingAgainMovesAConnectionToTheFront() {
        var registry = PrototypeConnectionRegistry<Int>()
        registry.register(1)
        registry.register(2)
        registry.register(1)
        XCTAssertEqual(registry.current, 1)
        XCTAssertEqual(registry.all, [2, 1])
    }
}

final class PrototypeHostRoutingTests: XCTestCase {
    func testARequestIsOwnedByTheNewestConnectionAndFailsWhenItCloses() {
        var routing = PrototypeHostRouting<Int>()
        routing.authenticate(1)
        routing.authenticate(2)
        XCTAssertEqual(routing.route("r1"), 2)
        XCTAssertEqual(routing.disconnect(2), ["r1"])
        // The older connection stays, and is now the host for new requests.
        XCTAssertEqual(routing.route("r2"), 1)
    }

    func testClosingAnotherConnectionLeavesTheRequestRunning() {
        var routing = PrototypeHostRouting<Int>()
        routing.authenticate(1)
        routing.authenticate(2)
        XCTAssertEqual(routing.route("r1"), 2)
        XCTAssertEqual(routing.disconnect(1), [])
        XCTAssertEqual(routing.disconnect(2), ["r1"])
    }

    func testAFinishedRequestIsNotLost() {
        var routing = PrototypeHostRouting<Int>()
        routing.authenticate(1)
        XCTAssertEqual(routing.route("r1"), 1)
        routing.finish("r1")
        XCTAssertEqual(routing.disconnect(1), [])
    }

    func testNoConnectionRoutesNowhere() {
        var routing = PrototypeHostRouting<Int>()
        XCTAssertNil(routing.route("r1"))
    }
}
