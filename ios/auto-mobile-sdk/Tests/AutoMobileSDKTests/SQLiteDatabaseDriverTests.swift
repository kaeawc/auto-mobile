@testable import AutoMobileSDK
import SQLite3
import XCTest

final class SQLiteDatabaseDriverTests: XCTestCase {
    private var databaseURL: URL!
    private var driver: SQLiteDatabaseDriver!

    override func setUpWithError() throws {
        try super.setUpWithError()
        databaseURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("db")
        driver = SQLiteDatabaseDriver()

        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(databaseURL.path, &db), SQLITE_OK)
        defer { sqlite3_close(db) }
        sqlite3_exec(db, "CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)", nil, nil, nil)
        sqlite3_exec(db, "INSERT INTO notes (body) VALUES ('alpha'), ('beta'), ('gamma')", nil, nil, nil)
    }

    override func tearDownWithError() throws {
        driver.closeAll()
        try? FileManager.default.removeItem(at: databaseURL)
        try super.tearDownWithError()
    }

    func testInsertReturningReturnsInsertedRow() {
        let result = driver.executeSQL(
            databasePath: databaseURL.path,
            query: "INSERT INTO notes (body) VALUES ('delta') RETURNING id, body"
        )

        XCTAssertNil(result.error)
        XCTAssertEqual(result.columns, ["id", "body"])
        XCTAssertEqual(result.rows, [["4", "delta"]])
        XCTAssertEqual(result.rowsAffected, 1)
    }

    func testGetDatabasesDeduplicatesOverlappingSearchPaths() throws {
        let rootURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let nestedURL = rootURL
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Application Support", isDirectory: true)
        let databaseURL = nestedURL.appendingPathComponent("nested.sqlite")
        try FileManager.default.createDirectory(at: nestedURL, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: rootURL) }
        FileManager.default.createFile(atPath: databaseURL.path, contents: Data())

        let driver = SQLiteDatabaseDriver(searchPaths: [
            rootURL.appendingPathComponent("Library", isDirectory: true).path,
            nestedURL.path,
        ])

        let matches = driver.getDatabases().filter { $0.path == databaseURL.path }

        XCTAssertEqual(matches.count, 1)
    }

    func testUpdateReturningAppliesMutationAndReturnsChangedRow() {
        let result = driver.executeSQL(
            databasePath: databaseURL.path,
            query: "UPDATE notes SET body = 'beta2' WHERE body = 'beta' RETURNING id, body"
        )

        XCTAssertNil(result.error)
        XCTAssertEqual(result.columns, ["id", "body"])
        XCTAssertEqual(result.rows, [["2", "beta2"]])
        XCTAssertEqual(result.rowsAffected, 1)

        let verification = driver.executeSQL(
            databasePath: databaseURL.path,
            query: "SELECT body FROM notes WHERE id = 2"
        )
        XCTAssertEqual(verification.rows, [["beta2"]])
    }

    func testDeleteReturningReturnsDeletedRow() {
        let result = driver.executeSQL(
            databasePath: databaseURL.path,
            query: "DELETE FROM notes WHERE body = 'gamma' RETURNING id, body"
        )

        XCTAssertNil(result.error)
        XCTAssertEqual(result.columns, ["id", "body"])
        XCTAssertEqual(result.rows, [["3", "gamma"]])
        XCTAssertEqual(result.rowsAffected, 1)
    }

    func testCteWrappedUpdateReturningReturnsChangedRow() {
        let result = driver.executeSQL(
            databasePath: databaseURL.path,
            query: """
            WITH target AS (
              SELECT id FROM notes WHERE body = 'alpha'
            )
            UPDATE notes SET body = 'alpha2'
            WHERE id IN (SELECT id FROM target)
            RETURNING id, body
            """
        )

        XCTAssertNil(result.error)
        XCTAssertEqual(result.columns, ["id", "body"])
        XCTAssertEqual(result.rows, [["1", "alpha2"]])
        XCTAssertEqual(result.rowsAffected, 1)
    }

    func testCteReplaceFormsExecuteAsWrites() {
        let queries = [
            "WITH target AS (SELECT 1 AS id) REPLACE INTO notes (id, body) SELECT id, 'first' FROM target",
            "WITH target AS (SELECT 1 AS id) INSERT OR REPLACE INTO notes (id, body) SELECT id, 'second' FROM target",
        ]

        for query in queries {
            let classification = SQLiteDatabaseDriver.classifySQL(databasePath: databaseURL.path, query: query)
            XCTAssertFalse(classification.readOnly)
            let result = driver.executeSQL(databasePath: databaseURL.path, query: query)
            XCTAssertNil(result.error)
            XCTAssertEqual(result.rowsAffected, 1)
        }

        let result = driver.executeSQL(databasePath: databaseURL.path, query: "SELECT body FROM notes WHERE id = 1")
        XCTAssertEqual(result.rows, [["second"]])
    }

    func testUnavailableDatabaseClassificationIsConservative() {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("db")

        let classification = SQLiteDatabaseDriver.classifySQL(databasePath: path.path, query: "SELECT 1")

        XCTAssertFalse(classification.readOnly)
    }

    func testReturningInsideStringLiteralDoesNotMakeMutationReturnRows() {
        let result = driver.executeSQL(
            databasePath: databaseURL.path,
            query: "UPDATE notes SET body = 'not RETURNING syntax' WHERE body = 'alpha'"
        )

        XCTAssertNil(result.error)
        XCTAssertNil(result.columns)
        XCTAssertNil(result.rows)
        XCTAssertEqual(result.rowsAffected, 1)
    }

    func testDdlWithInnerSelectUsesMutationPath() {
        let createTable = driver.executeSQL(
            databasePath: databaseURL.path,
            query: "CREATE TABLE notes_backup AS SELECT * FROM notes"
        )
        let createView = driver.executeSQL(
            databasePath: databaseURL.path,
            query: "CREATE VIEW notes_view AS SELECT * FROM notes"
        )

        XCTAssertNil(createTable.error)
        XCTAssertNil(createTable.columns)
        XCTAssertNil(createTable.rows)
        XCTAssertNil(createView.error)
        XCTAssertNil(createView.columns)
        XCTAssertNil(createView.rows)
    }

    func testReturningWriteSurfacesStepError() {
        let result = driver.executeSQL(
            databasePath: databaseURL.path,
            query: "INSERT INTO notes (id, body) VALUES (1, 'duplicate') RETURNING id, body"
        )

        XCTAssertNotNil(result.error)
        XCTAssertNil(result.columns)
        XCTAssertNil(result.rows)
        XCTAssertEqual(result.rowsAffected, 0)
    }
}

final class SQLiteDatabaseRouteClassificationTests: XCTestCase {
    private var directoryURL: URL!
    private var databaseURL: URL!
    private var driver: SQLiteDatabaseDriver!

    override func setUpWithError() throws {
        try super.setUpWithError()
        directoryURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        databaseURL = directoryURL.appendingPathComponent("notes.db")

        var connection: OpaquePointer?
        XCTAssertEqual(sqlite3_open(databaseURL.path, &connection), SQLITE_OK)
        defer { sqlite3_close(connection) }
        XCTAssertEqual(
            sqlite3_exec(connection, "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)", nil, nil, nil),
            SQLITE_OK
        )
        XCTAssertEqual(sqlite3_exec(connection, "INSERT INTO notes VALUES (1, 'original')", nil, nil, nil), SQLITE_OK)

        driver = SQLiteDatabaseDriver(searchPaths: [directoryURL.path])
        DatabaseInspector.shared.initialize()
        DatabaseInspector.shared.setDriver(driver)
        DatabaseInspector.shared.configure(StorageInspectionConfiguration(allowedDatabasePaths: [databaseURL.path]))
        DatabaseInspector.shared.setEnabled(true)
    }

    override func tearDownWithError() throws {
        DatabaseInspector.shared.reset()
        driver.closeAll()
        try? FileManager.default.removeItem(at: directoryURL)
        try super.tearDownWithError()
    }

    func testCteReplaceFormsRequireMutationAuthorization() throws {
        let queries = [
            "WITH target AS (SELECT 1 AS id) REPLACE INTO notes (id, body) SELECT id, 'first' FROM target",
            "WITH target AS (SELECT 1 AS id) INSERT OR REPLACE INTO notes (id, body) SELECT id, 'second' FROM target",
            "PRAGMA user_version = 7",
        ]

        for query in queries {
            let response = try routeResponse(query)
            XCTAssertEqual(response.statusCode, 403)
            let payload = try JSONDecoder().decode(SdkDatabaseErrorPayload.self, from: response.body)
            XCTAssertEqual(payload.error, "mutation_not_authorized")
        }

        let result = driver.executeSQL(databasePath: databaseURL.path, query: "SELECT body FROM notes WHERE id = 1")
        XCTAssertEqual(result.rows, [["original"]])
    }

    func testReadQueriesRemainAvailable() throws {
        let queries = [
            "SELECT body FROM notes WHERE id = 1",
            "WITH target AS (SELECT body FROM notes WHERE id = 1) SELECT body FROM target",
            "PRAGMA user_version",
            "SELECT ';' AS punctuation; -- trailing comment",
        ]

        for query in queries {
            let response = try routeResponse(query)
            XCTAssertEqual(response.statusCode, 200)
            let payload = try JSONDecoder().decode(SdkExecuteSqlPayload.self, from: response.body)
            XCTAssertNil(payload.error)
            XCTAssertNotNil(payload.rows)
        }
    }

    func testMultipleStatementsAreRejectedByRouteAndDriver() throws {
        let queries = [
            "SELECT body FROM notes; REPLACE INTO notes (id, body) VALUES (1, 'changed')",
            "SELECT body FROM notes; SELECT body FROM notes",
        ]
        for query in queries {
            let response = try routeResponse(query)
            XCTAssertEqual(response.statusCode, 400)
            let routePayload = try JSONDecoder().decode(SdkDatabaseErrorPayload.self, from: response.body)
            XCTAssertEqual(routePayload.error, "multiple_statements_not_supported")

            let driverResult = driver.executeSQL(databasePath: databaseURL.path, query: query)
            XCTAssertEqual(driverResult.diagnostic?.code, "multiple_statements_not_supported")
        }
        let verification = driver.executeSQL(
            databasePath: databaseURL.path,
            query: "SELECT body FROM notes WHERE id = 1"
        )
        XCTAssertEqual(verification.rows, [["original"]])
    }

    private func routeResponse(_ query: String) throws -> SdkRouteResponse {
        let body = try JSONEncoder().encode(SdkExecuteSqlRequest(databasePath: databaseURL.path, query: query))
        return SdkDatabaseRouteHandler().handleExecuteSql(body: body)
    }
}
