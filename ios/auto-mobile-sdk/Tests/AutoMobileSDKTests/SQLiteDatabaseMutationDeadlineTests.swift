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
        let holder = try XCTUnwrap(appConnection)
        appConnection = nil
        nonisolated(unsafe) let unsafeHolder = holder
        let released = DispatchSemaphore(value: 0)
        // The app commits well after the SDK's wait: the old 5 s wait would have run the INSERT then.
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(100)) {
            sqlite3_exec(unsafeHolder, "ROLLBACK", nil, nil, nil)
            sqlite3_close(unsafeHolder)
            released.signal()
        }

        let result = driver.executeSQL(databasePath: fixture.path, query: "INSERT INTO t (v) VALUES ('dup')")

        XCTAssertEqual(result.diagnostic?.code, "busy_lock")
        XCTAssertEqual(result.rowsAffected, 0)
        XCTAssertEqual(released.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(try fixture.values(), ["row"], "a mutation reported as busy must not be applied afterwards")
    }

    func testMutationAfterItsDeadlineNeverStarts() throws {
        let driver = makeDriver()
        defer { driver.closeAll() }

        let late = driver.executeSQL(
            databasePath: fixture.path,
            query: "INSERT INTO t (v) VALUES ('late')",
            deadline: SdkDatabaseBudget.now() - 1
        )
        XCTAssertEqual(late.diagnostic?.code, "busy_lock")
        XCTAssertEqual(try fixture.values(), ["row"])

        let inTime = driver.executeSQL(
            databasePath: fixture.path,
            query: "INSERT INTO t (v) VALUES ('on time')",
            deadline: SdkDatabaseBudget.now() + 5
        )
        XCTAssertNil(inTime.error)
        XCTAssertEqual(try fixture.values(), ["row", "on time"])
    }

    func testReadIgnoresTheMutationDeadline() throws {
        let driver = makeDriver()
        defer { driver.closeAll() }
        let result = driver.executeSQL(
            databasePath: fixture.path,
            query: "SELECT v FROM t",
            deadline: SdkDatabaseBudget.now() - 1
        )
        XCTAssertEqual(result.rows, [["row"]])
    }

    func testDeadlineCutsTheWaitBelowTheWriteBudget() throws {
        let driver = makeDriver(writeMs: 10000)
        defer { driver.closeAll() }
        try holdAppWriteLock()

        let started = Date()
        let result = driver.executeSQL(
            databasePath: fixture.path,
            query: "INSERT INTO t (v) VALUES ('x')",
            deadline: SdkDatabaseBudget.now() + 0.05
        )

        XCTAssertEqual(result.diagnostic?.code, "busy_lock")
        XCTAssertLessThan(
            Date().timeIntervalSince(started),
            3,
            "the wait must follow the deadline, not the write budget"
        )
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
