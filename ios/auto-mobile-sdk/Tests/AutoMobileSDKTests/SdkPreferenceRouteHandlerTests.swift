@testable import AutoMobileSDK
import Foundation
import XCTest

final class SdkPreferenceRouteHandlerTests: XCTestCase {
    private func request(
        _ operation: String,
        appId: String = "com.example.app",
        suite: String = "duoStore",
        key: String? = nil,
        value: String? = nil,
        type: String? = nil,
        sessionId: String? = nil
    )
        throws -> Data
    {
        var fields = ["operation": operation, "appId": appId, "suiteName": suite]
        if let key { fields["key"] = key }
        if let value { fields["value"] = value }
        if let type { fields["valueType"] = type }
        if let sessionId { fields["sessionId"] = sessionId }
        return try JSONSerialization.data(withJSONObject: fields)
    }

    override func tearDown() {
        DatabaseInspector.shared.configure(StorageInspectionConfiguration())
        DatabaseInspector.shared.authorizeHostMutations(false)
        DatabaseInspector.shared.authorizeSessionMutations(sessionId: nil)
        super.tearDown()
    }

    private func authorizeMutations() {
        DatabaseInspector.shared.configure(StorageInspectionConfiguration(allowMutations: true))
        DatabaseInspector.shared.authorizeHostMutations(true)
        DatabaseInspector.shared.authorizeSessionMutations(sessionId: "session-1")
    }

    func testRoutesTypedWritesAndReadsToAppDriver() throws {
        let driver = FakeUserDefaultsDriver()
        authorizeMutations()
        let handler = SdkPreferenceRouteHandler(
            driver: { driver }, bundleId: { "com.example.app" }, currentSessionId: { "session-1" }
        )
        XCTAssertEqual(
            try handler.handle(body: request("set", key: "kvDuo", value: "42", type: "INT", sessionId: "session-1"))
                .statusCode,
            200
        )
        XCTAssertEqual(driver.getValue(suiteName: "duoStore", key: "kvDuo")?.type, .int)
        XCTAssertEqual(driver.getValue(suiteName: "duoStore", key: "kvDuo")?.value, "42")
        XCTAssertEqual(try handler.handle(body: request("get", key: "kvDuo")).statusCode, 200)
        XCTAssertEqual(
            try handler.handle(body: request("remove", key: "kvDuo", sessionId: "session-1")).statusCode,
            200
        )
        XCTAssertNil(driver.getValue(suiteName: "duoStore", key: "kvDuo"))
        driver.setValue(suiteName: "duoStore", key: "other", value: "x", type: .string)
        XCTAssertEqual(try handler.handle(body: request("clear", sessionId: "session-1")).statusCode, 200)
        XCTAssertTrue(driver.getValues(suiteName: "duoStore").isEmpty)
    }

    func testRejectsMissingSdkInspectorAndWrongAppWithoutWriting() throws {
        let driver = FakeUserDefaultsDriver()
        let unavailable = SdkPreferenceRouteHandler(driver: { nil }, bundleId: { "com.example.app" })
        let wrongApp = SdkPreferenceRouteHandler(driver: { driver }, bundleId: { "com.other.app" })
        let body = try request("set", key: "kvDuo", value: "42", type: "INT")
        XCTAssertEqual(unavailable.handle(body: body).statusCode, 503)
        XCTAssertEqual(wrongApp.handle(body: body).statusCode, 409)
        XCTAssertTrue(driver.getValues(suiteName: "duoStore").isEmpty)
    }

    func testRejectsNonPropertyListCollectionWithoutWriting() throws {
        let driver = FakeUserDefaultsDriver()
        authorizeMutations()
        let handler = SdkPreferenceRouteHandler(
            driver: { driver }, bundleId: { "com.example.app" }, currentSessionId: { "session-1" }
        )
        let body = try request("set", key: "invalid", value: "[null]", type: "ARRAY", sessionId: "session-1")
        XCTAssertEqual(handler.handle(body: body).statusCode, 400)
        XCTAssertTrue(driver.getValues(suiteName: "duoStore").isEmpty)
    }

    func testMutationsRejectMissingAndMismatchedSessions() throws {
        let driver = FakeUserDefaultsDriver()
        authorizeMutations()
        let handler = SdkPreferenceRouteHandler(
            driver: { driver }, bundleId: { "com.example.app" }, currentSessionId: { "session-1" }
        )
        for sessionId in [nil, "other-session"] as [String?] {
            XCTAssertEqual(
                try handler.handle(body: request(
                    "set",
                    key: "token",
                    value: "secret",
                    type: "STRING",
                    sessionId: sessionId
                )).statusCode,
                403
            )
            XCTAssertEqual(
                try handler.handle(body: request("remove", key: "token", sessionId: sessionId)).statusCode,
                403
            )
            XCTAssertEqual(try handler.handle(body: request("clear", sessionId: sessionId)).statusCode, 403)
        }
        XCTAssertTrue(driver.getValues(suiteName: "duoStore").isEmpty)
    }

    func testSensitiveKeysAreRedactedOnEntriesAndGet() throws {
        let driver = FakeUserDefaultsDriver()
        driver.setValue(suiteName: "duoStore", key: "access_token", value: "secret-value", type: .string)
        driver.setValue(suiteName: "duoStore", key: "configured", value: "private-value", type: .string)
        DatabaseInspector.shared.configure(StorageInspectionConfiguration(sensitiveKeys: ["configured"]))
        let handler = SdkPreferenceRouteHandler(driver: { driver }, bundleId: { "com.example.app" })
        for body in try [request("entries"), request("get", key: "access_token"), request("get", key: "configured")] {
            let response = handler.handle(body: body)
            XCTAssertEqual(response.statusCode, 200)
            let text = try XCTUnwrap(String(data: response.body, encoding: .utf8))
            XCTAssertTrue(text.contains("[REDACTED]"))
            XCTAssertFalse(text.contains("secret-value"))
            XCTAssertFalse(text.contains("private-value"))
        }
    }
}
