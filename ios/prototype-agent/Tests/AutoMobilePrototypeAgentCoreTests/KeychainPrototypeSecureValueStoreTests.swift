@testable import AutoMobilePrototypeAgentCore
import Security
import XCTest

/// In-memory Security boundary keyed by the real service + account attributes.
private final class FakeKeychainClient: KeychainClient {
    var items: [String: [String: [String: Any]]] = [:]
    var queries: [[String: Any]] = []
    var updates: [[String: Any]] = []
    var deletions: [[String: Any]] = []
    var readStatus: OSStatus?
    var accountStatus: OSStatus?

    func add(_ attributes: [String: Any]) -> OSStatus {
        queries.append(attributes)
        guard let service = attributes[kSecAttrService as String] as? String,
              let account = attributes[kSecAttrAccount as String] as? String else { return errSecParam }
        if items[service]?[account] != nil { return errSecDuplicateItem }
        items[service, default: [:]][account] = attributes
        return errSecSuccess
    }

    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        queries.append(query)
        updates.append(attributes)
        guard let service = query[kSecAttrService as String] as? String,
              let account = query[kSecAttrAccount as String] as? String,
              let old = items[service]?[account] else { return errSecItemNotFound }
        items[service]?[account] = old.merging(attributes) { _, value in value }
        return errSecSuccess
    }

    func copyMatching(_ query: [String: Any]) -> (OSStatus, Any?) {
        queries.append(query)
        guard let service = query[kSecAttrService as String] as? String else { return (errSecParam, nil) }
        if let account = query[kSecAttrAccount as String] as? String {
            if let accountStatus { return (accountStatus, nil) }
            guard let item = items[service]?[account] else { return (errSecItemNotFound, nil) }
            return (errSecSuccess, item[kSecValueData as String])
        }
        if let readStatus { return (readStatus, nil) }
        let result = (items[service] ?? [:]).values.map { item in
            query[kSecReturnData as String] as? Bool == true ? item : item.filter { $0.key != kSecValueData as String }
        }
        return result.isEmpty ? (errSecItemNotFound, nil) : (errSecSuccess, result)
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        queries.append(query)
        deletions.append(query)
        guard let service = query[kSecAttrService as String] as? String else { return errSecParam }
        if let account = query[kSecAttrAccount as String] as? String {
            guard items[service]?[account] != nil else { return errSecItemNotFound }
            items[service]?[account] = nil
        } else {
            items[service] = nil
        }
        return errSecSuccess
    }
}

final class KeychainPrototypeSecureValueStoreTests: XCTestCase {
    func testAttributesAndJSONPayloadUseTheFullIdAndStorageKey() throws {
        let client = FakeKeychainClient()
        let store = KeychainPrototypeSecureValueStore(client: client)
        let id = String(repeating: "a", count: 200)
        try store.write(id: id, key: "state:token", entry: .init(version: 3, value: "tok-test-1"))
        let attributes = try XCTUnwrap(client.queries.first)
        XCTAssertEqual(attributes[kSecClass as String] as? String, kSecClassGenericPassword as String)
        XCTAssertEqual(attributes[kSecAttrService as String] as? String, "dev.automobile.prototype." + id)
        XCTAssertEqual(attributes[kSecAttrAccount as String] as? String, "state:token")
        XCTAssertEqual(
            attributes[kSecAttrAccessible as String] as? String,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String
        )
        XCTAssertEqual(attributes[kSecAttrSynchronizable as String] as? Bool, false)
        let data = try XCTUnwrap(attributes[kSecValueData as String] as? Data)
        let object = try JSONDecoder().decode(JSONValue.self, from: data)
        XCTAssertEqual(object, .object(["v": .number(3), "value": .string("tok-test-1")]))
    }

    func testDuplicateAddsUpdateTheScopedItem() throws {
        let client = FakeKeychainClient()
        let store = KeychainPrototypeSecureValueStore(client: client)
        try store.write(id: "a", key: "state:token", entry: .init(version: 1, value: "tok-test-1"))
        try store.write(id: "a", key: "state:token", entry: .init(version: 2, value: "tok-test-2"))
        XCTAssertEqual(client.updates.count, 1)
        XCTAssertEqual(try store.readAll(id: "a").entries["state:token"], .init(version: 2, value: "tok-test-2"))
    }

    func testServicesAreIsolatedAndDeleteAllCannotTouchOtherPrototypesOrHostItems() throws {
        let client = FakeKeychainClient()
        let store = KeychainPrototypeSecureValueStore(client: client)
        for id in ["a", "b"] {
            try store.write(id: id, key: "state:token", entry: .init(version: 1, value: "tok-test-" + id))
        }
        client.items["host.app"] = ["password": [kSecAttrAccount as String: "password"]]
        XCTAssertEqual(try store.readAll(id: "a").entries["state:token"]?.value, "tok-test-a")
        XCTAssertEqual(try store.deleteAll(id: "a"), 1)
        XCTAssertTrue(try store.readAll(id: "a").entries.isEmpty)
        XCTAssertEqual(try store.readAll(id: "b").entries["state:token"]?.value, "tok-test-b")
        XCTAssertNotNil(client.items["host.app"])
        XCTAssertTrue(client.queries.allSatisfy { $0[kSecAttrService as String] != nil })
        let enumeration = try XCTUnwrap(client.queries.first { query in
            query[kSecAttrService as String] as? String == "dev.automobile.prototype.a"
                && query[kSecMatchLimit as String] as? String == kSecMatchLimitAll as String
                && query[kSecReturnData as String] == nil
        })
        XCTAssertNil(enumeration[kSecAttrAccount as String])
        let deletion = try XCTUnwrap(client.deletions.last)
        XCTAssertEqual(deletion[kSecAttrService as String] as? String, "dev.automobile.prototype.a")
        XCTAssertNil(deletion[kSecAttrAccount as String])
    }

    func testNotFoundIsAbsentAndDeletesSucceed() throws {
        let store = KeychainPrototypeSecureValueStore(client: FakeKeychainClient())
        let result = try store.readAll(id: "a")
        XCTAssertTrue(result.entries.isEmpty)
        XCTAssertTrue(result.invalidated.isEmpty)
        XCTAssertNoThrow(try store.delete(id: "a", key: "state:token"))
        XCTAssertEqual(try store.deleteAll(id: "a"), 0)
    }

    func testMalformedPresentDataIsInvalidated() throws {
        let client = FakeKeychainClient()
        client.items["dev.automobile.prototype.a"] = [
            "state:token": [kSecAttrAccount as String: "state:token", kSecValueData as String: Data("bad".utf8)],
        ]
        let result = try KeychainPrototypeSecureValueStore(client: client).readAll(id: "a")
        XCTAssertTrue(result.entries.isEmpty)
        XCTAssertEqual(result.invalidated, ["state:token"])
    }

    func testUnreadablePresentItemIsInvalidatedExceptTemporarySecurityFailures() throws {
        let client = FakeKeychainClient()
        client.items["dev.automobile.prototype.a"] = ["state:token": [kSecAttrAccount as String: "state:token"]]
        let store = KeychainPrototypeSecureValueStore(client: client)
        client.accountStatus = errSecInternalComponent
        XCTAssertEqual(try store.readAll(id: "a").invalidated, ["state:token"])
        for status in [errSecAuthFailed, errSecDecode, errSecInteractionNotAllowed] {
            client.accountStatus = status
            XCTAssertThrowsError(try store.readAll(id: "a"))
        }
        client.accountStatus = errSecItemNotFound
        let result = try store.readAll(id: "a")
        XCTAssertTrue(result.entries.isEmpty)
        XCTAssertTrue(result.invalidated.isEmpty)
    }

    func testFailedEnumerationPreservesUnknownAccounts() {
        let client = FakeKeychainClient()
        let store = KeychainPrototypeSecureValueStore(client: client)
        client.readStatus = errSecInteractionNotAllowed
        XCTAssertThrowsError(try store.readAll(id: "a"))
        XCTAssertEqual(client.queries.count, 1)
    }

    func testMissingEntitlementPreservesNumericStatusForLogging() {
        let client = FakeKeychainClient()
        client.readStatus = errSecMissingEntitlement
        XCTAssertThrowsError(try KeychainPrototypeSecureValueStore(client: client).readAll(id: "a")) { error in
            let failure = error as NSError
            XCTAssertEqual(failure.domain, NSOSStatusErrorDomain)
            XCTAssertEqual(failure.code, -34018)
            XCTAssertTrue(failure.userInfo.isEmpty)
        }
    }
}
