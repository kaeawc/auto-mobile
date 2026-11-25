@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeSecureStorageTests: XCTestCase {
    private func coordinator(
        _ secure: FakeSecureValueStore?, clock: SecureStorageClock = SecureStorageClock(), maxBytes: Int = 1000
    )
        -> PrototypeStorageCoordinator
    {
        PrototypeStorageCoordinator(
            store: PlainStore(),
            clock: clock,
            maxBytes: maxBytes,
            secure: secure,
            log: { _ in }
        )
    }

    private func changed(
        _ coordinator: PrototypeStorageCoordinator, spec: PrototypeSpec, token: String = "tok-test-1"
    )
        -> PrototypeSession
    {
        let prepared = coordinator.prepare(spec)
        var session = PrototypeSession()
        session.show(prepared.spec, restoredState: prepared.state)
        _ = session.setStates([("token", .string(token)), ("pin", .string("pin-test")), ("count", .number(1))])
        coordinator.sessionChanged(session)
        return session
    }

    func testDebouncedSecureWriteRestoresAcrossCoordinatorsOutsidePlaintextBudget() throws {
        let secure = FakeSecureValueStore()
        let clock = SecureStorageClock()
        let first = coordinator(secure, clock: clock, maxBytes: 0)
        _ = try changed(first, spec: secureRuntimeSpec())
        XCTAssertTrue(secure.writes.isEmpty)
        clock.elapse()
        let prepared = try coordinator(secure).prepare(secureRuntimeSpec())
        XCTAssertEqual(prepared.state["token"], .string("tok-test-1"))
        XCTAssertTrue(prepared.applied.contains("state:token"))
        XCTAssertEqual(first.report(id: "vault")?.totalBytes, 0)
    }

    func testSecureValueNeverAppearsInPlaintextFile() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FilePrototypeStorageStore(directory: directory)
        let first = PrototypeStorageCoordinator(
            store: store,
            clock: SecureStorageClock(),
            secure: FakeSecureValueStore()
        )
        _ = try changed(first, spec: secureRuntimeSpec())
        first.flush()
        let text = try String(contentsOf: store.fileURL(for: "vault"), encoding: .utf8)
        XCTAssertFalse(text.contains("tok-test-1"))
        XCTAssertFalse(text.contains("pin-test"))
        XCTAssertFalse(text.contains("state:token"))
        XCTAssertEqual(try store.load(id: "vault")?.values, ["state:count": .number(1)])
    }

    func testClearRemovesAndCountsBothStoresAndDiscardsPendingWrites() throws {
        let secure = FakeSecureValueStore()
        let first = coordinator(secure)
        var session = try changed(first, spec: secureRuntimeSpec())
        first.flush()
        _ = session.setStates([("token", .string("pending-test"))])
        first.sessionChanged(session)
        XCTAssertEqual(try first.clear(id: "vault"), 3)
        first.flush()
        XCTAssertNil(secure.records["vault"])
        XCTAssertEqual(first.report(id: "vault")?.secure.map(\.present), [false, false])
    }

    func testInvalidatedValueIsDroppedAndDeleted() throws {
        let secure = FakeSecureValueStore()
        secure.invalidated["vault"] = ["state:token"]
        let result = try coordinator(secure).prepare(secureRuntimeSpec())
        XCTAssertEqual(result.state["token"], .string("authored"))
        XCTAssertEqual(result.dropped, [.init(key: "state:token", reason: .invalidated)])
        XCTAssertEqual(secure.deletes, ["state:token"])
    }

    func testVersionChangeDropsAndDeletesSecureEntriesWithoutAPlaintextRecord() throws {
        let secure = FakeSecureValueStore()
        secure.records["vault"] = ["state:token": .init(version: 1, value: "tok-test-1")]
        let result = try coordinator(secure).prepare(secureRuntimeSpec(version: 2))
        XCTAssertEqual(result.state["token"], .string("authored"))
        XCTAssertEqual(result.dropped, [.init(key: "state:token", reason: .version)])
        XCTAssertEqual(secure.deletes, ["state:token"])
    }

    func testUnlistedAndOversizedRestoredValuesAreDeleted() throws {
        let secure = FakeSecureValueStore()
        secure.records["vault"] = [
            "state:gone": .init(version: 1, value: "tok-test-1"),
            "state:token": .init(version: 1, value: String(repeating: "x", count: 4097)),
        ]
        let result = try coordinator(secure).prepare(secureRuntimeSpec())
        XCTAssertEqual(result.dropped, [
            .init(key: "state:gone", reason: .unlisted), .init(key: "state:token", reason: .mismatch),
        ])
        XCTAssertEqual(Set(secure.deletes), ["state:gone", "state:token"])
    }

    func testOverFourKiBUTF8IsSkippedButBoundaryIsStored() throws {
        let secure = FakeSecureValueStore()
        let first = coordinator(secure)
        var session = try changed(first, spec: secureRuntimeSpec(), token: String(repeating: "é", count: 2049))
        first.flush()
        XCTAssertNil(secure.records["vault"]?["state:token"])
        XCTAssertEqual(first.report(id: "vault")?.skippedKeys, ["state:token"])
        _ = session.setStates([("token", .string(String(repeating: "é", count: 2048)))])
        first.sessionChanged(session)
        first.flush()
        XCTAssertEqual(secure.records["vault"]?["state:token"]?.value.utf8.count, 4096)
    }

    func testBiometricKeysAreLiveOnlyAndExistingEntriesAreRemoved() throws {
        let secure = FakeSecureValueStore()
        secure.records["vault"] = ["state:pin": .init(version: 1, value: "old-test")]
        let first = coordinator(secure)
        let session = try changed(first, spec: secureRuntimeSpec(biometric: true))
        first.flush()
        XCTAssertEqual(session.state["pin"], .string("pin-test"))
        XCTAssertNil(secure.records["vault"]?["state:pin"])
        XCTAssertFalse(secure.writes.contains("state:pin"))
    }

    func testNilStoreKeepsSecureKeysLiveOnly() throws {
        let first = coordinator(nil)
        let session = try changed(first, spec: secureRuntimeSpec())
        first.flush()
        XCTAssertEqual(session.state["token"], .string("tok-test-1"))
        XCTAssertEqual(first.report(id: "vault")?.secure.map(\.present), [false, false])
        XCTAssertEqual(try coordinator(nil).prepare(secureRuntimeSpec()).state["token"], .string("authored"))
    }

    func testFailedSecureFlushRetriesAcrossSameIdShow() throws {
        let secure = FakeSecureValueStore()
        secure.writeFailure = true
        let first = coordinator(secure)
        _ = try changed(first, spec: secureRuntimeSpec())
        first.flush()
        let result = try first.prepare(secureRuntimeSpec())
        XCTAssertEqual(result.state["token"], .string("tok-test-1"))
        secure.writeFailure = false
        first.flush()
        XCTAssertEqual(secure.records["vault"]?["state:token"]?.value, "tok-test-1")
    }

    func testReportContainsOnlyPresenceAndUTF8Bytes() throws {
        let secure = FakeSecureValueStore()
        let first = coordinator(secure)
        _ = try changed(first, spec: secureRuntimeSpec(), token: "é")
        first.flush()
        let wire = try XCTUnwrap(first.report(id: "vault")).wireObject
        let rows = try XCTUnwrap(wire["secure"] as? [[String: Any]])
        XCTAssertEqual(rows[0]["key"] as? String, "state:token")
        XCTAssertEqual(rows[0]["present"] as? Bool, true)
        XCTAssertEqual(rows[0]["bytes"] as? Int, 2)
        XCTAssertNil(rows[0]["value"])
        XCTAssertEqual(Set(rows[0].keys), ["key", "present", "bytes"])
    }

    func testSecureCopySurvivesRemovalOfLegacyPlaintextCopy() throws {
        let secure = FakeSecureValueStore()
        secure.records["vault"] = ["state:token": .init(version: 1, value: "tok-test-secure")]
        let plain = PlainStore()
        plain.records["vault"] = PrototypeStoredValues(version: 1, values: ["state:token": .string("tok-test-plain")])
        let first = PrototypeStorageCoordinator(store: plain, clock: SecureStorageClock(), secure: secure)
        let result = try first.prepare(secureRuntimeSpec())
        XCTAssertEqual(result.state["token"], .string("tok-test-secure"))
        XCTAssertEqual(result.dropped, [.init(key: "state:token", reason: .unlisted)])
        XCTAssertNil(plain.records["vault"])
        XCTAssertTrue(secure.deletes.isEmpty)
    }

    func testFormerSecureKeyNowListedInPlaintextRemovesTheOldSecureItem() throws {
        let spec = try JSONDecoder().decode(
            PrototypeSpec.self,
            from: Data(
                #"{"id":"vault","window":{"placement":{"type":"fullscreen"}},"state":{"token":"authored"},"storage":{"version":1,"keys":["state:token"]},"root":{"type":"text","text":"plain"}}"#
                    .utf8
            )
        )
        let secure = FakeSecureValueStore()
        secure.records["vault"] = ["state:token": .init(version: 1, value: "tok-test-secure")]
        let plain = PlainStore()
        plain.records["vault"] = PrototypeStoredValues(version: 1, values: ["state:token": .string("plain-test")])
        let first = PrototypeStorageCoordinator(store: plain, clock: SecureStorageClock(), secure: secure)
        let result = first.prepare(spec)
        XCTAssertEqual(result.state["token"], .string("plain-test"))
        XCTAssertEqual(result.dropped, [.init(key: "state:token", reason: .unlisted)])
        XCTAssertEqual(secure.deletes, ["state:token"])
        XCTAssertEqual(plain.records["vault"]?.values["state:token"], .string("plain-test"))
    }

    func testSecureEntryVersionIsIndependentOfStalePlaintextRecord() throws {
        let secure = FakeSecureValueStore()
        secure.records["vault"] = ["state:token": .init(version: 2, value: "tok-test-2")]
        let plain = PlainStore()
        plain.records["vault"] = PrototypeStoredValues(version: 1, values: ["state:count": .number(8)])
        let first = PrototypeStorageCoordinator(store: plain, clock: SecureStorageClock(), secure: secure)
        let result = try first.prepare(secureRuntimeSpec(version: 2))
        XCTAssertEqual(result.state["token"], .string("tok-test-2"))
        XCTAssertEqual(result.state["count"], .number(0))
        XCTAssertEqual(result.dropped, [.init(key: "state:count", reason: .version)])
        XCTAssertTrue(secure.deletes.isEmpty)
        XCTAssertNil(plain.records["vault"])
    }

    func testStateOnlyRestoreRetryRetainsSecureValuesAndInvalidation() throws {
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: Data(#"""
        {"id":"vault","window":{"placement":{"type":"fullscreen"}},
         "requires":{"platform":["secureStorage"]},"state":{"token":"authored","pin":""},
         "data":{"rows":[{"n":1},{"n":2}]},
         "storage":{"version":1,"keys":["data:/rows"],"secure":["state:token","state:pin"]},
         "root":{"type":"column","repeat":{"as":"item","items":{"path":"/rows"},"key":"shown","derive":{
          "shown":{"of":{"item":"n"},"format":{"number":{}},"locale":"en-US"}}},
          "children":[{"type":"text","text":"{item.shown}"}]}}
        """#.utf8))
        let storedRows = JSONValue.array([
            .object(["n": .number(1)]), .object(["n": .number(1)]),
        ])
        XCTAssertThrowsError(try spec.replacingData(["rows": storedRows])) { error in
            XCTAssertEqual(error as? PrototypeLoadError, .invalidSpec(
                path: "root.repeat.key",
                message: #"Duplicate repeat key "1" (items 0 and 1)"#
            ))
        }
        let secure = FakeSecureValueStore()
        secure.records["vault"] = ["state:token": .init(version: 1, value: "tok-test-1")]
        secure.invalidated["vault"] = ["state:pin"]
        let plain = PlainStore()
        plain.records["vault"] = PrototypeStoredValues(version: 1, values: [
            "data:/rows": storedRows,
        ])
        let first = PrototypeStorageCoordinator(
            store: plain,
            clock: SecureStorageClock(),
            secure: secure,
            log: { _ in }
        )
        let result = first.prepare(spec)
        XCTAssertEqual(result.state["token"], .string("tok-test-1"))
        XCTAssertEqual(result.spec.data, spec.data)
        XCTAssertTrue(result.applied.contains("state:token"))
        XCTAssertTrue(result.dropped.contains(.init(key: "data:/rows", reason: .mismatch)))
        XCTAssertTrue(result.dropped.contains(.init(key: "state:pin", reason: .invalidated)))
        XCTAssertEqual(secure.deletes, ["state:pin"])
    }

    func testNoSecureMetadataWhenSpecDoesNotListSecureKeys() throws {
        let spec = try JSONDecoder().decode(
            PrototypeSpec.self,
            from: Data(
                #"{"id":"plain","window":{"placement":{"type":"fullscreen"}},"storage":{"version":1,"keys":[]},"root":{"type":"text","text":"plain"}}"#
                    .utf8
            )
        )
        let first = coordinator(FakeSecureValueStore())
        _ = first.prepare(spec)
        let report = try XCTUnwrap(first.report(id: "plain"))
        XCTAssertNil(report.wireObject["secure"])
    }

    func testPlaintextWriteFailureDoesNotPreventSecureFlushOrRestore() throws {
        let secure = FakeSecureValueStore()
        let plain = PlainStore()
        plain.writeFailure = true
        let first = PrototypeStorageCoordinator(
            store: plain,
            clock: SecureStorageClock(),
            secure: secure,
            log: { _ in }
        )
        _ = try changed(first, spec: secureRuntimeSpec())
        first.flush()
        let result = try first.prepare(secureRuntimeSpec())
        XCTAssertEqual(result.state["token"], .string("tok-test-1"))
        XCTAssertEqual(result.state["count"], .number(1))
        XCTAssertEqual(first.report(id: "vault")?.secure.first?.present, true)
        plain.writeFailure = false
        first.flush()
        XCTAssertEqual(plain.records["vault"]?.values, ["state:count": .number(1)])
    }

    func testInvalidationsAreScopedByPrototypeId() throws {
        let secure = FakeSecureValueStore()
        secure.records["vault"] = ["state:token": .init(version: 1, value: "tok-test-1")]
        secure.invalidated["other"] = ["state:token"]
        let first = coordinator(secure)
        let result = try first.prepare(secureRuntimeSpec())
        XCTAssertEqual(result.state["token"], .string("tok-test-1"))
        XCTAssertTrue(result.dropped.isEmpty)
        XCTAssertEqual(try first.clear(id: "vault"), 1)
        XCTAssertEqual(try secure.readAll(id: "other").invalidated, ["state:token"])
    }

    func testFailedSecureDeleteStaysPendingAcrossSameIdShow() throws {
        let secure = FakeSecureValueStore()
        let first = coordinator(secure)
        var session = try changed(first, spec: secureRuntimeSpec())
        first.flush()
        let ops = JSONValue.array([.object(["op": .string("remove"), "path": .string("/state/token")])])
        XCTAssertTrue(session.patch(id: "vault", baseRevision: session.dataRevision, ops: ops).0.reply.success)
        first.sessionChanged(session)
        secure.deleteFailure = true
        first.flush()
        let result = try first.prepare(secureRuntimeSpec())
        XCTAssertEqual(result.state["token"], .string("authored"))
        XCTAssertFalse(result.applied.contains("state:token"))
        secure.deleteFailure = false
        first.flush()
        XCTAssertNil(secure.records["vault"]?["state:token"])
        XCTAssertEqual(try coordinator(secure).prepare(secureRuntimeSpec()).state["token"], .string("authored"))
    }

    func testFailedVersionCleanupIsRetriedBeforeTheOldVersionCanRestore() throws {
        let secure = FakeSecureValueStore()
        secure.records["vault"] = ["state:token": .init(version: 1, value: "tok-test-1")]
        secure.deleteFailure = true
        let first = coordinator(secure)
        XCTAssertEqual(try first.prepare(secureRuntimeSpec(version: 2)).state["token"], .string("authored"))
        XCTAssertNotNil(secure.records["vault"]?["state:token"])
        secure.deleteFailure = false
        let result = try first.prepare(secureRuntimeSpec(version: 1))
        XCTAssertEqual(result.state["token"], .string("authored"))
        XCTAssertFalse(result.applied.contains("state:token"))
        XCTAssertNil(secure.records["vault"]?["state:token"])
    }

    func testFailedCleanupRetryKeepsANewerItemUnderTheSameKey() throws {
        let secure = FakeSecureValueStore()
        secure.records["vault"] = ["state:token": .init(version: 1, value: "tok-test-1")]
        secure.deleteFailure = true
        let first = coordinator(secure)
        _ = try first.prepare(secureRuntimeSpec(version: 2))
        secure.deleteFailure = false
        // Another presentation sharing the store writes a version 2 item under the same key.
        let other = coordinator(secure)
        _ = try changed(other, spec: secureRuntimeSpec(version: 2), token: "tok-test-2")
        other.flush()
        let result = try first.prepare(secureRuntimeSpec(version: 2))
        XCTAssertEqual(result.state["token"], .string("tok-test-2"))
        XCTAssertEqual(secure.records["vault"]?["state:token"], PrototypeSecureEntry(version: 2, value: "tok-test-2"))
    }

    func testPendingSecureValueIsNotLaidOverAKeyTheReplacementMadeBiometric() throws {
        let secure = FakeSecureValueStore()
        secure.writeFailure = true
        let first = coordinator(secure)
        _ = try changed(first, spec: secureRuntimeSpec())
        first.flush()
        let result = try first.prepare(secureRuntimeSpec(biometric: true))
        XCTAssertTrue(result.locked.isEmpty)
        XCTAssertEqual(result.state["pin"], .string(""))
        XCTAssertEqual(result.state["token"], .string("tok-test-1"))
        secure.writeFailure = false
        first.flush()
        XCTAssertEqual(secure.records["vault"]?["state:token"]?.value, "tok-test-1")
        XCTAssertNil(secure.records["vault"]?["state:pin"])
    }

    func testCanonicallyEquivalentSecureRespellingIsStoredByExactBytes() throws {
        let secure = FakeSecureValueStore()
        let first = coordinator(secure)
        var session = try changed(first, spec: secureRuntimeSpec(), token: "\u{E9}")
        first.flush()
        let decomposed = "e\u{301}"
        let ops = JSONValue.array([.object([
            "op": .string("replace"), "path": .string("/state/token"), "value": .string(decomposed),
        ])])
        XCTAssertTrue(session.patch(id: "vault", baseRevision: session.dataRevision, ops: ops).0.reply.success)
        first.sessionChanged(session)
        // The failed write must survive a same-id show even though the Keychain holds an equal string.
        secure.writeFailure = true
        first.flush()
        _ = try first.prepare(secureRuntimeSpec())
        secure.writeFailure = false
        first.flush()
        let stored = try XCTUnwrap(secure.records["vault"]?["state:token"]?.value)
        XCTAssertEqual(Array(stored.utf8), Array(decomposed.utf8))
    }

    func testFailedSecureClearDoesNotWriteBackClearedPlaintext() throws {
        let secure = FakeSecureValueStore()
        let plain = PlainStore()
        let first = PrototypeStorageCoordinator(
            store: plain,
            clock: SecureStorageClock(),
            secure: secure,
            log: { _ in }
        )
        var session = try changed(first, spec: secureRuntimeSpec())
        first.flush()
        _ = session.setStates([("count", .number(2))])
        first.sessionChanged(session)
        secure.deleteAllFailure = true
        XCTAssertThrowsError(try first.clear(id: "vault"))
        first.flush()
        XCTAssertNil(plain.records["vault"])
        XCTAssertTrue(try XCTUnwrap(first.report(id: "vault")).keys.isEmpty)
    }

    func testUnreadableKeychainOmitsTheSecureReport() throws {
        let secure = FakeSecureValueStore()
        secure.records["vault"] = ["state:token": .init(version: 1, value: "tok-test-1")]
        secure.readFailure = true
        let first = coordinator(secure)
        _ = try first.prepare(secureRuntimeSpec())
        let report = try XCTUnwrap(first.report(id: "vault"))
        XCTAssertTrue(report.secure.isEmpty)
        XCTAssertNil(report.wireObject["secure"])
        secure.readFailure = false
        _ = try first.prepare(secureRuntimeSpec())
        XCTAssertEqual(first.report(id: "vault")?.secure.map(\.present), [true, false])
    }

    func testFailedSecureWriteRetriesOnTheClockWithoutAnotherChange() throws {
        let secure = FakeSecureValueStore()
        secure.writeFailure = true
        let clock = SecureStorageClock()
        let first = coordinator(secure, clock: clock)
        _ = try changed(first, spec: secureRuntimeSpec())
        first.flush()
        clock.elapse()
        XCTAssertNil(secure.records["vault"])
        secure.writeFailure = false
        clock.elapse()
        XCTAssertEqual(secure.records["vault"]?["state:token"]?.value, "tok-test-1")
        XCTAssertEqual(clock.delays, [400, 1000, 2000])
        XCTAssertTrue(clock.timers.allSatisfy(\.cancelled))
    }

    private final class PlainStore: PrototypeStorageStore {
        var records: [String: PrototypeStoredValues] = [:]
        var writeFailure = false
        func load(id: String) throws -> PrototypeStoredValues? { records[id] }
        func save(_ stored: PrototypeStoredValues, id: String) throws {
            if writeFailure { throw FakeSecureValueStore.Failure() }
            records[id] = stored
        }

        func delete(id: String) throws { records[id] = nil }
    }
}
