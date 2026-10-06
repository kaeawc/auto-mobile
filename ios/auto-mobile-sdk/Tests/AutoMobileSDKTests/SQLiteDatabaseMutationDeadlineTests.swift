@testable import AutoMobileSDK
import SQLite3
import XCTest

/// #10166: a mutation waiting on the app's write lock must stop waiting before the runner's relay gives
/// up (2 s), and must never run after that point, or the caller's retry applies it twice.
final class SQLiteDatabaseMutationDeadlineTests: XCTestCase {
    private var fixture: SQLiteTestFixture!
    private var appConnection: OpaquePointer?

    override func setUpWithError() throws {
        try super.setUpWithError()
        fixture = try SQLiteTestFixture()
        try fixture.createDatabase(value: "row")
    }

    override func tearDownWithError() throws {
        releaseAppLock()
        DatabaseInspector.shared.reset()
        fixture.cleanUp()
        try super.tearDownWithError()
    }

    private func makeDriver(writeMs: Int32 = 20) -> SQLiteDatabaseDriver {
        SQLiteDatabaseDriver(
            searchPaths: [fixture.directoryURL.path],
            busyBudget: SQLiteBusyBudget(classifierMs: 5, readMs: 5, writeMs: writeMs)
        )
    }

    /// The app's own write transaction: readers still work, other writers are locked out.
    private func holdAppWriteLock() throws {
        let connection = try fixture.openRaw()
        try SQLiteTestFixture.exec(connection, "BEGIN IMMEDIATE")
        appConnection = connection
    }

    private func releaseAppLock() {
        guard let connection = appConnection else { return }
        sqlite3_exec(connection, "ROLLBACK", nil, nil, nil)
        sqlite3_close(connection)
        appConnection = nil
    }

    func testMutationThatCannotGetTheLockInTimeReportsBusyAndIsNotAppliedLater() throws {
        let driver = makeDriver(writeMs: 30)
        defer { driver.closeAll() }
        try holdAppWriteLock()

        let result = driver.executeSQL(databasePath: fixture.path, query: "INSERT INTO t (v) VALUES ('dup')")

        XCTAssertEqual(result.diagnostic?.code, "busy_lock")
        XCTAssertEqual(result.rowsAffected, 0)
        // Keep the app's lock until the call returns, regardless of runner scheduling.
        releaseAppLock()
        XCTAssertEqual(try fixture.values(), ["row"], "a mutation reported as busy must not be applied afterwards")
    }

    func testMutationAfterItsDeadlineNeverStarts() throws {
        let driver = SQLiteDatabaseDriver(searchPaths: [fixture.directoryURL.path], now: { 100 })
        defer { driver.closeAll() }

        let late = driver.executeSQL(
            databasePath: fixture.path,
            query: "INSERT INTO t (v) VALUES ('late')",
            deadline: 99
        )
        XCTAssertEqual(late.diagnostic?.code, "busy_lock")
        XCTAssertEqual(try fixture.values(), ["row"])

        let inTime = driver.executeSQL(
            databasePath: fixture.path,
            query: "INSERT INTO t (v) VALUES ('on time')",
            deadline: 105
        )
        XCTAssertNil(inTime.error)
        XCTAssertEqual(try fixture.values(), ["row", "on time"])
    }

    func testReadIgnoresTheMutationDeadline() throws {
        let driver = SQLiteDatabaseDriver(searchPaths: [fixture.directoryURL.path], now: { 100 })
        defer { driver.closeAll() }
        let result = driver.executeSQL(
            databasePath: fixture.path,
            query: "SELECT v FROM t",
            deadline: 99
        )
        XCTAssertEqual(result.rows, [["row"]])
    }

    func testDeadlineCutsTheWaitBelowTheWriteBudget() throws {
        let readings = ScriptedClock([100, 100, 100, 200, 200, 200])
        let driver = SQLiteDatabaseDriver(
            searchPaths: [fixture.directoryURL.path],
            busyBudget: SQLiteBusyBudget(classifierMs: 5, readMs: 5, writeMs: 10000),
            now: { readings.next() }
        )
        defer { driver.closeAll() }

        // SQLite exposes the timeout installed on this write connection at step, without measuring
        // elapsed wall time. 62.5 ms rounds up to 63 ms, far below the 10 s write budget.
        let observed = driver.executeSQL(
            databasePath: fixture.path,
            query: "INSERT INTO t (v) SELECT timeout FROM pragma_busy_timeout",
            deadline: 100.0625
        )
        XCTAssertNil(observed.error)
        XCTAssertEqual(observed.rowsAffected, 1)
        XCTAssertEqual(try fixture.values(), ["row", "63"])
        try holdAppWriteLock()
        let result = driver.executeSQL(
            databasePath: fixture.path,
            query: "INSERT INTO t (v) VALUES ('x')",
            deadline: 200.0625
        )

        XCTAssertEqual(result.diagnostic?.code, "busy_lock")
        XCTAssertEqual(result.rowsAffected, 0)
        releaseAppLock()
        XCTAssertEqual(try fixture.values(), ["row", "63"])
    }

    func testRouteBoundsAMutationByTheRelayTimeoutTheRunnerSends() throws {
        let driver = makeDriver(writeMs: 10000)
        defer { driver.closeAll() }
        let sessionId = "session-1"
        DatabaseInspector.shared.initialize()
        DatabaseInspector.shared.setDriver(driver)
        DatabaseInspector.shared.configure(StorageInspectionConfiguration(
            allowedDatabasePaths: [fixture.path],
            allowMutations: true
        ))
        DatabaseInspector.shared.authorizeHostMutations(true)
        DatabaseInspector.shared.authorizeSessionMutations(sessionId: sessionId)
        DatabaseInspector.shared.setEnabled(true)
        let handler = SdkDatabaseRouteHandler(currentSessionId: { sessionId })
        try holdAppWriteLock()

        let body = try JSONEncoder().encode(SdkExecuteSqlRequest(
            databasePath: fixture.path,
            query: "INSERT INTO t (v) VALUES ('x')",
            sessionId: sessionId,
            relayTimeoutMs: 40
        ))
        let response = handler.handleExecuteSql(body: body)

        XCTAssertEqual(response.statusCode, 503)
        XCTAssertEqual(try JSONDecoder().decode(SdkDatabaseErrorPayload.self, from: response.body).error, "busy_lock")
        releaseAppLock()
        XCTAssertEqual(try fixture.values(), ["row"])

        // Time spent queued before the handler ran counts against the same deadline.
        let queuedTooLong = handler.handleExecuteSql(body: body, receivedAt: SdkDatabaseBudget.now() - 10)
        XCTAssertEqual(queuedTooLong.statusCode, 503)
        XCTAssertEqual(try fixture.values(), ["row"])
    }

    // MARK: - One budget across open, prepare and step

    func testWriteWaitSharesOneBudgetAndNeverExceedsTheDeadline() {
        let budgetOnly = WriteWait(budgetEnd: 100.8, deadline: nil, now: { 100 })
        XCTAssertEqual(budgetOnly.remainingMs(), 800)
        XCTAssertEqual(
            WriteWait(budgetEnd: 100.8, deadline: nil, now: { 100.3 }).remainingMs(),
            500,
            "time already spent is not granted again"
        )
        XCTAssertEqual(
            WriteWait(budgetEnd: 100.8, deadline: nil, now: { 101 }).remainingMs(),
            0,
            "an exhausted budget means no waiting, not a fresh budget"
        )

        XCTAssertEqual(
            WriteWait(budgetEnd: 100.8, deadline: 100.25, now: { 100 }).remainingMs(),
            250,
            "the deadline cuts the budget"
        )
        XCTAssertNil(
            WriteWait(budgetEnd: 100.8, deadline: 100.25, now: { 100.25 }).remainingMs(),
            "at the deadline nothing may start"
        )
        XCTAssertNil(WriteWait(budgetEnd: 100.8, deadline: 100.25, now: { 100.9 }).remainingMs())
    }

    /// Prepare ran on a fresh connection and spent 250 ms of a 300 ms budget; step must get the 50 ms
    /// that is left, not another 300 ms. The scripted clock stands in for the time prepare spent,
    /// because a lock that blocks prepare also blocks the classifier that runs before it.
    func testStepWaitsOnlyForWhatPrepareLeftOfTheBudget() throws {
        let readings = ScriptedClock([100, 100, 100.25, 200, 200, 200.25])
        let driver = SQLiteDatabaseDriver(
            searchPaths: [fixture.directoryURL.path],
            busyBudget: SQLiteBusyBudget(classifierMs: 5, readMs: 5, writeMs: 300),
            now: { readings.next() }
        )
        defer { driver.closeAll() }

        // The INSERT reads its own connection's busy timeout when it steps. This catches a fresh
        // 300 ms budget (or a missing re-arm after prepare) without a scheduler-dependent threshold.
        let observed = driver.executeSQL(
            databasePath: fixture.path,
            query: "INSERT INTO t (v) SELECT timeout FROM pragma_busy_timeout",
            deadline: nil
        )
        XCTAssertNil(observed.error)
        XCTAssertEqual(observed.rowsAffected, 1)
        XCTAssertEqual(try fixture.values(), ["row", "50"])
        try holdAppWriteLock()
        let result = driver.executeSQL(
            databasePath: fixture.path,
            query: "INSERT INTO t (v) VALUES ('x')",
            deadline: nil
        )

        XCTAssertEqual(result.diagnostic?.code, "busy_lock")
        XCTAssertEqual(result.rowsAffected, 0)
        releaseAppLock()
        XCTAssertEqual(try fixture.values(), ["row", "50"])
    }

    func testStepDoesNotStartOnceThePrepareLeftNothingBeforeTheDeadline() throws {
        let readings = ScriptedClock([100, 100, 100.5])
        let driver = SQLiteDatabaseDriver(
            searchPaths: [fixture.directoryURL.path],
            busyBudget: SQLiteBusyBudget(classifierMs: 5, readMs: 5, writeMs: 800),
            now: { readings.next() }
        )
        defer { driver.closeAll() }

        // The deadline passed while prepare ran: the statement exists but is never stepped.
        let result = driver.executeSQL(
            databasePath: fixture.path,
            query: "INSERT INTO t (v) VALUES ('late')",
            deadline: 100.4
        )

        XCTAssertEqual(result.diagnostic?.code, "busy_lock")
        XCTAssertEqual(try fixture.values(), ["row"], "a statement that was not stepped must not be applied")
    }

    func testMutationDeadlineIsAShareOfTheRelayTimeoutWithMargin() {
        let received: TimeInterval = 100
        XCTAssertEqual(
            SdkDatabaseBudget.mutationDeadline(receivedAt: received, relayTimeoutMs: 2000),
            101.5,
            accuracy: 1e-9
        )
        XCTAssertEqual(
            SdkDatabaseBudget.mutationDeadline(receivedAt: received, relayTimeoutMs: 400),
            100.3,
            accuracy: 1e-9
        )
        // An older runner sends nothing: assume the runner's historical 2 s timeout.
        let fallback = SdkDatabaseBudget.mutationDeadline(receivedAt: received, relayTimeoutMs: nil)
        XCTAssertEqual(fallback, 101.5, accuracy: 1e-9)
        XCTAssertEqual(
            SdkDatabaseBudget.mutationDeadline(receivedAt: received, relayTimeoutMs: 0),
            fallback,
            accuracy: 1e-9
        )
        XCTAssertLessThan(
            fallback - received,
            Double(SdkDatabaseBudget.defaultRelayTimeoutMs) / 1000,
            "a mutation must give up before the relay does"
        )
    }

    func testRequestWithoutRelayTimeoutStillDecodes() throws {
        let legacy = Data(#"{"databasePath":"/db","query":"SELECT 1"}"#.utf8)
        let request = try JSONDecoder().decode(SdkExecuteSqlRequest.self, from: legacy)
        XCTAssertNil(request.relayTimeoutMs)
        let current = Data(#"{"databasePath":"/db","query":"SELECT 1","relayTimeoutMs":2000}"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode(SdkExecuteSqlRequest.self, from: current).relayTimeoutMs, 2000)
    }
}

/// Returns the scripted instants in order, then keeps returning the last one.
private final class ScriptedClock: @unchecked Sendable {
    private let lock = NSLock()
    private var readings: [TimeInterval]

    init(_ readings: [TimeInterval]) {
        self.readings = readings
    }

    func next() -> TimeInterval {
        lock.lock()
        defer { lock.unlock() }
        return readings.count > 1 ? readings.removeFirst() : readings[0]
    }
}
