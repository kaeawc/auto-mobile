// swiftlint:disable force_unwrapping force_try
// Force-unwrap/force-try are idiomatic in test fixtures (fail fast on bad setup); disabled file-wide.

import XCTest
@testable import AutoMobileSDK

final class EventPersistenceTests: XCTestCase {

    private var tempDir: URL!
    private var persistence: FileEventPersistence!
    private var fakeDateProvider: FakeDateProvider!

    override func setUp() {
        super.setUp()
        tempDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("event_persistence_tests_\(UUID().uuidString)")
        fakeDateProvider = FakeDateProvider(initialDate: Date())
        persistence = FileEventPersistence(directory: tempDir, dateProvider: fakeDateProvider)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        super.tearDown()
    }

    // MARK: - Persist + Load Round-Trip

    func testPersistAndLoadInteractionEvent() {
        let event = SdkInteractionEvent(interactionType: "test_event", properties: ["key": "value"])
        let batchId = persistence.persist([event])
        XCTAssertNotNil(batchId)

        let pending = persistence.loadPending()
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(pending[0].batchId, batchId)
        XCTAssertEqual(pending[0].events.count, 1)

        let loaded = pending[0].events[0]
        XCTAssertEqual(loaded.eventType, .interaction)
        if let interaction = loaded as? SdkInteractionEvent {
            XCTAssertEqual(interaction.interactionType, "test_event")
            XCTAssertEqual(interaction.properties["key"], "value")
        } else {
            XCTFail("Expected SdkInteractionEvent")
        }
    }

    func testPersistAndLoadStorageChangedEvent() {
        let event = SdkStorageChangedEvent(
            timestamp: 1000, suiteName: "defaults", key: "theme",
            newValue: "dark", valueType: "string", changeType: "add", sequenceNumber: 7
        )
        let batchId = persistence.persist([event])
        XCTAssertNotNil(batchId)

        let pending = persistence.loadPending()
        XCTAssertEqual(pending.count, 1)
        guard let loaded = pending[0].events.first as? SdkStorageChangedEvent else {
            return XCTFail("Expected SdkStorageChangedEvent")
        }
        XCTAssertEqual(loaded.eventType, .storageChanged)
        XCTAssertEqual(loaded.key, "theme")
        XCTAssertEqual(loaded.newValue, "dark")
        XCTAssertEqual(loaded.valueType, "string")
        XCTAssertEqual(loaded.changeType, "add")
        XCTAssertEqual(loaded.sequenceNumber, 7)
    }

    /// A storage event persisted by an SDK build predating `changeType` must
    /// still decode (defaulting to "modify") instead of being silently dropped
    /// by `loadPending`'s `try?`.
    func testStorageChangedDecodesLegacyPayloadWithoutChangeType() throws {
        let legacyJson = Data("""
        {"eventType":"storage_changed","timestamp":1000,"suiteName":"defaults",\
        "key":"k","newValue":"v","valueType":"string","sequenceNumber":3}
        """.utf8)

        let event = try JSONDecoder().decode(SdkStorageChangedEvent.self, from: legacyJson)

        XCTAssertEqual(event.eventType, .storageChanged)
        XCTAssertEqual(event.key, "k")
        XCTAssertEqual(event.newValue, "v")
        XCTAssertEqual(event.valueType, "string")
        XCTAssertEqual(event.changeType, "modify")
        XCTAssertEqual(event.sequenceNumber, 3)
    }

    func testPersistAndLoadNavigationEvent() {
        let event = SdkNavigationEvent(
            timestamp: 1000,
            destination: "/home",
            source: .swiftUINavigation,
            arguments: ["id": "42"],
            metadata: [:]
        )
        let batchId = persistence.persist([event])
        XCTAssertNotNil(batchId)

        let pending = persistence.loadPending()
        XCTAssertEqual(pending.count, 1)
        if let nav = pending[0].events[0] as? SdkNavigationEvent {
            XCTAssertEqual(nav.destination, "/home")
            XCTAssertEqual(nav.source, .swiftUINavigation)
            XCTAssertEqual(nav.arguments["id"], "42")
        } else {
            XCTFail("Expected SdkNavigationEvent")
        }
    }

    func testPersistEmptyArrayReturnsNil() {
        let batchId = persistence.persist([])
        XCTAssertNil(batchId)
    }

    // MARK: - FIFO Order

    func testLoadPendingReturnsFIFOOrder() {
        // Create files with explicit timestamp prefixes to guarantee ordering
        let encoder = JSONEncoder()
        let event1 = SdkInteractionEvent(interactionType: "first", properties: [:])
        let event2 = SdkInteractionEvent(interactionType: "second", properties: [:])

        let id1 = "1000000000000_AAA"
        let id2 = "2000000000000_BBB"

        // Write files directly with known batch IDs for deterministic ordering
        for (batchId, event) in [(id1, event1), (id2, event2)] {
            let envelope = try! SdkEventEnvelope(event)
            let persisted = [PersistedEvent(eventType: envelope.eventType, payload: envelope.payload)]
            let data = try! encoder.encode(persisted)
            let fileURL = tempDir.appendingPathComponent("events_\(batchId).json")
            try! data.write(to: fileURL)
        }

        let pending = persistence.loadPending()
        XCTAssertEqual(pending.count, 2)
        XCTAssertEqual(pending[0].batchId, id1)
        XCTAssertEqual(pending[1].batchId, id2)
        if let first = pending[0].events.first as? SdkInteractionEvent {
            XCTAssertEqual(first.interactionType, "first")
        }
        if let second = pending[1].events.first as? SdkInteractionEvent {
            XCTAssertEqual(second.interactionType, "second")
        }
    }

    // MARK: - Remove Batch

    func testRemoveBatchDeletesFile() {
        let event = SdkInteractionEvent(interactionType: "to_remove", properties: [:])
        let batchId = persistence.persist([event])!

        XCTAssertEqual(persistence.loadPending().count, 1)
        persistence.removeBatch(batchId)
        XCTAssertEqual(persistence.loadPending().count, 0)
    }

    func testRemoveNonExistentBatchIsNoOp() {
        persistence.removeBatch("nonexistent_id")
        XCTAssertEqual(persistence.loadPending().count, 0)
    }

    // MARK: - Cleanup TTL

    func testCleanupRemovesOldBatches() {
        // Use a fixed time for deterministic testing
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        fakeDateProvider.set(now)

        // Create a file with an old timestamp (8 days ago)
        let oldTs = Int(now.timeIntervalSince1970 * 1000) - (8 * 24 * 60 * 60 * 1000)
        let oldFile = tempDir.appendingPathComponent("events_\(oldTs)_OLD.json")
        let data = try! JSONSerialization.data(withJSONObject: [["eventType": "interaction"]])
        try! data.write(to: oldFile)

        // Create a recent file
        let event = SdkInteractionEvent(interactionType: "recent", properties: [:])
        _ = persistence.persist([event])

        persistence.cleanup(maxAgeDays: 7)

        // Old file should be gone, recent should remain
        let remaining = try! FileManager.default.contentsOfDirectory(at: tempDir, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("events_") }
        XCTAssertEqual(remaining.count, 1)
        XCTAssertFalse(remaining[0].lastPathComponent.contains("OLD"))
    }

    // MARK: - Corrupt File Handling

    func testCorruptFileIsRemovedOnLoad() {
        let corruptFile = tempDir.appendingPathComponent("events_999_CORRUPT.json")
        try! "not valid json".data(using: .utf8)!.write(to: corruptFile)

        let pending = persistence.loadPending()
        XCTAssertEqual(pending.count, 0)

        // Corrupt file should have been removed
        XCTAssertFalse(FileManager.default.fileExists(atPath: corruptFile.path))
    }

    // MARK: - Multiple Event Types in One Batch

    func testPersistMultipleEventTypesInBatch() {
        let interaction = SdkInteractionEvent(interactionType: "mixed", properties: ["a": "b"])
        let nav = SdkNavigationEvent(destination: "/settings", source: .deepLink)
        let batchId = persistence.persist([interaction, nav])
        XCTAssertNotNil(batchId)

        let pending = persistence.loadPending()
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(pending[0].events.count, 2)
        XCTAssertEqual(pending[0].events[0].eventType, .interaction)
        XCTAssertEqual(pending[0].events[1].eventType, .navigation)
    }
}
