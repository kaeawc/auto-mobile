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
        sessionId: String? = nil,
        mutationToken: String? = nil
    )
        throws -> Data
    {
        var fields = ["operation": operation, "appId": appId, "suiteName": suite]
        if let key { fields["key"] = key }
        if let value { fields["value"] = value }
        if let type { fields["valueType"] = type }
        if let sessionId { fields["sessionId"] = sessionId }
        if let mutationToken { fields["mutationToken"] = mutationToken }
        return try JSONSerialization.data(withJSONObject: fields)
    }

    override func tearDown() {
        DatabaseInspector.shared.configure(StorageInspectionConfiguration())
        DatabaseInspector.shared.authorizeHostMutations(false)
        DatabaseInspector.shared.authorizeSessionMutations(sessionId: nil)
        DatabaseInspector.shared.authorizeMutationToken("")
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

    func testListDoesNotExposeSdkSessionOrToken() throws {
        DatabaseInspector.shared.authorizeMutationToken("launch-secret")
        let handler = SdkPreferenceRouteHandler(
            driver: { FakeUserDefaultsDriver() },
            bundleId: { "com.example.app" },
            currentSessionId: { "active-sdk-session" }
        )
        let response = try handler.handle(body: request("list"))
        XCTAssertEqual(response.statusCode, 200)
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: response.body) as? [String: Any])
        XCTAssertNil(payload["sessionId"])
        XCTAssertNil(payload["mutationToken"])
    }

    func testLaunchScopedMutationTokenAuthorizesWrites() throws {
        let driver = FakeUserDefaultsDriver()
        DatabaseInspector.shared.configure(StorageInspectionConfiguration(allowMutations: true))
        DatabaseInspector.shared.authorizeHostMutations(true)
        DatabaseInspector.shared.authorizeMutationToken("launch-token")
        let handler = SdkPreferenceRouteHandler(
            driver: { driver }, bundleId: { "com.example.app" }, currentSessionId: { "session-1" }
        )
        for token in [nil, "wrong", ""] as [String?] {
            XCTAssertEqual(try handler.handle(body: request(
                "set", key: "key", value: "value", type: "STRING", mutationToken: token
            )).statusCode, 403)
        }
        XCTAssertNil(driver.getValue(suiteName: "duoStore", key: "key"))
        XCTAssertEqual(try handler.handle(body: request(
            "set", key: "key", value: "value", type: "STRING", mutationToken: "launch-token"
        )).statusCode, 200)
        XCTAssertEqual(try handler.handle(body: request(
            "remove", key: "key", mutationToken: "launch-token"
        )).statusCode, 200)
        DatabaseInspector.shared.authorizeHostMutations(false)
        XCTAssertEqual(try handler.handle(body: request(
            "set", key: "key", value: "value", type: "STRING", mutationToken: "launch-token"
        )).statusCode, 403)
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

    private func resolvedHandler(_ driver: any UserDefaultsDriver) -> SdkPreferenceRouteHandler {
        SdkPreferenceRouteHandler(
            driver: { driver }, bundleId: { "com.example.app" }, currentSessionId: { "session-1" },
            suiteIsValid: { $0 != "NSGlobalDomain" }
        )
    }

    private func payload(_ response: SdkRouteResponse) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: response.body) as? [String: Any])
    }

    func testStandardNameVariantsWriteToStandardAndReportResolvedStore() throws {
        authorizeMutations()
        let driver = RecordingUserDefaultsDriver()
        let handler = resolvedHandler(driver)
        for name in ["", "Standard", "standard", "STANDARD", "com.example.app", "COM.EXAMPLE.APP"] {
            for operation in ["set", "get", "remove"] {
                let response = try handler.handle(body: request(
                    operation, suite: name, key: "key", value: "42", type: "INT", sessionId: "session-1"
                ))
                XCTAssertEqual(response.statusCode, 200)
                XCTAssertEqual(try payload(response)["resolvedStore"] as? String, "standard")
            }
        }
        XCTAssertFalse(driver.calls.isEmpty)
        XCTAssertTrue(driver.calls.allSatisfy { $0.suiteName == nil })
    }

    func testRegisteredAppGroupSuiteIsUsedVerbatimAndReported() throws {
        authorizeMutations()
        let driver = RecordingUserDefaultsDriver()
        let handler = resolvedHandler(driver)
        let name = "group.com.example.shared"
        let response = try handler.handle(body: request(
            "set", suite: name, key: "key", value: "42", type: "INT", sessionId: "session-1"
        ))
        XCTAssertEqual(response.statusCode, 200)
        XCTAssertEqual(try payload(response)["resolvedStore"] as? String, name)
        XCTAssertTrue(driver.calls.allSatisfy { $0.suiteName == name })
        XCTAssertEqual(driver.getValue(suiteName: name, key: "key")?.value, "42")
    }

    func testInvalidStoreNameFailsEveryRouteWithoutTouchingTheDriver() throws {
        authorizeMutations()
        let driver = RecordingUserDefaultsDriver()
        let handler = resolvedHandler(driver)
        for operation in ["entries", "get", "set", "remove", "clear"] {
            let response = try handler.handle(body: request(
                operation, suite: "NSGlobalDomain", key: "key", value: "42", type: "INT", sessionId: "session-1"
            ))
            XCTAssertEqual(response.statusCode, 400)
            XCTAssertEqual(try payload(response)["error"] as? String, "invalid_store_name")
        }
        for operation in ["set", "remove", "clear"] {
            XCTAssertEqual(try handler.handle(body: request(
                operation, suite: "NSGlobalDomain", key: "key", value: "42", type: "INT"
            )).statusCode, 403)
        }
        XCTAssertEqual(try payload(handler.handle(body: request(
            "get", suite: "NSGlobalDomain"
        )))["error"] as? String, "missing_key")
        XCTAssertEqual(try payload(handler.handle(body: request(
            "set", suite: "NSGlobalDomain", key: "key", value: "invalid", type: "INT", sessionId: "session-1"
        )))["error"] as? String, "invalid_preference_value")
        XCTAssertTrue(driver.calls.isEmpty)
    }

    func testDroppedWriteFailsVerification() throws {
        authorizeMutations()
        let response = try resolvedHandler(DroppingWritesDriver()).handle(body: request(
            "set", key: "key", value: "42", type: "INT", sessionId: "session-1"
        ))
        XCTAssertEqual(response.statusCode, 500)
        XCTAssertEqual(try payload(response)["error"] as? String, "write_verification_failed")
    }

    func testMismatchedReadBackFailsVerification() throws {
        authorizeMutations()
        let response = try resolvedHandler(MismatchingWritesDriver()).handle(body: request(
            "set", key: "key", value: "a", type: "STRING", sessionId: "session-1"
        ))
        XCTAssertEqual(response.statusCode, 500)
        XCTAssertEqual(try payload(response)["error"] as? String, "write_verification_failed")
    }

    func testRemoveIsVerified() throws {
        authorizeMutations()
        let dropping = DroppingWritesDriver()
        dropping.fake.setValue(suiteName: "duoStore", key: "key", value: "value", type: .string)
        let failed = try resolvedHandler(dropping).handle(body: request(
            "remove", key: "key", sessionId: "session-1"
        ))
        XCTAssertEqual(failed.statusCode, 500)
        XCTAssertEqual(try payload(failed)["error"] as? String, "write_verification_failed")
        let normal = RecordingUserDefaultsDriver()
        normal.setValue(suiteName: "duoStore", key: "key", value: "value", type: .string)
        for key in ["key", "absent"] {
            let response = try resolvedHandler(normal).handle(body: request(
                "remove", key: key, sessionId: "session-1"
            ))
            XCTAssertEqual(response.statusCode, 200)
            XCTAssertEqual(try payload(response)["resolvedStore"] as? String, "duoStore")
        }
    }

    func testEntriesGetAndClearReportResolvedStore() throws {
        authorizeMutations()
        let driver = RecordingUserDefaultsDriver()
        let handler = resolvedHandler(driver)
        for operation in ["entries", "get", "clear"] {
            let response = try handler.handle(body: request(
                operation, suite: "standard", key: "absent", sessionId: "session-1"
            ))
            XCTAssertEqual(response.statusCode, 200)
            XCTAssertEqual(try payload(response)["resolvedStore"] as? String, "standard")
        }
        let response = try handler.handle(body: request("list", suite: "NSGlobalDomain"))
        XCTAssertEqual(response.statusCode, 200)
        XCTAssertNil(try payload(response)["resolvedStore"])
    }

    func testRemoveRegisteredOnlyValueVerifiesPersistentAbsence() throws {
        authorizeMutations()
        let name = "auto-mobile-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.register(defaults: ["key": "registered"])
        let driver = DefaultUserDefaultsDriver(makeDefaults: { _ in defaults })
        let response = try resolvedHandler(driver).handle(body: request(
            "remove", suite: name, key: "key", sessionId: "session-1"
        ))
        XCTAssertEqual(response.statusCode, 200)
        XCTAssertEqual(defaults.object(forKey: "key") as? String, "registered")
        XCTAssertNil(defaults.persistentDomain(forName: name)?["key"])
        XCTAssertNil(try payload(response)["effectiveValueDiffers"])
    }

    func testRemovePersistentValueStillExposesRegisteredDefault() throws {
        authorizeMutations()
        let name = "auto-mobile-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.register(defaults: ["key": "registered"])
        defaults.set("stored", forKey: "key")
        // Same-process persistent reads must see set/remove immediately, without synchronize.
        XCTAssertEqual(defaults.persistentDomain(forName: name)?["key"] as? String, "stored")
        let driver = DefaultUserDefaultsDriver(makeDefaults: { _ in defaults })
        let response = try resolvedHandler(driver).handle(body: request(
            "remove", suite: name, key: "key", sessionId: "session-1"
        ))
        XCTAssertEqual(response.statusCode, 200)
        XCTAssertNil(defaults.persistentDomain(forName: name)?["key"])
        XCTAssertEqual(defaults.object(forKey: "key") as? String, "registered")
    }

    func testSetOverridesRegisteredDefaultAndVerifiesWithoutSynchronize() throws {
        authorizeMutations()
        let name = "auto-mobile-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.register(defaults: ["key": "registered"])
        let driver = DefaultUserDefaultsDriver(makeDefaults: { _ in defaults })
        let response = try resolvedHandler(driver).handle(body: request(
            "set", suite: name, key: "key", value: "written", type: "STRING", sessionId: "session-1"
        ))
        XCTAssertEqual(response.statusCode, 200)
        XCTAssertEqual(defaults.persistentDomain(forName: name)?["key"] as? String, "written")
        XCTAssertEqual(defaults.object(forKey: "key") as? String, "written")
        XCTAssertNil(try payload(response)["effectiveValueDiffers"])
    }

    func testSetReportsEffectiveOverrideAfterSuccessfulPersistentVerification() throws {
        authorizeMutations()
        let name = "auto-mobile-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(OverridingDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let driver = DefaultUserDefaultsDriver(makeDefaults: { _ in defaults })
        for override in ["override", nil, 42] as [Any?] {
            defaults.overrideValue = override
            let response = try resolvedHandler(driver).handle(body: request(
                "set", suite: name, key: "key", value: "written", type: "STRING", sessionId: "session-1"
            ))
            XCTAssertEqual(response.statusCode, 200)
            XCTAssertEqual(defaults.persistentDomain(forName: name)?["key"] as? String, "written")
            XCTAssertEqual(try payload(response)["effectiveValueDiffers"] as? Bool, true)
        }
    }

    func testClearIgnoresRegisteredDefaultsAndVerifiesPriorPersistentKeys() throws {
        authorizeMutations()
        let name = "auto-mobile-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.register(defaults: ["registeredOnly": "registered", "key": "registered"])
        defaults.set("stored", forKey: "key")
        defaults.set(42, forKey: "other")
        let driver = DefaultUserDefaultsDriver(makeDefaults: { _ in defaults })
        let response = try resolvedHandler(driver).handle(body: request(
            "clear", suite: name, sessionId: "session-1"
        ))
        XCTAssertEqual(response.statusCode, 200)
        XCTAssertTrue((defaults.persistentDomain(forName: name) ?? [:]).isEmpty)
        XCTAssertEqual(defaults.object(forKey: "key") as? String, "registered")
        XCTAssertNil(try payload(response)["effectiveValueDiffers"])
    }

    func testPersistentReaderReceivesBundleDomainForStandardAndSuiteDomainForSuite() throws {
        authorizeMutations()
        for name in ["Standard", "group.com.example.shared"] {
            let driver = RecordingPersistentDriver()
            let handler = resolvedHandler(driver)
            for operation in ["set", "remove", "clear"] {
                driver.fake.setValue(
                    suiteName: name == "Standard" ? nil : name,
                    key: "key",
                    value: "prior",
                    type: .string
                )
                let response = try handler.handle(body: request(
                    operation, suite: name, key: "key", value: "written", type: "STRING", sessionId: "session-1"
                ))
                XCTAssertEqual(response.statusCode, 200)
            }
            let expectedDomain = name == "Standard" ? "com.example.app" : name
            XCTAssertFalse(driver.domainReads.isEmpty)
            XCTAssertTrue(driver.domainReads.allSatisfy {
                $0.domain == expectedDomain && $0.suiteName == (name == "Standard" ? nil : name)
            })
        }
    }

    func testPersistentReaderRejectsDroppedSetNoOpRemoveAndNoOpClear() throws {
        authorizeMutations()
        for operation in ["set", "remove", "clear"] {
            let driver = RecordingPersistentDriver()
            driver.dropMutations = true
            driver.fake.setValue(suiteName: "duoStore", key: "key", value: "prior", type: .string)
            let response = try resolvedHandler(driver).handle(body: request(
                operation, key: "key", value: "written", type: "STRING", sessionId: "session-1"
            ))
            XCTAssertEqual(response.statusCode, 500)
            XCTAssertEqual(try payload(response)["error"] as? String, "write_verification_failed")
        }
    }

    func testNonConformingFakeClearIsAlsoVerified() throws {
        authorizeMutations()
        let driver = DroppingWritesDriver()
        driver.fake.setValue(suiteName: "duoStore", key: "key", value: "prior", type: .string)
        let response = try resolvedHandler(driver).handle(body: request("clear", sessionId: "session-1"))
        XCTAssertEqual(response.statusCode, 500)
        XCTAssertEqual(try payload(response)["error"] as? String, "write_verification_failed")
    }

    func testTypedWritesVerifyAgainstRealUserDefaultsSuite() throws {
        authorizeMutations()
        let name = "auto-mobile-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let driver = DefaultUserDefaultsDriver(makeDefaults: { _ in defaults })
        let handler = SdkPreferenceRouteHandler(
            driver: { driver }, bundleId: { "com.example.app" }, currentSessionId: { "session-1" }
        )
        let values = [
            ("STRING", "a"), ("INT", "42"), ("DOUBLE", "3.0"), ("BOOLEAN", "true"),
            ("DATA", Data([1, 2, 3]).base64EncodedString()), ("DATE", "2026-09-30T12:34:56.123Z"),
            ("ARRAY", "[1,\"a\"]"), ("DICTIONARY", "{\"k\":1}"),
        ]
        for (type, value) in values {
            let response = try handler.handle(body: request(
                "set", suite: name, key: type, value: value, type: type, sessionId: "session-1"
            ))
            XCTAssertEqual(response.statusCode, 200, "\(type): \(String(data: response.body, encoding: .utf8) ?? "")")
            XCTAssertNil(try payload(response)["effectiveValueDiffers"])
        }
    }
}

private class RecordingUserDefaultsDriver: UserDefaultsDriver, @unchecked Sendable {
    let fake = FakeUserDefaultsDriver()
    var calls: [(operation: String, suiteName: String?)] = []

    func getSuites() -> [UserDefaultsSuiteDescriptor] {
        calls.append(("list", nil))
        return fake.getSuites()
    }

    func getValues(suiteName: String?) -> [KeyValuePair] {
        calls.append(("entries", suiteName))
        return fake.getValues(suiteName: suiteName)
    }

    func getValue(suiteName: String?, key: String) -> KeyValuePair? {
        calls.append(("get", suiteName))
        return fake.getValue(suiteName: suiteName, key: key)
    }

    func setValue(suiteName: String?, key: String, value: Any?, type: KeyValueType) {
        calls.append(("set", suiteName))
        fake.setValue(suiteName: suiteName, key: key, value: value, type: type)
    }

    func removeValue(suiteName: String?, key: String) {
        calls.append(("remove", suiteName))
        fake.removeValue(suiteName: suiteName, key: key)
    }

    func clear(suiteName: String?) {
        calls.append(("clear", suiteName))
        fake.clear(suiteName: suiteName)
    }
}

private final class DroppingWritesDriver: RecordingUserDefaultsDriver, @unchecked Sendable {
    override func setValue(suiteName _: String?, key _: String, value _: Any?, type _: KeyValueType) {}
    override func removeValue(suiteName _: String?, key _: String) {}
    override func clear(suiteName _: String?) {}
}

private final class MismatchingWritesDriver: RecordingUserDefaultsDriver, @unchecked Sendable {
    override func setValue(suiteName: String?, key: String, value: Any?, type: KeyValueType) {
        super.setValue(suiteName: suiteName, key: key, value: "\(value ?? "")x", type: type)
    }
}

private final class OverridingDefaults: UserDefaults, @unchecked Sendable {
    var overrideValue: Any? = "override"

    override func object(forKey defaultName: String) -> Any? {
        defaultName == "key" ? overrideValue : super.object(forKey: defaultName)
    }
}

private final class RecordingPersistentDriver: RecordingUserDefaultsDriver, PersistentDomainReading,
    @unchecked Sendable
{
    var domainReads: [(domain: String, suiteName: String?)] = []
    var dropMutations = false

    func persistentValue(domain: String, suiteName: String?, key: String) -> KeyValuePair? {
        domainReads.append((domain, suiteName))
        return fake.getValue(suiteName: suiteName, key: key)
    }

    func persistentKeys(domain: String, suiteName: String?) -> Set<String> {
        domainReads.append((domain, suiteName))
        return Set(fake.getValues(suiteName: suiteName).map(\.key))
    }

    override func setValue(suiteName: String?, key: String, value: Any?, type: KeyValueType) {
        if !dropMutations { super.setValue(suiteName: suiteName, key: key, value: value, type: type) }
    }

    override func removeValue(suiteName: String?, key: String) {
        if !dropMutations { super.removeValue(suiteName: suiteName, key: key) }
    }

    override func clear(suiteName: String?) {
        if !dropMutations { super.clear(suiteName: suiteName) }
    }
}
