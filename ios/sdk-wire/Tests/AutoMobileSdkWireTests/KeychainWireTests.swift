import AutoMobileSdkWire
import Foundation
import XCTest

final class KeychainWireTests: XCTestCase {
    func testDeletionRouteAndWireRoundTrip() throws {
        XCTAssertEqual(SdkRoute.keychainDelete.path, "/keychain/delete")
        XCTAssertEqual(SdkRoute.keychainDelete.method, "POST")
        let selector = KeychainItemSelector(
            itemClass: "genericPassword",
            service: "service",
            account: "fixture",
            accessGroup: "TEAM.app"
        )
        let request = KeychainDeleteRequest(
            appId: "app",
            sessionId: "session",
            mutationToken: "token",
            confirm: true,
            selector: selector
        )
        XCTAssertEqual(
            try JSONDecoder().decode(KeychainDeleteRequest.self, from: JSONEncoder().encode(request)),
            request
        )
        let outcome = KeychainDeleteOutcome(outcome: "deleted", deletedScope: selector)
        XCTAssertEqual(
            try JSONDecoder().decode(KeychainDeleteOutcome.self, from: JSONEncoder().encode(outcome)),
            outcome
        )
    }
}
