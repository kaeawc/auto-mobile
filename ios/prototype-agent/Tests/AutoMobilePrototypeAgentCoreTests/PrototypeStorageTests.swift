@testable import AutoMobilePrototypeAgentCore
import XCTest

private final class StorageTimer: PrototypeTimerHandle {
    let delay: Int
    let fire: () -> Void
    private(set) var cancelled = false
    init(delay: Int, fire: @escaping () -> Void) {
        self.delay = delay
        self.fire = fire
    }

    func cancel() { cancelled = true }

    func run() {
        guard !cancelled else { return }
        cancelled = true
        fire()
    }
}

private final class StorageClock: PrototypeClock {
    private(set) var timers: [StorageTimer] = []

    func schedule(afterMilliseconds: Int, _ fire: @escaping () -> Void) -> PrototypeTimerHandle {
        let timer = StorageTimer(delay: afterMilliseconds, fire: fire)
        timers.append(timer)
        return timer
    }

    var live: [StorageTimer] { timers.filter { !$0.cancelled } }

    func elapse() { live.forEach { $0.run() } }
}

private struct FakeStoreFailure: Error {}

private final class FakeStore: PrototypeStorageStore {
    var records: [String: PrototypeStoredValues] = [:]
    var loadError: Error?
    var saveError: Error?
    private(set) var saves = 0
    private(set) var deletes: [String] = []

    func load(id: String) throws -> PrototypeStoredValues? {
        if let loadError { throw loadError }
        return records[id]
    }

    func save(_ stored: PrototypeStoredValues, id: String) throws {
        if let saveError { throw saveError }
        saves += 1
        records[id] = stored
    }

    func delete(id: String) throws {
        deletes.append(id)
        records[id] = nil
    }
}

/// The model's wiring without UIKit: prepare before the show, observe after every transition.
private final class StorageHarness {
    let store = FakeStore()
    let clock = StorageClock()
    var logs: [String] = []
    var session = PrototypeSession()
    var events: [PrototypeEvent] = []
    private(set) var lastPreparation: PrototypeStoragePreparation?
    private let maxBytes: Int
    lazy var coordinator = PrototypeStorageCoordinator(
        store: store, clock: clock, maxBytes: maxBytes, log: { [unowned self] in logs.append($0) }
    )

    init(maxBytes: Int = PrototypeLimits.maxStorageBytes) {
        self.maxBytes = maxBytes
    }

    func show(_ spec: PrototypeSpec, reset: Bool = false) {
        let prepared = coordinator.prepare(spec)
        lastPreparation = prepared
        session.show(prepared.spec, reset: reset, restoredState: prepared.state)
        coordinator.sessionChanged(session)
    }

    func tap(_ label: String) throws {
        let root = try XCTUnwrap(session.spec?.root)
        let actions = try XCTUnwrap(button(root, label)?.onTap, label)
        events += session.transition { $0.run(actions) }
        coordinator.sessionChanged(session)
    }

    func dismiss() {
        events += session.dismiss(reason: .agent)
        coordinator.sessionChanged(session)
    }

    private func button(_ node: PrototypeNode, _ label: String) -> PrototypeNode? {
        if node.type == "button", node.label == label { return node }
        return (node.children ?? []).lazy.compactMap { self.button($0, label) }.first
    }
}

private func makeSpec(
    id: String = "shop",
    version: Int? = 1,
    keys: [String] = ["state:dark", "state:count", "data:/cart", "data:/note"],
    state: String = #"{"dark":false,"count":1,"name":"a"}"#,
    data: String = #"{"cart":{"items":[]},"note":"hi"}"#
)
    throws -> PrototypeSpec
{
    let listed = keys.map { "\"\($0)\"" }.joined(separator: ",")
    let storage = version.map { version in
        "\"storage\":{\"version\":\(version),\"keys\":[\(listed)]},"
    } ?? ""
    let json = """
    {"id":"\(id)","window":{"placement":{"type":"fullscreen"}},"state":\(state),"data":\(data),\(storage)
     "root":{"type":"column","children":[
       {"type":"text","text":"{data:/note}"},
       {"type":"button","label":"Dark","onTap":[{"type":"toggle","key":"dark"}]},
       {"type":"button","label":"Bump","onTap":[{"type":"increment","key":"count"}]},
       {"type":"button","label":"Add","onTap":[
         {"type":"appendData","path":"/data/cart/items","value":{"value":"x"}}]},
       {"type":"button","label":"Drop note","onTap":[{"type":"removeData","path":"/data/note"}]},
       {"type":"button","label":"Rename","onTap":[{"type":"setState","key":"name","value":"b"}]}]}}
    """
    return try JSONDecoder().decode(PrototypeSpec.self, from: Data(json.utf8))
}

private func object(_ json: String) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
}

final class PrototypeStorageTests: XCTestCase {
    // MARK: Contract

    func testLimitsMatchTheSharedContract() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let contract = try JSONSerialization.jsonObject(
            with: Data(contentsOf: root.appendingPathComponent("schemas/prototype-spec-contract.json"))
        ) as? [String: Any]
        let limits = try XCTUnwrap(contract?["limits"] as? [String: Int])
        XCTAssertEqual(PrototypeLimits.maxStorageBytes, limits["MAX_PROTOTYPE_STORAGE_BYTES"])
        XCTAssertEqual(PrototypeLimits.maxStorageKeys, limits["MAX_PROTOTYPE_STORAGE_KEYS"])
        XCTAssertEqual(PrototypeAgentProtocol.storageCapability, "prototype_storage_v1")
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains("prototype_storage_v1"))
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains("clear_prototype_storage"))
    }

    func testStorageKeysParseLikeTheHost() {
        XCTAssertEqual(PrototypeStorageKey.parse("state:darkMode"), .state("darkMode"))
        XCTAssertEqual(PrototypeStorageKey.parse("data:/cart/items"), .data(pointer: "/cart/items"))
        for bad in ["state:", "state:1a", "state:a-b", "data:", "data:cart", "name", "data:/a~2", ""] {
            XCTAssertNil(PrototypeStorageKey.parse(bad), bad)
        }
        XCTAssertNotNil(PrototypeStorageKey.parse("state:" + String(repeating: "a", count: 64)))
        XCTAssertNil(PrototypeStorageKey.parse("state:" + String(repeating: "a", count: 65)))
    }

    func testEntryBytesAreKeyPlusCompactJSON() throws {
        XCTAssertEqual(PrototypeStorageBytes.entry("state:a", .string("hi")), 7 + 4)
        let nested = try object(#"{"a":[1,true]}"#)
        XCTAssertEqual(PrototypeStorageBytes.entry("data:/c", nested), 7 + 14)
        XCTAssertEqual(PrototypeStorageBytes.entry("state:é", .bool(false)), 8 + 5)
    }

    func testSpecDecodesTheStorageBlockAndToleratesAMalformedOne() throws {
        XCTAssertEqual(try makeSpec().storage, PrototypeStorageBlock(version: 1, keys: [
            "state:dark", "state:count", "data:/cart", "data:/note",
        ]))
        XCTAssertNil(try makeSpec(version: nil).storage)
        let malformed = try JSONDecoder().decode(PrototypeSpec.self, from: Data("""
        {"id":"m","window":{"placement":{"type":"fullscreen"}},"storage":{"version":"x"},
         "root":{"type":"text","text":"hi"}}
        """.utf8))
        XCTAssertNil(malformed.storage)
    }

    // MARK: Precedence (the pure function)

    private func stored(_ version: Int, _ values: [String: JSONValue]) -> PrototypeStoredValues {
        PrototypeStoredValues(version: version, values: values)
    }

    func testStoredValuesReplaceTheSpecsForListedKeys() throws {
        let result = try PrototypeStorageRestore.restore(spec: makeSpec(), stored: stored(1, [
            "state:dark": .bool(true), "state:count": .number(7), "data:/note": .string("kept"),
            "data:/cart": object(#"{"items":["a"]}"#),
        ]))
        XCTAssertEqual(result.state["dark"], .bool(true))
        XCTAssertEqual(result.state["count"], .number(7))
        XCTAssertEqual(result.state["name"], .string("a"))
        XCTAssertEqual(result.data?["note"], .string("kept"))
        XCTAssertEqual(result.data?["cart"], try object(#"{"items":["a"]}"#))
        XCTAssertEqual(result.applied.sorted(), ["data:/cart", "data:/note", "state:count", "state:dark"])
        XCTAssertTrue(result.dropped.isEmpty)
    }

    func testAChangedVersionDiscardsEverything() throws {
        let result = try PrototypeStorageRestore.restore(spec: makeSpec(version: 2), stored: stored(1, [
            "state:dark": .bool(true), "data:/note": .string("kept"),
        ]))
        XCTAssertEqual(result.state["dark"], .bool(false))
        XCTAssertEqual(result.data?["note"], .string("hi"))
        XCTAssertTrue(result.applied.isEmpty)
        XCTAssertEqual(result.dropped.map(\.reason), [.version, .version])
    }

    func testUnlistedKeysAreDroppedAndAShowWithoutStorageDropsAll() throws {
        let values: [String: JSONValue] = ["state:dark": .bool(true), "state:name": .string("z")]
        let narrowed = try PrototypeStorageRestore.restore(
            spec: makeSpec(keys: ["state:dark"]), stored: stored(1, values)
        )
        XCTAssertEqual(narrowed.applied, ["state:dark"])
        XCTAssertEqual(narrowed.dropped, [.init(key: "state:name", reason: .unlisted)])
        let none = try PrototypeStorageRestore.restore(spec: makeSpec(version: nil), stored: stored(1, values))
        XCTAssertTrue(none.applied.isEmpty)
        XCTAssertEqual(none.dropped.map(\.reason), [.unlisted, .unlisted])
        XCTAssertEqual(none.state["dark"], .bool(false))
    }

    func testValuesThatNoLongerFitFallBackToTheSpec() throws {
        let spec = try makeSpec(keys: [
            "state:dark", "state:count", "state:gone", "data:/cart", "data:/note", "data:/orphan/deep",
        ])
        let result = PrototypeStorageRestore.restore(spec: spec, stored: stored(1, [
            "state:dark": .string("yes"), // type changed
            "state:count": .number(.infinity), // not finite
            "state:gone": .bool(true), // key no longer declared
            "data:/cart": .string("flat"), // object in the spec, string stored
            "data:/note": .number(3), // string in the spec
            "data:/orphan/deep": .string("x"), // the parent does not exist: the writer refuses it
        ]))
        XCTAssertEqual(result.state, spec.state)
        XCTAssertEqual(result.data, spec.data)
        XCTAssertTrue(result.applied.isEmpty)
        XCTAssertEqual(Set(result.dropped.map(\.key)).count, 6)
        XCTAssertTrue(result.dropped.allSatisfy { $0.reason == .mismatch })
    }

    func testADataValueAbsentFromTheSpecCanBeRestoredWhereTheWriterAllowsIt() throws {
        let spec = try makeSpec(keys: ["data:/extra"], data: #"{"cart":{}}"#)
        let result = PrototypeStorageRestore.restore(spec: spec, stored: stored(1, ["data:/extra": .number(4)]))
        XCTAssertEqual(result.data?["extra"], .number(4))
    }

    // MARK: Load on show

    func testStoredValuesAreLoadedOnShowWithNoEventAndNoRevision() throws {
        let harness = StorageHarness()
        harness.store.records["shop"] = stored(1, [
            "state:dark": .bool(true), "data:/note": .string("restored"),
        ])
        try harness.show(makeSpec())
        XCTAssertEqual(harness.session.state["dark"], .bool(true))
        XCTAssertEqual(harness.session.data?["note"], .string("restored"))
        XCTAssertEqual(harness.session.dataRevision, 0)
        XCTAssertEqual(harness.session.lastSequence, 0)
        XCTAssertTrue(harness.events.isEmpty)
        // The drawn tree follows the restored data, before the first draw.
        let text = harness.session.spec?.root.children?.first?.text
        XCTAssertEqual(text, "restored")
        // Restoring is not a change: nothing is scheduled or written.
        XCTAssertTrue(harness.clock.live.isEmpty)
        XCTAssertEqual(harness.store.saves, 0)
    }

    func testTheNextShowAfterADismissRestoresWhatWasStored() throws {
        let harness = StorageHarness()
        try harness.show(makeSpec())
        try harness.tap("Dark")
        try harness.tap("Bump")
        harness.dismiss()
        XCTAssertFalse(harness.session.isShown)
        try harness.show(makeSpec())
        XCTAssertEqual(harness.session.state["dark"], .bool(true))
        XCTAssertEqual(harness.session.state["count"], .number(2))
        XCTAssertEqual(harness.session.state["name"], .string("a"))
        // A reset restarts display, not storage.
        try harness.show(makeSpec(), reset: true)
        XCTAssertEqual(harness.session.state["dark"], .bool(true))
    }

    func testAVersionMismatchResetsToTheSpecAndDeletesTheRecord() throws {
        let harness = StorageHarness()
        harness.store.records["shop"] = stored(1, ["state:dark": .bool(true)])
        try harness.show(makeSpec(version: 2))
        XCTAssertEqual(harness.session.state["dark"], .bool(false))
        XCTAssertNil(harness.store.records["shop"])
        XCTAssertEqual(harness.lastPreparation?.dropped, [.init(key: "state:dark", reason: .version)])
        // The new version stores from here on.
        try harness.tap("Dark")
        harness.coordinator.flush()
        XCTAssertEqual(harness.store.records["shop"], stored(2, ["state:dark": .bool(true)]))
    }

    func testAShowWithoutStorageDeletesTheRecord() throws {
        let harness = StorageHarness()
        harness.store.records["shop"] = stored(1, ["state:dark": .bool(true)])
        try harness.show(makeSpec(version: nil))
        XCTAssertNil(harness.store.records["shop"])
        try harness.tap("Dark")
        XCTAssertTrue(harness.clock.live.isEmpty)
    }

    func testDroppedEntriesAreRewrittenWithoutThem() throws {
        let harness = StorageHarness()
        harness.store.records["shop"] = stored(1, ["state:dark": .bool(true), "state:count": .string("bad")])
        try harness.show(makeSpec())
        XCTAssertEqual(harness.store.records["shop"], stored(1, ["state:dark": .bool(true)]))
    }

    // MARK: Write back

    func testAWriteAfterADataActionIsDebouncedThenStored() throws {
        let harness = StorageHarness()
        try harness.show(makeSpec())
        try harness.tap("Add")
        XCTAssertEqual(harness.session.dataRevision, 1)
        XCTAssertEqual(harness.store.saves, 0, "nothing is written before the delay")
        XCTAssertEqual(harness.clock.live.count, 1)
        XCTAssertEqual(harness.clock.live.first?.delay, PrototypeStorageCoordinator.defaultDebounceMilliseconds)
        harness.clock.elapse()
        XCTAssertEqual(harness.store.saves, 1)
        XCTAssertEqual(harness.store.records["shop"], try stored(1, ["data:/cart": object(#"{"items":["x"]}"#)]))
    }

    func testEachChangeRestartsTheDelayAndOneWriteCarriesAll() throws {
        let harness = StorageHarness()
        try harness.show(makeSpec())
        try harness.tap("Dark")
        let first = harness.clock.live.first
        try harness.tap("Bump")
        XCTAssertEqual(first?.cancelled, true)
        XCTAssertEqual(harness.clock.live.count, 1)
        harness.clock.elapse()
        XCTAssertEqual(harness.store.saves, 1)
        XCTAssertEqual(harness.store.records["shop"], stored(1, ["state:dark": .bool(true), "state:count": .number(2)]))
        XCTAssertTrue(harness.clock.live.isEmpty)
    }

    func testOnlyListedKeysScheduleAWrite() throws {
        let harness = StorageHarness()
        try harness.show(makeSpec())
        try harness.tap("Rename")
        XCTAssertEqual(harness.session.state["name"], .string("b"))
        XCTAssertTrue(harness.clock.live.isEmpty)
        harness.coordinator.flush()
        XCTAssertEqual(harness.store.saves, 0)
    }

    func testDismissFlushesWithoutWaitingForTheDelay() throws {
        let harness = StorageHarness()
        try harness.show(makeSpec())
        try harness.tap("Dark")
        XCTAssertEqual(harness.store.saves, 0)
        harness.dismiss()
        XCTAssertEqual(harness.store.records["shop"], stored(1, ["state:dark": .bool(true)]))
        XCTAssertTrue(harness.clock.live.isEmpty)
    }

    func testShowingAnotherPrototypeFlushesThePreviousOne() throws {
        let harness = StorageHarness()
        try harness.show(makeSpec())
        try harness.tap("Dark")
        try harness.show(makeSpec(id: "other", version: nil))
        XCTAssertEqual(harness.store.records["shop"], stored(1, ["state:dark": .bool(true)]))
    }

    func testRemovingADataMemberDeletesItsStoredEntry() throws {
        let harness = StorageHarness()
        harness.store.records["shop"] = stored(1, ["data:/note": .string("kept"), "state:dark": .bool(true)])
        try harness.show(makeSpec())
        try harness.tap("Drop note")
        harness.clock.elapse()
        XCTAssertEqual(harness.store.records["shop"], stored(1, ["state:dark": .bool(true)]))
    }

    func testTheLastRemovedEntryDeletesTheRecord() throws {
        let harness = StorageHarness()
        harness.store.records["shop"] = stored(1, ["data:/note": .string("kept")])
        try harness.show(makeSpec())
        try harness.tap("Drop note")
        harness.clock.elapse()
        XCTAssertNil(harness.store.records["shop"])
    }

    func testAFailedWriteIsLoggedAndRetriedOnTheNextFlush() throws {
        let harness = StorageHarness()
        try harness.show(makeSpec())
        harness.store.saveError = FakeStoreFailure()
        try harness.tap("Dark")
        harness.clock.elapse()
        XCTAssertNil(harness.store.records["shop"])
        XCTAssertTrue(harness.logs.contains { $0.contains("could not store values for shop") })
        harness.store.saveError = nil
        harness.coordinator.flush()
        XCTAssertEqual(harness.store.records["shop"], stored(1, ["state:dark": .bool(true)]))
    }

    // MARK: Corrupt records

    func testACorruptRecordIsLoggedDroppedAndTheSpecStands() throws {
        let harness = StorageHarness()
        harness.store.loadError = PrototypeStorageError.corrupt("bad json")
        harness.store.records["shop"] = stored(1, ["state:dark": .bool(true)])
        try harness.show(makeSpec())
        XCTAssertEqual(harness.session.state["dark"], .bool(false))
        XCTAssertTrue(harness.logs.contains { $0.contains("ignoring unreadable stored values for shop") })
        XCTAssertEqual(harness.store.deletes, ["shop"])
        // The next write replaces the bad record.
        harness.store.loadError = nil
        try harness.tap("Dark")
        harness.coordinator.flush()
        XCTAssertEqual(harness.store.records["shop"], stored(1, ["state:dark": .bool(true)]))
    }

    // MARK: Over the limit

    func testAnOverLimitWriteAppliesLiveIsNotStoredAndIsReportedSkipped() throws {
        let kept = PrototypeStorageBytes.entry("state:dark", .bool(true))
        let harness = StorageHarness(maxBytes: kept + 20)
        try harness.show(makeSpec())
        try harness.tap("Dark")
        try harness.tap("Add")
        harness.clock.elapse()
        XCTAssertEqual(harness.session.dataRevision, 1, "the write applied on screen")
        XCTAssertEqual(harness.store.records["shop"], stored(1, ["state:dark": .bool(true)]))
        let report = try XCTUnwrap(harness.coordinator.report(id: "shop"))
        XCTAssertEqual(report.skippedKeys, ["data:/cart"])
        XCTAssertEqual(report.keys.map(\.key), ["state:dark"])
        XCTAssertEqual(report.totalBytes, kept)
    }

    func testASkippedKeyKeepsItsPreviousStoredValue() throws {
        let small = PrototypeStorageBytes.entry("data:/note", .string("hi"))
        let harness = StorageHarness(maxBytes: small + 4)
        harness.store.records["shop"] = stored(1, ["data:/note": .string("hi")])
        try harness.show(makeSpec())
        try harness.tap("Add") // data:/cart grows past the limit alongside the stored note
        harness.clock.elapse()
        XCTAssertEqual(harness.store.records["shop"], stored(1, ["data:/note": .string("hi")]))
        XCTAssertEqual(harness.coordinator.report(id: "shop")?.skippedKeys, ["data:/cart"])
    }

    // MARK: clearStorage and the status report

    func testClearStorageWipesTheValuesAndCountsThem() throws {
        let harness = StorageHarness()
        harness.store.records["shop"] = stored(1, ["state:dark": .bool(true), "state:count": .number(5)])
        try harness.show(makeSpec())
        try harness.tap("Bump")
        XCTAssertEqual(try harness.coordinator.clear(id: "shop"), 2)
        XCTAssertNil(harness.store.records["shop"])
        XCTAssertTrue(harness.clock.live.isEmpty, "a pending write is discarded")
        XCTAssertEqual(harness.session.state["count"], .number(6), "the shown prototype is untouched")
        XCTAssertEqual(harness.coordinator.report(id: "shop")?.keys.count, 0)
        // The next show starts from the spec.
        harness.dismiss()
        try harness.show(makeSpec())
        XCTAssertEqual(harness.session.state["dark"], .bool(false))
        XCTAssertEqual(harness.session.state["count"], .number(1))
    }

    func testClearStorageOfAnIdWithNothingStoredIsZero() throws {
        let harness = StorageHarness()
        XCTAssertEqual(try harness.coordinator.clear(id: "nothing"), 0)
    }

    func testClearStorageSurfacesAFailedDelete() {
        let harness = StorageHarness()
        let failing = FailingDeleteStore()
        let coordinator = PrototypeStorageCoordinator(store: failing, clock: harness.clock, log: { _ in })
        XCTAssertThrowsError(try coordinator.clear(id: "shop"))
    }

    func testTheReportListsStoredKeysWithBytesInSpecOrder() throws {
        let harness = StorageHarness()
        harness.store.records["shop"] = stored(1, ["data:/note": .string("hi"), "state:count": .number(3)])
        try harness.show(makeSpec())
        let report = try XCTUnwrap(harness.coordinator.report(id: "shop"))
        XCTAssertEqual(report.version, 1)
        XCTAssertEqual(report.keys.map(\.key), ["state:count", "data:/note"])
        XCTAssertEqual(report.keys.map(\.bytes), [
            PrototypeStorageBytes.entry("state:count", .number(3)),
            PrototypeStorageBytes.entry("data:/note", .string("hi")),
        ])
        XCTAssertEqual(report.totalBytes, report.keys.map(\.bytes).reduce(0, +))
        let wire = report.wireObject
        XCTAssertEqual(wire["version"] as? Int, 1)
        XCTAssertNil(wire["skippedKeys"])
        XCTAssertNil(harness.coordinator.report(id: "other"))
        try harness.show(makeSpec(version: nil))
        XCTAssertNil(harness.coordinator.report(id: "shop"), "a spec without storage reports none")
    }
}

private struct FailingDeleteStore: PrototypeStorageStore {
    func load(id _: String) throws -> PrototypeStoredValues? { nil }
    func save(_: PrototypeStoredValues, id _: String) throws {}
    func delete(id _: String) throws { throw FakeStoreFailure() }
}
