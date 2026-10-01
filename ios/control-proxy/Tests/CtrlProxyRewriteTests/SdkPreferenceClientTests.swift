@testable import CtrlProxyRewrite
import Foundation
import XCTest

final class SdkPreferenceClientTests: XCTestCase {
    func testListDoesNotExposeSdkSession() async throws {
        let transport = StubHTTPTransport(
            status: 200,
            body: Data("{\"files\":[],\"sessionId\":\"sdk-session\"}".utf8)
        )
        let client = try SdkPreferenceClient(
            baseURL: XCTUnwrap(URL(string: "http://localhost:8766")),
            transport: transport
        )
        let listing = try await client.list(appId: "com.example.app")
        XCTAssertTrue(listing.isEmpty)
    }

    func testPostsAppIdSuiteAndTypedValueToInAppServer() async throws {
        let transport = StubHTTPTransport(status: 200, body: Data("{}".utf8))
        let client = try SdkPreferenceClient(
            baseURL: XCTUnwrap(URL(string: "http://localhost:8766")),
            transport: transport
        )
        try await client.set(
            appId: "com.example.app",
            suiteName: "duoStore",
            key: "kvDuo",
            value: "42",
            type: "INT",
            sessionId: "session-1",
            mutationToken: "token-1"
        )
        let request = try XCTUnwrap(transport.recordedRequests.first)
        XCTAssertEqual(request.url?.path, "/preferences")
        XCTAssertEqual(request.httpMethod, "POST")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: String])
        XCTAssertEqual(body["appId"], "com.example.app")
        XCTAssertEqual(body["suiteName"], "duoStore")
        XCTAssertEqual(body["key"], "kvDuo")
        XCTAssertEqual(body["value"], "42")
        XCTAssertEqual(body["valueType"], "INT")
        XCTAssertEqual(body["sessionId"], "session-1")
        XCTAssertEqual(body["mutationToken"], "token-1")
    }

    func testAbsentSdkReturnsActionableGuidance() async throws {
        let transport = StubHTTPTransport([.transportError])
        let client = try SdkPreferenceClient(
            baseURL: XCTUnwrap(URL(string: "http://localhost:8766")),
            transport: transport
        )
        do {
            try await client.clear(appId: "com.example.app", suiteName: "duoStore", sessionId: nil, mutationToken: nil)
            XCTFail("Expected missing SDK to fail")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("embed the AutoMobile SDK"))
            XCTAssertTrue(error.localizedDescription.contains("UserDefaultsInspector.shared.setEnabled(true)"))
        }
    }

    func testConflictErrorsIdentifyForegroundAndAppId() async throws {
        for (code, expected) in [
            ("app_not_active", "bring it to the foreground and retry"),
            ("app_id_mismatch", "app id mismatch"),
        ] {
            let body = try JSONEncoder().encode(["error": code])
            let client = try SdkPreferenceClient(
                baseURL: XCTUnwrap(URL(string: "http://localhost:8766")),
                transport: StubHTTPTransport(status: 409, body: body)
            )
            do {
                try await client.clear(
                    appId: "com.example.app",
                    suiteName: "Standard",
                    sessionId: "session-1",
                    mutationToken: nil
                )
                XCTFail("Expected conflict")
            } catch {
                XCTAssertTrue(error.localizedDescription.contains(expected))
                XCTAssertFalse(error.localizedDescription.contains("embed the AutoMobile SDK"))
            }
        }
    }

    func testMissingRouteRetainsUpgradeGuidance() async throws {
        let client = try SdkPreferenceClient(
            baseURL: XCTUnwrap(URL(string: "http://localhost:8766")),
            transport: StubHTTPTransport(status: 404, body: Data("{}".utf8))
        )
        do {
            try await client.clear(appId: "com.example.app", suiteName: "Standard", sessionId: nil, mutationToken: nil)
            XCTFail("Expected missing route")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("embed or upgrade the AutoMobile SDK"))
        }
    }

    func testDisabledInspectorHasSpecificGuidance() async throws {
        let client = try SdkPreferenceClient(
            baseURL: XCTUnwrap(URL(string: "http://localhost:8766")),
            transport: StubHTTPTransport(
                status: 503,
                body: Data("{\"error\":\"user_defaults_inspection_disabled\"}".utf8)
            )
        )
        do {
            _ = try await client.list(appId: "com.example.app")
            XCTFail("Expected disabled inspector")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("UserDefaultsInspector.shared.setEnabled(true)"))
            XCTAssertFalse(error.localizedDescription.contains("embed the AutoMobile SDK"))
        }
    }
}
