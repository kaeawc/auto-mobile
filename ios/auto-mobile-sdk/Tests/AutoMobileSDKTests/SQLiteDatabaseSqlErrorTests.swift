@testable import AutoMobileSDK
import SQLite3
import XCTest

/// A real SQL error must reach the caller as itself. Busy is decided from SQLite's result code, never
/// from message text: an error that merely mentions "locked" or "busy" (a column, constraint or table
/// with that word in its name) used to be answered as a 503 `busy_lock` "retry in a moment".
final class SQLiteDatabaseSqlErrorTests: XCTestCase {
    private var fixture: SQLiteTestFixture!
    private var driver: SQLiteDatabaseDriver!
    private var appConnection: OpaquePointer?
    private let sessionId = "session-1"

    override func setUpWithError() throws {
        try super.setUpWithError()
        fixture = try SQLiteTestFixture()
        let connection = try fixture.openRaw()
        defer { sqlite3_close(connection) }
        try SQLiteTestFixture.exec(connection, "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)")
        try SQLiteTestFixture.exec(
            connection,
            "CREATE TABLE accounts (id INTEGER PRIMARY KEY, locked_by TEXT UNIQUE)"
        )
        try SQLiteTestFixture.exec(connection, "INSERT INTO users (name) VALUES ('ada')")
        try SQLiteTestFixture.exec(connection, "INSERT INTO accounts (locked_by) VALUES ('a'), ('b')")
        driver = SQLiteDatabaseDriver(
            searchPaths: [fixture.directoryURL.path],
            busyBudget: SQLiteBusyBudget(classifierMs: 5, readMs: 5, writeMs: 5)
        )
        DatabaseInspector.shared.initialize()
        DatabaseInspector.shared.setDriver(driver)
        DatabaseInspector.shared.configure(StorageInspectionConfiguration(
            allowedDatabasePaths: [fixture.path],
            allowMutations: true
        ))
        DatabaseInspector.shared.authorizeHostMutations(true)
        DatabaseInspector.shared.authorizeSessionMutations(sessionId: sessionId)
        DatabaseInspector.shared.setEnabled(true)
    }

    override func tearDownWithError() throws {
        releaseAppLock()
        DatabaseInspector.shared.reset()
        driver.closeAll()
        fixture.cleanUp()
        try super.tearDownWithError()
    }

    private func holdAppLock() throws {
        let connection = try fixture.openRaw()
        try SQLiteTestFixture.exec(connection, "BEGIN EXCLUSIVE")
        appConnection = connection
    }

    private func releaseAppLock() {
        guard let connection = appConnection else { return }
        sqlite3_exec(connection, "ROLLBACK", nil, nil, nil)
        sqlite3_close(connection)
        appConnection = nil
    }

    private func handler() -> SdkDatabaseRouteHandler {
        SdkDatabaseRouteHandler(currentSessionId: { [sessionId] in sessionId })
    }

    private func execute(_ query: String) throws -> SdkRouteResponse {
        let body = try JSONEncoder().encode(
            SdkExecuteSqlRequest(databasePath: fixture.path, query: query, sessionId: sessionId)
        )
        return handler().handleExecuteSql(body: body)
    }

    private static let lockWordStatements: [(query: String, message: String)] = [
        ("SELECT is_locked FROM users", "no such column: is_locked"),
        ("UPDATE accounts SET locked_by = 'a' WHERE id = 2", "UNIQUE constraint failed: accounts.locked_by"),
        ("SELECT * FROM busy_jobs", "no such table: busy_jobs"),
    ]

    func testDriverKeepsTheRealSqlErrorForStatementsThatMentionLockedOrBusy() {
        for (query, message) in Self.lockWordStatements {
            let result = driver.executeSQL(databasePath: fixture.path, query: query)
            XCTAssertEqual(result.error, message, query)
            XCTAssertNotEqual(result.diagnostic?.code, "busy_lock", query)
            XCTAssertEqual(result.diagnostic?.message, message, query)
        }
    }

    func testRouteAnswersTheRealSqlErrorNotA503ForStatementsThatMentionLockedOrBusy() throws {
        for (query, message) in Self.lockWordStatements {
            let response = try execute(query)
            XCTAssertEqual(response.statusCode, 200, query)
            let payload = try JSONDecoder().decode(SdkExecuteSqlPayload.self, from: response.body)
            XCTAssertEqual(payload.error, message, query)
            XCTAssertNotEqual(payload.diagnostic?.code, "busy_lock", query)
        }
    }

    func testATableNamedLikeTheLockWordsCanBeListedAndQueried() throws {
        let connection = try fixture.openRaw()
        try SQLiteTestFixture.exec(connection, "CREATE TABLE busy_jobs (id INTEGER PRIMARY KEY, is_locked INTEGER)")
        try SQLiteTestFixture.exec(connection, "INSERT INTO busy_jobs (is_locked) VALUES (1)")
        sqlite3_close(connection)

        XCTAssertTrue(driver.getTables(databasePath: fixture.path).contains("busy_jobs"))
        let data = driver.getTableData(databasePath: fixture.path, table: "busy_jobs", limit: 10, offset: 0)
        XCTAssertNil(data.diagnostic)
        XCTAssertEqual(data.columns, ["id", "is_locked"])
        XCTAssertEqual(data.rows, [["1", "1"]])
        let structure = driver.getTableStructure(databasePath: fixture.path, table: "busy_jobs")
        XCTAssertNil(structure.diagnostic)
        XCTAssertEqual(structure.columns.map(\.name), ["id", "is_locked"])

        let tablesBody = try JSONEncoder().encode(SdkDatabasePathRequest(databasePath: fixture.path))
        let tables = handler().handleListTables(body: tablesBody)
        XCTAssertEqual(tables.statusCode, 200)
        XCTAssertTrue(try JSONDecoder().decode(SdkTablesPayload.self, from: tables.body).tables.contains("busy_jobs"))
        let dataBody = try JSONEncoder().encode(
            SdkTableDataRequest(databasePath: fixture.path, table: "busy_jobs", limit: 10, offset: 0)
        )
        XCTAssertEqual(handler().handleTableData(body: dataBody).statusCode, 200)

        let query = try execute("SELECT * FROM busy_jobs WHERE is_locked = 1")
        XCTAssertEqual(query.statusCode, 200)
        let payload = try JSONDecoder().decode(SdkExecuteSqlPayload.self, from: query.body)
        XCTAssertNil(payload.error)
        XCTAssertEqual(payload.rows, [["1", "1"]])
    }

    func testGenuinelyLockedDatabaseStillAnswers503BusyLock() throws {
        XCTAssertTrue(driver.getTables(databasePath: fixture.path).contains("users"))
        try holdAppLock()
        let statements = [
            "SELECT * FROM users",
            "SELECT is_locked FROM users",
            "UPDATE accounts SET locked_by = 'z' WHERE id = 1",
        ]
        for query in statements {
            let response = try execute(query)
            XCTAssertEqual(response.statusCode, 503, query)
            let payload = try JSONDecoder().decode(SdkDatabaseErrorPayload.self, from: response.body)
            XCTAssertEqual(payload.error, "busy_lock", query)
        }
        let result = driver.executeSQL(databasePath: fixture.path, query: "UPDATE users SET name = 'x'")
        XCTAssertEqual(result.diagnostic?.code, "busy_lock")
    }
}
