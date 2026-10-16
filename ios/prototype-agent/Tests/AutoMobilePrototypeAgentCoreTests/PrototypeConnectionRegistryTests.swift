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
