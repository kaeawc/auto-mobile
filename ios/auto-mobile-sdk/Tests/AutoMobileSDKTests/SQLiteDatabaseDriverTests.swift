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
