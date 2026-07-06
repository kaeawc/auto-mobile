@testable import AutoMobileSDK
import SQLite3
import XCTest

final class UserDefaultsInspectorTests: XCTestCase {
    private var diffBuffer: SdkEventBuffer?

    override func tearDown() {
        UserDefaultsInspector.shared.reset()
        diffBuffer?.shutdown()
        diffBuffer = nil
        // Diff tests toggle the global SDK flag; restore its default so later
        // suites aren't left with the SDK disabled.
        AutoMobileSDK.shared.setEnabled(true)
        super.tearDown()
    }

    func testDisabledByDefault() {
        UserDefaultsInspector.shared.initialize()
        XCTAssertFalse(UserDefaultsInspector.shared.isEnabled)
        XCTAssertNil(UserDefaultsInspector.shared.getDriver())
    }

    func testEnableAndGetDriver() {
        UserDefaultsInspector.shared.initialize()
        UserDefaultsInspector.shared.setEnabled(true)
        XCTAssertTrue(UserDefaultsInspector.shared.isEnabled)
        XCTAssertNotNil(UserDefaultsInspector.shared.getDriver())
    }

    func testFakeDriverSetAndGet() {
        let fakeDriver = FakeUserDefaultsDriver()
        UserDefaultsInspector.shared.initialize()
        UserDefaultsInspector.shared.setDriver(fakeDriver)
        UserDefaultsInspector.shared.setEnabled(true)

        fakeDriver.setValue(suiteName: nil, key: "theme", value: "dark", type: .string)

        let driver = UserDefaultsInspector.shared.getDriver()
        let value = driver?.getValue(suiteName: nil, key: "theme")
        XCTAssertEqual(value?.value, "dark")
        XCTAssertEqual(value?.type, .string)
    }

    func testFakeDriverRemoveAndClear() {
        let fakeDriver = FakeUserDefaultsDriver()
        fakeDriver.setValue(suiteName: nil, key: "a", value: "1", type: .string)
        fakeDriver.setValue(suiteName: nil, key: "b", value: "2", type: .string)

        fakeDriver.removeValue(suiteName: nil, key: "a")
        XCTAssertNil(fakeDriver.getValue(suiteName: nil, key: "a"))
        XCTAssertNotNil(fakeDriver.getValue(suiteName: nil, key: "b"))

        fakeDriver.clear(suiteName: nil)
        XCTAssertTrue(fakeDriver.getValues(suiteName: nil).isEmpty)
    }

    // MARK: - Change Diffing

    /// Wire up an enabled inspector over a fake driver and a real callback-backed
    /// buffer, seed the baseline snapshot, and return the pieces a diff test needs.
    private func makeDiffHarness(
        seed: [(key: String, value: String, type: KeyValueType)] = []
    ) -> (driver: FakeUserDefaultsDriver, buffer: SdkEventBuffer, events: () -> [SdkStorageChangedEvent]) {
        AutoMobileSDK.shared.setEnabled(true)

        let fakeDriver = FakeUserDefaultsDriver()
        for entry in seed {
            fakeDriver.setValue(suiteName: nil, key: entry.key, value: entry.value, type: entry.type)
        }

        let captured = CapturedEvents()
        let buffer = SdkEventBuffer { events in
            captured.append(events.compactMap { $0 as? SdkStorageChangedEvent })
        }
        buffer.start()
        diffBuffer = buffer

        let inspector = UserDefaultsInspector.shared
        inspector.initialize(buffer: buffer)
        inspector.setDriver(fakeDriver)
        inspector.setEnabled(true)
        // setEnabled(true) auto-starts a real NotificationCenter observer on the
        // standard suite. These tests drive handleDidChange directly, so drop the
        // observer to keep unrelated real-standard-defaults churn in the test
        // process from racing extra handleDidChange calls into the capture.
        inspector.stopListening()
        // Seed the baseline so pre-existing keys aren't reported as spurious adds.
        inspector.captureBaseline(suiteName: nil)

        return (fakeDriver, buffer, {
            buffer.flush()
            return captured.all
        })
    }

    func testDiffEmitsAddForNewKey() {
        let harness = makeDiffHarness()

        harness.driver.setValue(suiteName: nil, key: "theme", value: "dark", type: .string)
        UserDefaultsInspector.shared.handleDidChange(suiteName: nil)

        let events = harness.events()
        XCTAssertEqual(events.count, 1)
        let event = events[0]
        XCTAssertEqual(event.key, "theme")
        XCTAssertEqual(event.newValue, "dark")
        XCTAssertEqual(event.valueType, "string")
        XCTAssertEqual(event.changeType, "add")
    }

    func testDiffEmitsModifyForChangedValue() {
        let harness = makeDiffHarness(seed: [(key: "count", value: "1", type: .int)])

        harness.driver.setValue(suiteName: nil, key: "count", value: "2", type: .int)
        UserDefaultsInspector.shared.handleDidChange(suiteName: nil)

        let events = harness.events()
        XCTAssertEqual(events.count, 1)
        let event = events[0]
        XCTAssertEqual(event.key, "count")
        XCTAssertEqual(event.newValue, "2")
        XCTAssertEqual(event.valueType, "int")
        XCTAssertEqual(event.changeType, "modify")
    }

    func testDiffEmitsRemoveForDeletedKey() {
        let harness = makeDiffHarness(seed: [(key: "session", value: "abc", type: .string)])

        harness.driver.removeValue(suiteName: nil, key: "session")
        UserDefaultsInspector.shared.handleDidChange(suiteName: nil)

        let events = harness.events()
        XCTAssertEqual(events.count, 1)
        let event = events[0]
        XCTAssertEqual(event.key, "session")
        XCTAssertNil(event.newValue)
        XCTAssertEqual(event.previousValue, "abc")
        XCTAssertEqual(event.valueType, "string")
        XCTAssertEqual(event.changeType, "remove")
    }

    func testDiffThreadsPreviousValueForModifyAndNilForAdd() {
        let harness = makeDiffHarness(seed: [(key: "count", value: "1", type: .int)])

        harness.driver.setValue(suiteName: nil, key: "count", value: "2", type: .int)
        harness.driver.setValue(suiteName: nil, key: "fresh", value: "new", type: .string)
        UserDefaultsInspector.shared.handleDidChange(suiteName: nil)

        let events = harness.events().sorted { ($0.key ?? "") < ($1.key ?? "") }
        // "count" modified: prior value threaded so the ingest can skip its lookup.
        XCTAssertEqual(events[0].key, "count")
        XCTAssertEqual(events[0].changeType, "modify")
        XCTAssertEqual(events[0].previousValue, "1")
        // "fresh" added: no prior value.
        XCTAssertEqual(events[1].key, "fresh")
        XCTAssertEqual(events[1].changeType, "add")
        XCTAssertNil(events[1].previousValue)
    }

    func testDiffEmitsNothingWhenNoValueChanged() {
        let harness = makeDiffHarness(seed: [(key: "stable", value: "x", type: .string)])

        // Re-set the same value: didChangeNotification can fire without any
        // observable value change, and that must not emit an event.
        harness.driver.setValue(suiteName: nil, key: "stable", value: "x", type: .string)
        UserDefaultsInspector.shared.handleDidChange(suiteName: nil)

        XCTAssertTrue(harness.events().isEmpty)
    }

    func testDiffEmitsMultipleChangesWithMonotonicSequence() {
        let harness = makeDiffHarness(seed: [(key: "keep", value: "1", type: .int)])

        harness.driver.setValue(suiteName: nil, key: "alpha", value: "a", type: .string)
        harness.driver.setValue(suiteName: nil, key: "keep", value: "2", type: .int)
        UserDefaultsInspector.shared.handleDidChange(suiteName: nil)

        let events = harness.events().sorted { ($0.key ?? "") < ($1.key ?? "") }
        XCTAssertEqual(events.compactMap { $0.key }, ["alpha", "keep"])
        XCTAssertEqual(events.map { $0.changeType }, ["add", "modify"])
        // Distinct, monotonically-increasing sequence numbers per emitted event.
        XCTAssertEqual(Set(events.map { $0.sequenceNumber }).count, 2)
        XCTAssertLessThan(events[0].sequenceNumber, events[1].sequenceNumber)
    }

    func testDiffDoesNotEmitPreExistingKeysOnFirstChange() {
        // Baseline already contains "existing"; only the newly-added key changes.
        let harness = makeDiffHarness(seed: [(key: "existing", value: "old", type: .string)])

        harness.driver.setValue(suiteName: nil, key: "fresh", value: "new", type: .string)
        UserDefaultsInspector.shared.handleDidChange(suiteName: nil)

        let events = harness.events()
        XCTAssertEqual(events.compactMap { $0.key }, ["fresh"])
        XCTAssertEqual(events.first?.changeType, "add")
    }

    func testDiffEmitsNothingWhenSdkDisabled() {
        let harness = makeDiffHarness()
        AutoMobileSDK.shared.setEnabled(false)

        harness.driver.setValue(suiteName: nil, key: "theme", value: "dark", type: .string)
        UserDefaultsInspector.shared.handleDidChange(suiteName: nil)

        XCTAssertTrue(harness.events().isEmpty)
        AutoMobileSDK.shared.setEnabled(true)
    }

    /// Exercises the real production wiring: `startListening` registers the
    /// `NotificationCenter` observer and seeds the baseline, and posting the
    /// actual `UserDefaults.didChangeNotification` drives the diff. The observer
    /// uses `queue: nil`, so delivery is synchronous — no async waiting needed.
    func testStartListeningObserverEmitsOnDidChangeNotification() {
        AutoMobileSDK.shared.setEnabled(true)
        let fakeDriver = FakeUserDefaultsDriver()
        fakeDriver.setValue(suiteName: nil, key: "existing", value: "old", type: .string)

        let captured = CapturedEvents()
        let buffer = SdkEventBuffer { events in
            captured.append(events.compactMap { $0 as? SdkStorageChangedEvent })
        }
        buffer.start()
        diffBuffer = buffer

        let inspector = UserDefaultsInspector.shared
        inspector.initialize(buffer: buffer)
        inspector.setDriver(fakeDriver)
        inspector.setEnabled(true)
        inspector.startListening(suiteName: nil)

        // App writes a new key, then the OS posts the change notification.
        fakeDriver.setValue(suiteName: nil, key: "fresh", value: "new", type: .string)
        NotificationCenter.default.post(name: UserDefaults.didChangeNotification, object: UserDefaults.standard)

        buffer.flush()
        let events = captured.all
        XCTAssertEqual(events.compactMap { $0.key }, ["fresh"])
        XCTAssertEqual(events.first?.changeType, "add")

        inspector.stopListening()
    }

    /// `startListening` must seed the baseline before it starts observing, so the
    /// first notification diffs against the suite's existing contents rather than
    /// an empty snapshot (which would report every pre-existing key as an "add").
    func testStartListeningSeedsBaselineSoPreexistingKeysAreNotEmitted() {
        AutoMobileSDK.shared.setEnabled(true)
        let fakeDriver = FakeUserDefaultsDriver()
        fakeDriver.setValue(suiteName: nil, key: "a", value: "1", type: .string)
        fakeDriver.setValue(suiteName: nil, key: "b", value: "2", type: .string)

        let captured = CapturedEvents()
        let buffer = SdkEventBuffer { events in
            captured.append(events.compactMap { $0 as? SdkStorageChangedEvent })
        }
        buffer.start()
        diffBuffer = buffer

        let inspector = UserDefaultsInspector.shared
        inspector.initialize(buffer: buffer)
        inspector.setDriver(fakeDriver)
        inspector.setEnabled(true)
        inspector.startListening(suiteName: nil)

        // A notification with no change since startListening must emit nothing —
        // the pre-existing keys were captured into the baseline before observing.
        NotificationCenter.default.post(name: UserDefaults.didChangeNotification, object: UserDefaults.standard)

        buffer.flush()
        XCTAssertTrue(captured.all.isEmpty)

        inspector.stopListening()
    }

    // MARK: - Auto-start (production trigger, #3193)

    /// The production trigger: `setEnabled(true)` alone must start standard-suite
    /// listening — no separate `startListening` integration step — so a host that
    /// only calls `initialize` + `setEnabled(true)` (e.g. PlaygroundApp) produces
    /// `storage_changed` events end-to-end.
    func testSetEnabledAutoStartsStandardSuiteListening() {
        AutoMobileSDK.shared.setEnabled(true)
        let fakeDriver = FakeUserDefaultsDriver()
        fakeDriver.setValue(suiteName: nil, key: "existing", value: "old", type: .string)

        let captured = CapturedEvents()
        let buffer = SdkEventBuffer { events in
            captured.append(events.compactMap { $0 as? SdkStorageChangedEvent })
        }
        buffer.start()
        diffBuffer = buffer

        let inspector = UserDefaultsInspector.shared
        inspector.initialize(buffer: buffer)
        inspector.setDriver(fakeDriver)
        XCTAssertFalse(inspector.isListening)

        inspector.setEnabled(true)
        XCTAssertTrue(inspector.isListening)

        // App writes a new key, then the OS posts the change notification.
        fakeDriver.setValue(suiteName: nil, key: "fresh", value: "new", type: .string)
        NotificationCenter.default.post(name: UserDefaults.didChangeNotification, object: UserDefaults.standard)

        buffer.flush()
        let events = captured.all
        // Baseline was seeded at auto-start, so "existing" is not replayed.
        XCTAssertEqual(events.compactMap { $0.key }, ["fresh"])
        XCTAssertEqual(events.first?.changeType, "add")

        inspector.stopListening()
    }

    /// The reverse init order: `setEnabled(true)` before `initialize` cannot
    /// start listening (no driver to seed the baseline from — diffing against an
    /// empty snapshot would replay every pre-existing key as an "add"), so
    /// `initialize` must pick up the deferred auto-start.
    func testInitializeAutoStartsWhenEnabledBeforeInitialize() {
        let inspector = UserDefaultsInspector.shared
        // Hermetic: clear any driver/observer state left by earlier suites so
        // the pre-initialize assertions below are order-independent.
        inspector.reset()

        inspector.setEnabled(true)
        XCTAssertFalse(inspector.isListening)

        inspector.initialize()
        XCTAssertTrue(inspector.isListening)

        inspector.stopListening()
    }

    /// A host that explicitly listens on an app-group suite must keep that
    /// choice: a later `setEnabled(true)` never replaces an already-registered
    /// observer with the standard-suite one.
    func testSetEnabledDoesNotReplaceExplicitSuiteListener() {
        AutoMobileSDK.shared.setEnabled(true)
        let fakeDriver = FakeUserDefaultsDriver()

        let captured = CapturedEvents()
        let buffer = SdkEventBuffer { events in
            captured.append(events.compactMap { $0 as? SdkStorageChangedEvent })
        }
        buffer.start()
        diffBuffer = buffer

        let inspector = UserDefaultsInspector.shared
        inspector.initialize(buffer: buffer)
        inspector.setDriver(fakeDriver)
        inspector.setEnabled(true)

        // Host opts into a specific app-group suite, then re-enables.
        inspector.startListening(suiteName: "group.app")
        inspector.setEnabled(true)
        XCTAssertTrue(inspector.isListening)

        // A standard-suite change + notification must NOT be observed — the
        // registered observer targets the app-group suite's defaults object,
        // and no standard-suite observer was re-registered by setEnabled.
        fakeDriver.setValue(suiteName: nil, key: "fresh", value: "new", type: .string)
        NotificationCenter.default.post(name: UserDefaults.didChangeNotification, object: UserDefaults.standard)

        buffer.flush()
        XCTAssertTrue(captured.all.isEmpty)

        inspector.stopListening()
    }

    // MARK: - System-key noise filter (#3193)

    func testIsSystemKeyMatchesKnownPrefixesOnly() {
        XCTAssertTrue(UserDefaultsInspector.isSystemKey("com.apple.keyboard.preferences"))
        XCTAssertTrue(UserDefaultsInspector.isSystemKey("AppleLanguages"))
        XCTAssertTrue(UserDefaultsInspector.isSystemKey("AppleLocale"))
        XCTAssertTrue(UserDefaultsInspector.isSystemKey("NSLinguisticDataAssetsRequested"))

        XCTAssertFalse(UserDefaultsInspector.isSystemKey("theme"))
        XCTAssertFalse(UserDefaultsInspector.isSystemKey("com.example.flag"))
        // Prefix match is case-sensitive: app-style lowercase keys pass through.
        XCTAssertFalse(UserDefaultsInspector.isSystemKey("apple_pie"))
        XCTAssertFalse(UserDefaultsInspector.isSystemKey("nsFlag"))
    }

    /// `NSGlobalDomain` churn (system keys changing without the app touching
    /// them) must not emit `storage_changed` events; app keys still do.
    func testDiffIgnoresSystemKeyChanges() {
        let harness = makeDiffHarness(seed: [
            (key: "AppleLanguages", value: "(en)", type: .array),
            (key: "com.apple.metal.deviceStats", value: "1", type: .int),
        ])

        // System keys modify, remove, and add alongside a single app-key change.
        harness.driver.setValue(suiteName: nil, key: "AppleLanguages", value: "(fr)", type: .array)
        harness.driver.removeValue(suiteName: nil, key: "com.apple.metal.deviceStats")
        harness.driver.setValue(suiteName: nil, key: "NSLanguages", value: "(fr)", type: .array)
        harness.driver.setValue(suiteName: nil, key: "theme", value: "dark", type: .string)
        UserDefaultsInspector.shared.handleDidChange(suiteName: nil)

        let events = harness.events()
        XCTAssertEqual(events.compactMap { $0.key }, ["theme"])
        XCTAssertEqual(events.first?.changeType, "add")
    }

    /// `dictionaryRepresentation()` merges `NSGlobalDomain` into every suite's
    /// search list — named suites included — so the filter applies there too.
    func testDiffIgnoresSystemKeysInNamedSuites() {
        let harness = makeDiffHarness()
        UserDefaultsInspector.shared.captureBaseline(suiteName: "group.app")

        harness.driver.setValue(suiteName: "group.app", key: "AppleLocale", value: "en_US", type: .string)
        harness.driver.setValue(suiteName: "group.app", key: "count", value: "1", type: .int)
        UserDefaultsInspector.shared.handleDidChange(suiteName: "group.app")

        let events = harness.events()
        XCTAssertEqual(events.compactMap { $0.key }, ["count"])
        XCTAssertEqual(events.first?.suiteName, "group.app")
    }

    func testDiffEmitsModifyWhenOnlyTypeChanges() {
        // Same string representation ("1"), but Int -> String is a real change.
        let harness = makeDiffHarness(seed: [(key: "flag", value: "1", type: .int)])

        harness.driver.setValue(suiteName: nil, key: "flag", value: "1", type: .string)
        UserDefaultsInspector.shared.handleDidChange(suiteName: nil)

        let events = harness.events()
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].key, "flag")
        XCTAssertEqual(events[0].changeType, "modify")
        XCTAssertEqual(events[0].valueType, "string")
    }

    func testChangesDuringDisabledWindowAreNotReplayedAfterReEnable() {
        let harness = makeDiffHarness(seed: [(key: "a", value: "1", type: .string)])

        // A write happens while disabled — it must not be captured, and it must
        // not be replayed on the next notification after re-enabling.
        AutoMobileSDK.shared.setEnabled(false)
        harness.driver.setValue(suiteName: nil, key: "a", value: "2", type: .string)
        UserDefaultsInspector.shared.handleDidChange(suiteName: nil)
        XCTAssertTrue(harness.events().isEmpty)

        AutoMobileSDK.shared.setEnabled(true)
        // An unrelated later change: only this one should be reported, not the
        // "a: 1 -> 2" that happened during the disabled window.
        harness.driver.setValue(suiteName: nil, key: "b", value: "x", type: .string)
        UserDefaultsInspector.shared.handleDidChange(suiteName: nil)

        let events = harness.events()
        XCTAssertEqual(events.compactMap { $0.key }, ["b"])
        XCTAssertEqual(events.first?.changeType, "add")
    }

    /// Baselines are bucketed per suite, so a change in one suite must not be
    /// attributed to (or suppressed by) another suite's snapshot.
    func testDiffTracksSeparateBaselinesPerSuite() {
        AutoMobileSDK.shared.setEnabled(true)
        let fakeDriver = FakeUserDefaultsDriver()
        fakeDriver.setValue(suiteName: nil, key: "k1", value: "v1", type: .string)
        fakeDriver.setValue(suiteName: "group.app", key: "k2", value: "v2", type: .string)

        let captured = CapturedEvents()
        let buffer = SdkEventBuffer { events in
            captured.append(events.compactMap { $0 as? SdkStorageChangedEvent })
        }
        buffer.start()
        diffBuffer = buffer

        let inspector = UserDefaultsInspector.shared
        inspector.initialize(buffer: buffer)
        inspector.setDriver(fakeDriver)
        inspector.setEnabled(true)
        inspector.captureBaseline(suiteName: nil)
        inspector.captureBaseline(suiteName: "group.app")

        fakeDriver.setValue(suiteName: nil, key: "k1", value: "v1b", type: .string)
        fakeDriver.setValue(suiteName: "group.app", key: "k2", value: "v2b", type: .string)

        inspector.handleDidChange(suiteName: nil)
        inspector.handleDidChange(suiteName: "group.app")

        buffer.flush()
        let events = captured.all.sorted { ($0.suiteName ?? "") < ($1.suiteName ?? "") }
        XCTAssertEqual(events.count, 2)
        XCTAssertNil(events[0].suiteName)
        XCTAssertEqual(events[0].key, "k1")
        XCTAssertEqual(events[0].changeType, "modify")
        XCTAssertEqual(events[1].suiteName, "group.app")
        XCTAssertEqual(events[1].key, "k2")
        XCTAssertEqual(events[1].changeType, "modify")
    }
}

/// Thread-safe collector for events delivered on the buffer's flush queue.
private final class CapturedEvents: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [SdkStorageChangedEvent] = []

    var all: [SdkStorageChangedEvent] {
        lock.lock()
        defer { lock.unlock() }
        return events
    }

    func append(_ newEvents: [SdkStorageChangedEvent]) {
        lock.lock()
        defer { lock.unlock() }
        events.append(contentsOf: newEvents)
    }
}

final class DatabaseInspectorTests: XCTestCase {
    override func tearDown() {
        DatabaseInspector.shared.reset()
        super.tearDown()
    }

    func testDisabledByDefault() {
        DatabaseInspector.shared.initialize()
        XCTAssertFalse(DatabaseInspector.shared.isEnabled)
        XCTAssertNil(DatabaseInspector.shared.getDriver())
    }

    func testEnableAndGetDriver() {
        DatabaseInspector.shared.initialize()
        DatabaseInspector.shared.setEnabled(true)
        XCTAssertTrue(DatabaseInspector.shared.isEnabled)
        XCTAssertNotNil(DatabaseInspector.shared.getDriver())
    }

    func testFakeDriver() {
        let fakeDriver = FakeDatabaseDriver()
        fakeDriver.databases = [
            DatabaseDescriptor(name: "test.db", path: "/path/test.db", sizeBytes: 1024),
        ]
        fakeDriver.tables = ["/path/test.db": ["users", "posts"]]

        DatabaseInspector.shared.initialize()
        DatabaseInspector.shared.setDriver(fakeDriver)
        DatabaseInspector.shared.setEnabled(true)

        let driver = DatabaseInspector.shared.getDriver()
        XCTAssertEqual(driver?.getDatabases().count, 1)
        XCTAssertEqual(driver?.getTables(databasePath: "/path/test.db"), ["users", "posts"])
    }
}

final class SdkDatabaseRouteHandlerTests: XCTestCase {
    override func tearDown() {
        DatabaseInspector.shared.reset()
        super.tearDown()
    }

    func testExecuteSqlEncodesQueryResult() throws {
        let fakeDriver = RouteFakeDatabaseDriver()
        fakeDriver.databases = [
            DatabaseDescriptor(name: "app.db", path: "/app/Documents/app.db", sizeBytes: 1024),
        ]
        fakeDriver.sqlResult = SQLExecutionResult(
            columns: ["id", "payload"],
            rows: [["1", "0xCAFE"]],
            rowsAffected: 0
        )
        DatabaseInspector.shared.initialize()
        DatabaseInspector.shared.setDriver(fakeDriver)
        DatabaseInspector.shared.setEnabled(true)

        let request = SdkExecuteSqlRequest(
            databasePath: "/app/Documents/app.db",
            query: "SELECT id, payload FROM notes"
        )
        let body = try JSONEncoder().encode(request)

        let response = SdkDatabaseRouteHandler().handleExecuteSql(body: body)

        XCTAssertEqual(response.statusCode, 200)
        let payload = try JSONDecoder().decode(SdkExecuteSqlPayload.self, from: response.body)
        XCTAssertEqual(payload.queryType, "query")
        XCTAssertEqual(payload.columns, ["id", "payload"])
        XCTAssertEqual(payload.rows, [["1", "0xCAFE"]])
        XCTAssertEqual(fakeDriver.executeSqlCalls.count, 1)
        XCTAssertEqual(fakeDriver.executeSqlCalls[0].databasePath, "/app/Documents/app.db")
        XCTAssertEqual(fakeDriver.executeSqlCalls[0].query, "SELECT id, payload FROM notes")
    }

    func testExecuteSqlRejectsUnknownDatabasePathBeforeOpeningSqlite() throws {
        let fakeDriver = RouteFakeDatabaseDriver()
        fakeDriver.databases = [
            DatabaseDescriptor(name: "app.db", path: "/app/Documents/app.db", sizeBytes: 1024),
        ]
        DatabaseInspector.shared.initialize()
        DatabaseInspector.shared.setDriver(fakeDriver)
        DatabaseInspector.shared.setEnabled(true)

        let request = SdkExecuteSqlRequest(
            databasePath: "/app/Documents/misspelled.db",
            query: "INSERT INTO notes (title) VALUES ('new')"
        )
        let body = try JSONEncoder().encode(request)

        let response = SdkDatabaseRouteHandler().handleExecuteSql(body: body)

        XCTAssertEqual(response.statusCode, 404)
        let payload = try JSONDecoder().decode(SdkDatabaseErrorPayload.self, from: response.body)
        XCTAssertEqual(payload.error, "unknown_database_path")
        XCTAssertEqual(fakeDriver.executeSqlCalls.count, 0)
    }

    func testTableDataRejectsUnknownTableBeforeOpeningSqlite() throws {
        let fakeDriver = RouteFakeDatabaseDriver()
        fakeDriver.databases = [
            DatabaseDescriptor(name: "app.db", path: "/app/Documents/app.db", sizeBytes: 1024),
        ]
        fakeDriver.tablesByDatabase = ["/app/Documents/app.db": ["notes"]]
        DatabaseInspector.shared.initialize()
        DatabaseInspector.shared.setDriver(fakeDriver)
        DatabaseInspector.shared.setEnabled(true)

        let request = SdkTableDataRequest(
            databasePath: "/app/Documents/app.db",
            table: "notess",
            limit: 50,
            offset: 0
        )
        let body = try JSONEncoder().encode(request)

        let response = SdkDatabaseRouteHandler().handleTableData(body: body)

        XCTAssertEqual(response.statusCode, 404)
        let payload = try JSONDecoder().decode(SdkDatabaseErrorPayload.self, from: response.body)
        XCTAssertEqual(payload.error, "unknown_table")
        XCTAssertEqual(fakeDriver.tableDataCalls.count, 0)
    }

    func testTableStructureRejectsUnknownTableBeforeOpeningSqlite() throws {
        let fakeDriver = RouteFakeDatabaseDriver()
        fakeDriver.databases = [
            DatabaseDescriptor(name: "app.db", path: "/app/Documents/app.db", sizeBytes: 1024),
        ]
        fakeDriver.tablesByDatabase = ["/app/Documents/app.db": ["notes"]]
        DatabaseInspector.shared.initialize()
        DatabaseInspector.shared.setDriver(fakeDriver)
        DatabaseInspector.shared.setEnabled(true)

        let request = SdkTableStructureRequest(
            databasePath: "/app/Documents/app.db",
            table: "notess"
        )
        let body = try JSONEncoder().encode(request)

        let response = SdkDatabaseRouteHandler().handleTableStructure(body: body)

        XCTAssertEqual(response.statusCode, 404)
        let payload = try JSONDecoder().decode(SdkDatabaseErrorPayload.self, from: response.body)
        XCTAssertEqual(payload.error, "unknown_table")
        XCTAssertEqual(fakeDriver.tableStructureCalls.count, 0)
    }

    func testExecuteSqlReturnsDisabledWhenInspectorNotEnabled() throws {
        DatabaseInspector.shared.initialize()
        DatabaseInspector.shared.setEnabled(false)
        let body = try JSONEncoder().encode(SdkExecuteSqlRequest(databasePath: "/db.sqlite", query: "SELECT 1"))

        let response = SdkDatabaseRouteHandler().handleExecuteSql(body: body)

        XCTAssertEqual(response.statusCode, 503)
        let payload = try JSONDecoder().decode(SdkDatabaseErrorPayload.self, from: response.body)
        XCTAssertEqual(payload.error, "db_inspection_disabled")
    }
}

final class SQLiteDatabaseDriverConcurrencyTests: XCTestCase {
    private var filesToDelete: [URL] = []

    override func tearDown() {
        for file in filesToDelete {
            try? FileManager.default.removeItem(at: file)
        }
        filesToDelete.removeAll()
        super.tearDown()
    }

    func testSerializesParallelReadsAndWritesThroughOneDriver() throws {
        let databaseURL = try createDatabase()
        let driver = SQLiteDatabaseDriver()
        let queue = DispatchQueue(label: "sqlite-driver-concurrency", attributes: .concurrent)
        let group = DispatchGroup()
        let errors = LockedErrors()

        for index in 0 ..< 80 {
            group.enter()
            queue.async {
                defer { group.leave() }

                if index % 4 == 0 {
                    let result = driver.executeSQL(
                        databasePath: databaseURL.path,
                        query: "UPDATE items SET value = value + 1 WHERE id = 1"
                    )
                    if let error = result.error {
                        errors.append(error)
                    }
                } else {
                    let result = driver.getTableData(
                        databasePath: databaseURL.path,
                        table: "items",
                        limit: 10,
                        offset: 0
                    )
                    if result.columns != ["id", "value"] {
                        errors.append("unexpected columns: \(result.columns)")
                    }
                    if result.totalRows != 1 {
                        errors.append("unexpected total rows: \(result.totalRows)")
                    }
                }
            }
        }

        XCTAssertEqual(group.wait(timeout: .now() + 10), .success)
        let finalData = driver.getTableData(
            databasePath: databaseURL.path,
            table: "items",
            limit: 10,
            offset: 0
        )
        XCTAssertEqual(finalData.rows.first?[1], "20")

        driver.closeAll()
        XCTAssertTrue(errors.all.isEmpty, errors.all.joined(separator: "\n"))
    }

    private func createDatabase() throws -> URL {
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent("auto-mobile-\(UUID().uuidString).sqlite")
        filesToDelete.append(file)

        var db: OpaquePointer?
        let openResult = sqlite3_open(file.path, &db)
        XCTAssertEqual(openResult, SQLITE_OK)
        guard openResult == SQLITE_OK, let db else {
            throw NSError(domain: "SQLiteDatabaseDriverConcurrencyTests", code: 1)
        }
        defer { sqlite3_close(db) }

        try executeSQL(db, "CREATE TABLE items (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)")
        try executeSQL(db, "INSERT INTO items (id, value) VALUES (1, 0)")

        return file
    }

    private func executeSQL(_ db: OpaquePointer, _ sql: String) throws {
        var errorMessage: UnsafeMutablePointer<CChar>?
        let result = sqlite3_exec(db, sql, nil, nil, &errorMessage)
        defer { sqlite3_free(errorMessage) }

        XCTAssertEqual(result, SQLITE_OK)
        guard result == SQLITE_OK else {
            let message = errorMessage.map { String(cString: $0) } ?? "Unknown SQLite error"
            throw NSError(
                domain: "SQLiteDatabaseDriverConcurrencyTests",
                code: Int(result),
                userInfo: [NSLocalizedDescriptionKey: message]
            )
        }
    }
}

private final class RouteFakeDatabaseDriver: DatabaseDriver, @unchecked Sendable {
    var databases: [DatabaseDescriptor] = []
    var tablesByDatabase: [String: [String]] = [:]
    var sqlResult = SQLExecutionResult(columns: nil, rows: nil, rowsAffected: 0)
    var executeSqlCalls: [(databasePath: String, query: String)] = []
    var tableDataCalls: [SdkTableDataRequest] = []
    var tableStructureCalls: [(databasePath: String, table: String)] = []

    func getDatabases() -> [DatabaseDescriptor] {
        databases
    }

    func getTables(databasePath: String) -> [String] {
        tablesByDatabase[databasePath] ?? []
    }

    func getTableData(databasePath: String, table: String, limit: Int, offset: Int) -> TableDataResult {
        tableDataCalls.append(SdkTableDataRequest(
            databasePath: databasePath,
            table: table,
            limit: limit,
            offset: offset
        ))
        return TableDataResult(columns: [], rows: [], totalRows: 0)
    }

    func getTableStructure(databasePath: String, table: String) -> TableStructureResult {
        tableStructureCalls.append((databasePath: databasePath, table: table))
        return TableStructureResult(columns: [])
    }

    func executeSQL(databasePath: String, query: String) -> SQLExecutionResult {
        executeSqlCalls.append((databasePath: databasePath, query: query))
        return sqlResult
    }
}

private final class LockedErrors: @unchecked Sendable {
    private let lock = NSLock()
    private var messages: [String] = []

    var all: [String] {
        lock.lock()
        defer { lock.unlock() }
        return messages
    }

    func append(_ message: String) {
        lock.lock()
        defer { lock.unlock() }
        messages.append(message)
    }
}
