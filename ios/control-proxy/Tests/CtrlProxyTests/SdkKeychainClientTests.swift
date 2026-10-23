import AutoMobileSdkWire
@testable import CtrlProxy
import Foundation
import XCTest

final class SdkKeychainClientTests: XCTestCase {
    func testPostsExactSelectorAndAuthorizationAndPreservesDenials() async throws {
        for (status, outcome) in [
            (200, "deleted"),
            (403, "mutation_not_authorized"),
            (400, "invalid_selector"),
            (409, "app_id_mismatch"),
            (500, "keychain_error"),
        ] {
            let selector = KeychainItemSelector(
                itemClass: "genericPassword",
                service: "service",
                account: "fixture",
                accessGroup: "TEAM.app"
            )
            let expected = KeychainDeleteOutcome(outcome: outcome, deletedScope: outcome == "deleted" ? selector : nil)
            let transport = try StubHTTPTransport(status: status, body: JSONEncoder().encode(expected))
            let client = try SdkKeychainClient(
                baseURL: XCTUnwrap(URL(string: "http://localhost:8766")),
                transport: transport
            )
            let result = try await client.deleteKeychainItem(
                appId: "app",
                sessionId: "session",
                mutationToken: "token",
                confirm: true,
                selector: selector
            )
            XCTAssertEqual(result, expected)
            let request = try XCTUnwrap(transport.recordedRequests.first)
            XCTAssertEqual(request.url?.path, "/keychain/delete")
            XCTAssertEqual(request.httpMethod, "POST")
            let payload = try JSONDecoder().decode(KeychainDeleteRequest.self, from: XCTUnwrap(request.httpBody))
            XCTAssertEqual(
                payload,
                KeychainDeleteRequest(
                    appId: "app",
                    sessionId: "session",
                    mutationToken: "token",
                    confirm: true,
                    selector: selector
                )
            )
        }
    }

    func testTransportFailureAndMissingRouteAreUnavailable() async throws {
        for transport in [StubHTTPTransport([.transportError]), StubHTTPTransport(status: 404, body: Data("{}".utf8))] {
            let client = try SdkKeychainClient(
                baseURL: XCTUnwrap(URL(string: "http://localhost:8766")),
                transport: transport
            )
            do {
                _ = try await client.deleteKeychainItem(
                    appId: "app",
                    sessionId: nil,
                    mutationToken: nil,
                    confirm: true,
                    selector: KeychainItemSelector(
                        itemClass: "genericPassword",
                        service: "s",
                        account: "a",
                        accessGroup: "g"
                    )
                )
                XCTFail("Expected unavailable SDK")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains("AutoMobile SDK"))
            }
        }
    }
}
