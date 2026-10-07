// swiftlint:disable force_unwrapping force_try
// Force-unwrap/force-try are idiomatic in test fixtures (fail fast on bad setup); disabled file-wide.

@testable import AutoMobileSDK
import XCTest

final class EventPersistenceTests: XCTestCase {
    private var tempDir: URL!
    private var persistence: FileEventPersistence!
    private var fakeDateProvider: FakeDateProvider!

    override func setUp() {
        super.setUp()
        tempDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("event_persistence_tests_\(UUID().uuidString)")
        fakeDateProvider = FakeDateProvider()
        persistence = FileEventPersistence(directory: tempDir, dateProvider: fakeDateProvider)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        super.tearDown()
    }

    // MARK: - Persist + Load Round-Trip

    func testPersistAndLoadFrameMetricsEvent() throws {
        let event = SdkFrameMetricsEvent(timestamp: 1000, fps: 55, frameTimeMs: 18, jankFrames: 2)
        XCTAssertNotNil(persistence.persist([event]))
        let pending = persistence.loadPending()
        XCTAssertEqual(pending.count, 1)
        let loaded = try XCTUnwrap(pending.first?.events.first as? SdkFrameMetricsEvent)
        XCTAssertEqual(loaded.eventType, .frameMetrics)
        XCTAssertEqual(loaded.timestamp, 1000)
        XCTAssertEqual(loaded.fps, 55)
        XCTAssertEqual(loaded.frameTimeMs, 18)
        XCTAssertEqual(loaded.jankFrames, 2)
    }

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
            sequenceNumber: 7,
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
            XCTAssertEqual(nav.sequenceNumber, 7)
        } else {
            XCTFail("Expected SdkNavigationEvent")
        }
    }

    func testNavigationEventDecodesLegacyPayloadWithoutSequenceNumber() throws {
        let legacyJson = Data("""
        {"eventType":"navigation","timestamp":1000,"destination":"/home",\
        "source":"swiftui_navigation","arguments":{},"metadata":{}}
        """.utf8)

        let event = try JSONDecoder().decode(SdkNavigationEvent.self, from: legacyJson)

        XCTAssertNil(event.sequenceNumber)
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

    func testCleanupWithNegativeAgeKeepsOldAndFreshBatches() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let event = SdkInteractionEvent(timestamp: 1000, interactionType: "keep", properties: [:])
        fakeDateProvider.set(now.addingTimeInterval(-8 * 24 * 60 * 60))
        let oldBatchId = persistence.persist([event])!
        fakeDateProvider.set(now)
        let freshBatchId = persistence.persist([event])!

        persistence.cleanup(maxAgeDays: -1)

        XCTAssertEqual(persistence.loadPending().map { $0.batchId }, [oldBatchId, freshBatchId])
    }

    func testCleanupWithZeroAgeKeepsBatchExactlyAtNow() {
        fakeDateProvider.set(Date(timeIntervalSince1970: 1_700_000_000))
        let oldFile = tempDir.appendingPathComponent("events_1699999999999_OLD.json")
        let currentFile = tempDir.appendingPathComponent("events_1700000000000_NOW.json")
        let event = SdkInteractionEvent(timestamp: 1000, interactionType: "boundary", properties: [:])
        let envelope = try! SdkEventEnvelope(event)
        let persisted = [PersistedEvent(eventType: envelope.eventType, payload: envelope.payload)]
        let data = try! JSONEncoder().encode(persisted)
        try! data.write(to: oldFile)
        try! data.write(to: currentFile)

        persistence.cleanup(maxAgeDays: 0)

        XCTAssertFalse(FileManager.default.fileExists(atPath: oldFile.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: currentFile.path))
        XCTAssertEqual(persistence.loadPending().map { $0.batchId }, ["1700000000000_NOW"])
    }

    func testCleanupWithMaximumAgeKeepsAllBatches() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let event = SdkInteractionEvent(timestamp: 1000, interactionType: "keep", properties: [:])
        fakeDateProvider.set(now.addingTimeInterval(-8 * 24 * 60 * 60))
        let oldBatchId = persistence.persist([event])!
        fakeDateProvider.set(now)
        let freshBatchId = persistence.persist([event])!

        persistence.cleanup(maxAgeDays: Int.max)

        XCTAssertEqual(persistence.loadPending().map { $0.batchId }, [oldBatchId, freshBatchId])
    }

    // MARK: - Corrupt File Handling

    func testTransientReadFailureKeepsBatchForRetry() {
        let event = SdkInteractionEvent(timestamp: 1000, interactionType: "retry", properties: [:])
        let batchId = persistence.persist([event])!
        let fileURL = tempDir.appendingPathComponent("events_\(batchId).json")
        let failingPersistence = FileEventPersistence(
            directory: tempDir,
            dateProvider: fakeDateProvider,
            readData: { _ in throw CocoaError(.fileReadNoPermission) }
        )

        XCTAssertTrue(failingPersistence.loadPending().isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: fileURL.path))

        let retryPersistence = FileEventPersistence(directory: tempDir, dateProvider: fakeDateProvider)
        let pending = retryPersistence.loadPending()
        XCTAssertEqual(pending.map { $0.batchId }, [batchId])
        XCTAssertEqual((pending.first?.events.first as? SdkInteractionEvent)?.interactionType, "retry")
    }

    func testVanishedFileIsSkippedWhileOtherBatchLoads() {
        let event = SdkInteractionEvent(timestamp: 1000, interactionType: "available", properties: [:])
        let missingBatchId = persistence.persist([event])!
        let availableBatchId = persistence.persist([event])!
        let missingFile = tempDir.appendingPathComponent("events_\(missingBatchId).json")
        let readingPersistence = FileEventPersistence(
            directory: tempDir,
            dateProvider: fakeDateProvider,
            readData: { fileURL in
                if fileURL.lastPathComponent == missingFile.lastPathComponent {
                    try FileManager.default.removeItem(at: fileURL)
                    throw CocoaError(.fileReadNoSuchFile)
                }
                return try Data(contentsOf: fileURL)
            }
        )

        let pending = readingPersistence.loadPending()

        XCTAssertEqual(pending.map { $0.batchId }, [availableBatchId])
        XCTAssertFalse(FileManager.default.fileExists(atPath: missingFile.path))
    }

    func testCorruptFileIsDeletedWhileUnreadableBatchIsKept() {
        let event = SdkInteractionEvent(timestamp: 1000, interactionType: "unreadable", properties: [:])
        let batchId = persistence.persist([event])!
        let unreadableFile = tempDir.appendingPathComponent("events_\(batchId).json")
        let corruptFile = tempDir.appendingPathComponent("events_999_CORRUPT.json")
        try! Data("not valid json".utf8).write(to: corruptFile)
        let readingPersistence = FileEventPersistence(
            directory: tempDir,
            dateProvider: fakeDateProvider,
            readData: { fileURL in
                if fileURL.lastPathComponent == unreadableFile.lastPathComponent {
                    throw CocoaError(.fileReadNoPermission)
                }
                return try Data(contentsOf: fileURL)
            }
        )

        XCTAssertTrue(readingPersistence.loadPending().isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: corruptFile.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: unreadableFile.path))
    }

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

    func testPendingCapEvictsOldestAndKeepsNewest() {
        persistence = FileEventPersistence(directory: tempDir, dateProvider: fakeDateProvider, maxPendingBatches: 2)
        let event = SdkInteractionEvent(interactionType: "cap")
        let oldest = persistence.persist([event])!
        fakeDateProvider.advance(by: 1)
        let second = persistence.persist([event])!
        fakeDateProvider.advance(by: 1)
        let newest = persistence.persist([event])!
        XCTAssertFalse(
            FileManager.default
                .fileExists(atPath: tempDir.appendingPathComponent("events_\(oldest).json").path)
        )
        XCTAssertEqual(persistence.loadPending().map { $0.batchId }, [second, newest])
    }

    func testPendingCapNeverEvictsJustWrittenBatchWhenClockMovesBackward() throws {
        persistence = FileEventPersistence(directory: tempDir, dateProvider: fakeDateProvider, maxPendingBatches: 2)
        let event = SdkInteractionEvent(interactionType: "clock")
        _ = persistence.persist([event])
        fakeDateProvider.advance(by: 1)
        _ = persistence.persist([event])
        fakeDateProvider.advance(by: -10)
        let justWritten = persistence.persist([event])!
        XCTAssertTrue(
            FileManager.default
                .fileExists(atPath: tempDir.appendingPathComponent("events_\(justWritten).json").path)
        )
        let files = try FileManager.default.contentsOfDirectory(at: tempDir, includingPropertiesForKeys: nil)
        let pendingFiles = files.filter {
            $0.lastPathComponent.hasPrefix("events_") && $0.pathExtension == "json"
        }
        XCTAssertEqual(pendingFiles.count, 2)
    }

    func testPendingCapOneAndNonPositiveCapsKeepJustWrittenBatch() {
        for cap in [1, 0, -1] {
            persistence = FileEventPersistence(
                directory: tempDir,
                dateProvider: fakeDateProvider,
                maxPendingBatches: cap
            )
            let event = SdkInteractionEvent(interactionType: "single")
            _ = persistence.persist([event])
            fakeDateProvider.advance(by: 1)
            let newest = persistence.persist([event])!
            let files = try! FileManager.default.contentsOfDirectory(at: tempDir, includingPropertiesForKeys: nil)
            XCTAssertEqual(files.map { $0.lastPathComponent }, ["events_\(newest).json"])
            XCTAssertEqual(persistence.loadPending().map { $0.batchId }, [newest])
        }
    }

    func testPendingCapUsesFilenameToBreakTimestampTies() throws {
        persistence = FileEventPersistence(directory: tempDir, dateProvider: fakeDateProvider, maxPendingBatches: 2)
        let event = SdkInteractionEvent(interactionType: "tie")
        let envelope = try SdkEventEnvelope(event)
        let data = try JSONEncoder().encode([PersistedEvent(eventType: envelope.eventType, payload: envelope.payload)])
        for id in ["100_A", "100_B"] {
            try data.write(to: tempDir.appendingPathComponent("events_\(id).json"))
        }
        let justWritten = persistence.persist([event])!
        XCTAssertFalse(FileManager.default.fileExists(atPath: tempDir.appendingPathComponent("events_100_A.json").path))
        XCTAssertEqual(persistence.loadPending().map { $0.batchId }, ["100_B", justWritten])
    }

    func testDefaultPendingCapBoundsExistingBacklogOnLoad() throws {
        let event = SdkInteractionEvent(interactionType: "legacy")
        let envelope = try SdkEventEnvelope(event)
        let data = try JSONEncoder().encode([PersistedEvent(eventType: envelope.eventType, payload: envelope.payload)])
        for timestamp in 1 ... 101 {
            try data.write(to: tempDir.appendingPathComponent("events_\(timestamp)_legacy.json"))
        }
        let pending = persistence.loadPending()
        XCTAssertEqual(pending.count, 100)
        XCTAssertEqual(pending.first?.batchId, "2_legacy")
        XCTAssertEqual(pending.last?.batchId, "101_legacy")
    }
}
