@testable import AutoMobileSDK
import SQLite3
import XCTest

/// #10165: a database the app holds locked (rollback-journal `BEGIN EXCLUSIVE`) used to read as an empty
/// table list, `unknown_table`, or `mutation_not_authorized` for a plain SELECT.
final class SQLiteDatabaseBusyTests: XCTestCase {
    private var fixture: SQLiteTestFixture!
    private var driver: SQLiteDatabaseDriver!
    private var appConnection: OpaquePointer?

    override func setUpWithError() throws {
        try super.setUpWithError()
        fixture = try SQLiteTestFixture()
        try fixture.createDatabase(value: "row")
        driver = SQLiteDatabaseDriver(
            searchPaths: [fixture.directoryURL.path],
            busyBudget: SQLiteBusyBudget(classifierMs: 5, readMs: 5, writeMs: 5)
        )
        DatabaseInspector.shared.initialize()
        DatabaseInspector.shared.setDriver(driver)
        DatabaseInspector.shared.configure(StorageInspectionConfiguration(allowedDatabasePaths: [fixture.path]))
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

    private func assertBusy(_ response: SdkRouteResponse, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(response.statusCode, 503, file: file, line: line)
        let payload = try JSONDecoder().decode(SdkDatabaseErrorPayload.self, from: response.body)
        XCTAssertEqual(payload.error, "busy_lock", file: file, line: line)
        XCTAssertEqual(payload.diagnostic?.code, "busy_lock", file: file, line: line)
    }

    func testListTablesRouteReportsBusyNotAnEmptyList() throws {
        try holdAppLock()
        let body = try JSONEncoder().encode(SdkDatabasePathRequest(databasePath: fixture.path))
        try assertBusy(SdkDatabaseRouteHandler().handleListTables(body: body))
    }

    func testTableDataAndStructureRoutesReportBusyNotUnknownTable() throws {
        // Cache the read-only connection while the database is free, like a normal inspection session.
        XCTAssertEqual(driver.getTables(databasePath: fixture.path), ["t"])
        try holdAppLock()
        let handler = SdkDatabaseRouteHandler()

        let dataBody = try JSONEncoder().encode(
            SdkTableDataRequest(databasePath: fixture.path, table: "t", limit: 10, offset: 0)
        )
        try assertBusy(handler.handleTableData(body: dataBody))

        let structureBody = try JSONEncoder().encode(
            SdkTableStructureRequest(databasePath: fixture.path, table: "t")
        )
        try assertBusy(handler.handleTableStructure(body: structureBody))
    }

    func testSelectRouteReportsBusyNotMutationNotAuthorized() throws {
        try holdAppLock()
        let body = try JSONEncoder().encode(SdkExecuteSqlRequest(databasePath: fixture.path, query: "SELECT * FROM t"))
        try assertBusy(SdkDatabaseRouteHandler().handleExecuteSql(body: body))
    }

    func testDriverReportsBusyDiagnosticsInsteadOfEmptyResults() throws {
        XCTAssertEqual(driver.getTables(databasePath: fixture.path), ["t"])
        try holdAppLock()

        let tables = driver.tablesResult(databasePath: fixture.path)
        XCTAssertEqual(tables.tables, [])
        XCTAssertEqual(tables.diagnostic?.code, "busy_lock")

        let structure = driver.getTableStructure(databasePath: fixture.path, table: "t")
        XCTAssertTrue(structure.columns.isEmpty)
        XCTAssertEqual(structure.diagnostic?.code, "busy_lock")

        let select = driver.executeSQL(databasePath: fixture.path, query: "SELECT * FROM t")
        XCTAssertEqual(select.diagnostic?.code, "busy_lock")
        XCTAssertNil(select.rows)
    }

    func testClassifierDistinguishesBusyFromAWriteStatement() throws {
        try holdAppLock()
        let select = driver.classify(databasePath: fixture.path, query: "SELECT * FROM t")
        XCTAssertTrue(select.isBusy)
        XCTAssertFalse(SQLiteDatabaseDriver.isBusy(SQLITE_ERROR))
        XCTAssertTrue(SQLiteDatabaseDriver.isBusy(SQLITE_BUSY))
        XCTAssertTrue(SQLiteDatabaseDriver.isBusy(SQLITE_LOCKED))
        releaseAppLock()

        let free = driver.classify(databasePath: fixture.path, query: "SELECT * FROM t")
        XCTAssertFalse(free.isBusy)
        XCTAssertTrue(free.readOnly)
        let missingTable = driver.classify(databasePath: fixture.path, query: "SELECT * FROM ghost")
        XCTAssertFalse(missingTable.isBusy, "an unprepared statement that is not locked stays conservatively a write")
    }

    func testLockReleasedWithinTheBudgetIsWaitedOut() throws {
        let patient = SQLiteDatabaseDriver(
            searchPaths: [fixture.directoryURL.path],
            busyBudget: SQLiteBusyBudget(classifierMs: 2000, readMs: 2000, writeMs: 2000)
        )
        defer { patient.closeAll() }
        try holdAppLock()
        let holder = try XCTUnwrap(appConnection)
        appConnection = nil
        nonisolated(unsafe) let unsafeHolder = holder
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(80)) {
            sqlite3_exec(unsafeHolder, "ROLLBACK", nil, nil, nil)
            sqlite3_close(unsafeHolder)
        }

        let result = patient.tablesResult(databasePath: fixture.path)
        XCTAssertEqual(result.tables, ["t"])
        XCTAssertNil(result.diagnostic)
    }
}
