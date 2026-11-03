@testable import AutoMobilePrototypeAgentCore
import XCTest

private let secureStorage =
    #"{"version":1,"keys":["state:count"],"secure":["state:token","state:pin"],"secureAuth":{"state:pin":"biometric"}}"#

private func makeSecureSpec(storage: String? = secureStorage, pin: String = "") throws -> PrototypeSpec {
    let storageField = storage.map { #","storage":\#($0)"# } ?? ""
    let requires = storage?.contains("secure") == true
        ? #","requires":{"platform":["secureStorage","biometric"]}"# : ""
    let json = #"{"id":"vault","window":{"placement":{"type":"fullscreen"}},"#
        + #""state":{"token":"","pin":"\#(pin)","count":0}\#(requires)\#(storageField),"#
        + #""root":{"type":"text","text":"x"}}"#
    return try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
}

/// The secure-key restore rule (#14321, #16563), mirroring the `secure key restore (#14321)` block of
/// `test/features/prototype/prototypeStorage.test.ts`. Secure keys iterate sorted, so drops list in
/// key order rather than the host's insertion order.
final class PrototypeStorageSecureRestoreTests: XCTestCase {
    private func secure(
        _ values: [String: JSONValue], invalidated: [String]? = nil
    ) -> PrototypeStoredValues {
        PrototypeStoredValues(version: 1, values: [:], secure: values, invalidated: invalidated)
    }

    func testASecureValueRestoresIntoItsStringStateKey() throws {
        let result = try PrototypeStorageRestore.restore(
            spec: makeSecureSpec(), stored: secure(["state:token": .string("abc")])
        )
        XCTAssertEqual(result.state["token"], .string("abc"))
        XCTAssertEqual(result.applied, ["state:token"])
        XCTAssertEqual(result.dropped, [])
        XCTAssertEqual(result.locked, [])
    }

    func testABiometricBoundValueStaysLockedAndItsStateHoldsAnEmptyString() throws {
        let result = try PrototypeStorageRestore.restore(
            spec: makeSecureSpec(pin: "authored"), stored: secure(["state:pin": .string("1234")])
        )
        XCTAssertEqual(result.state["pin"], .string(""))
        XCTAssertEqual(result.locked, ["state:pin"])
        XCTAssertEqual(result.applied, [])
    }

    func testASealedBiometricValueIsLockedWithoutReadingItsContent() throws {
        let result = try PrototypeStorageRestore.restore(
            spec: makeSecureSpec(), stored: secure(["state:pin": .null])
        )
        XCTAssertEqual(result.locked, ["state:pin"])
        XCTAssertEqual(result.dropped, [])
    }

    func testABiometricKeyWithNoStoredValueIsNotLocked() throws {
        let result = try PrototypeStorageRestore.restore(spec: makeSecureSpec(), stored: secure([:]))
        XCTAssertEqual(result.locked, [])
        XCTAssertEqual(result.state["pin"], .string(""))
    }

    func testAnInvalidatedKeyDropsItsValueAndTheSpecsValueStands() throws {
        let result = try PrototypeStorageRestore.restore(
            spec: makeSecureSpec(pin: "authored"),
            stored: secure(["state:pin": .null], invalidated: ["state:pin"])
        )
        XCTAssertEqual(result.state["pin"], .string("authored"))
        XCTAssertEqual(result.locked, [])
        XCTAssertEqual(result.dropped, [.init(key: "state:pin", reason: .invalidated)])
    }

    func testAChangedVersionAnUnlistedKeyOrNoStorageBlockDropsSecureValues() throws {
        let authored = try makeSecureSpec(storage: secureStorage.replacingOccurrences(
            of: #""version":1"#, with: #""version":2"#
        ))
        let changed = PrototypeStorageRestore.restore(
            spec: authored, stored: secure(["state:token": .string("abc"), "state:pin": .null])
        )
        XCTAssertEqual(changed.state, authored.state)
        XCTAssertEqual(changed.locked, [])
        XCTAssertEqual(changed.dropped, [
            .init(key: "state:pin", reason: .version), .init(key: "state:token", reason: .version),
        ])
        let unlisted = try PrototypeStorageRestore.restore(
            spec: makeSecureSpec(storage: #"{"version":1,"keys":["state:count"]}"#),
            stored: secure(["state:token": .string("abc")])
        )
        XCTAssertEqual(unlisted.dropped, [.init(key: "state:token", reason: .unlisted)])
        let noBlock = try PrototypeStorageRestore.restore(
            spec: makeSecureSpec(storage: nil), stored: secure(["state:token": .string("abc")])
        )
        XCTAssertEqual(noBlock.state["token"], .string(""))
        XCTAssertEqual(noBlock.dropped, [.init(key: "state:token", reason: .unlisted)])
    }

    func testAValueThatIsNotAStringIsTooLargeOrFillsANonStringKeyIsAMismatch() throws {
        let spec = try makeSecureSpec()
        let notString = PrototypeStorageRestore.restore(spec: spec, stored: secure(["state:token": .number(42)]))
        XCTAssertEqual(notString.state, spec.state)
        XCTAssertEqual(notString.dropped, [.init(key: "state:token", reason: .mismatch)])
        // A non-string key cannot be listed in storage.secure here: the spec decoder runs the secure
        // storage rules and refuses it, so the restorer's own check is never reached on iOS.
        XCTAssertThrowsError(try makeSecureSpec(
            storage: #"{"version":1,"keys":["state:count"],"secure":["state:token","state:count"]}"#
        ))
        let atLimit = String(repeating: "é", count: PrototypeStorageRestore.maxSecureValueBytes / 2)
        let fits = PrototypeStorageRestore.restore(spec: spec, stored: secure(["state:token": .string(atLimit)]))
        XCTAssertEqual(fits.applied, ["state:token"])
        let over = PrototypeStorageRestore.restore(
            spec: spec, stored: secure(["state:token": .string(atLimit + "a")])
        )
        XCTAssertEqual(over.dropped, [.init(key: "state:token", reason: .mismatch)])
        XCTAssertEqual(PrototypeStorageRestore.maxSecureValueBytes, 4096)
    }

    func testAPlaintextStoredCopyOfASecureKeyNeverRestoresIntoIt() throws {
        let result = try PrototypeStorageRestore.restore(
            spec: makeSecureSpec(),
            stored: PrototypeStoredValues(version: 1, values: ["state:token": .string("leaked")])
        )
        XCTAssertEqual(result.state["token"], .string(""))
        XCTAssertEqual(result.dropped, [.init(key: "state:token", reason: .unlisted)])
    }

    func testSecureValuesAreNeverEncodedIntoThePlaintextFile() throws {
        let stored = PrototypeStoredValues(
            version: 1, values: ["state:name": .string("a")], secure: ["state:token": .string("abc")],
            invalidated: ["state:pin"]
        )
        let json = try String(decoding: JSONEncoder().encode(stored), as: UTF8.self)
        XCTAssertFalse(json.contains("abc"))
        XCTAssertFalse(json.contains("state:pin"))
        let decoded = try JSONDecoder().decode(PrototypeStoredValues.self, from: Data(json.utf8))
        XCTAssertEqual(decoded, PrototypeStoredValues(version: 1, values: ["state:name": .string("a")]))
    }
}
