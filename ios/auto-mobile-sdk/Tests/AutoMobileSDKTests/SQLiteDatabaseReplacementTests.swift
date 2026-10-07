@testable import AutoMobileSDK
import XCTest

/// #10164: the driver caches one connection per path; a database the app deleted and recreated must
/// be served from the file that is now at the path, not from the unlinked one.
final class SQLiteDatabaseReplacementTests: XCTestCase {
    private var fixture: SQLiteTestFixture!
    private var driver: SQLiteDatabaseDriver!

    override func setUpWithError() throws {
        try super.setUpWithError()
        fixture = try SQLiteTestFixture()
        driver = SQLiteDatabaseDriver(searchPaths: [fixture.directoryURL.path])
    }

    override func tearDownWithError() throws {
        driver.closeAll()
        fixture.cleanUp()
        try super.tearDownWithError()
    }

    func testReadsServeTheRecreatedDatabase() throws {
        try fixture.createDatabase(value: "old")
        XCTAssertEqual(
            driver.getTableData(databasePath: fixture.path, table: "t", limit: 10, offset: 0).rows,
            [["old"]]
        )

        try fixture.deleteDatabase()
        try fixture.createDatabase(value: "new")

        XCTAssertEqual(
            driver.getTableData(databasePath: fixture.path, table: "t", limit: 10, offset: 0).rows,
            [["new"]]
        )
        XCTAssertEqual(driver.executeSQL(databasePath: fixture.path, query: "SELECT v FROM t").rows, [["new"]])
        XCTAssertEqual(driver.getTables(databasePath: fixture.path), ["t"])
        XCTAssertEqual(driver.getTableStructure(databasePath: fixture.path, table: "t").columns.map(\.name), ["v"])
    }

    func testWritesLandInTheRecreatedDatabase() throws {
        try fixture.createDatabase(value: "old")
        XCTAssertNil(driver.executeSQL(databasePath: fixture.path, query: "UPDATE t SET v = 'x'").error)

        try fixture.deleteDatabase()
        try fixture.createDatabase(value: "new")

        let result = driver.executeSQL(databasePath: fixture.path, query: "UPDATE t SET v = 'y'")
        XCTAssertNil(result.error)
        XCTAssertEqual(result.rowsAffected, 1)
        XCTAssertEqual(try fixture.values(), ["y"])
    }

    func testDeletedDatabaseIsNotServedFromTheOldHandle() throws {
        try fixture.createDatabase(value: "old")
        XCTAssertEqual(
            driver.getTableData(databasePath: fixture.path, table: "t", limit: 10, offset: 0).rows,
            [["old"]]
        )
        XCTAssertEqual(driver.getTables(databasePath: fixture.path), ["t"])

        try fixture.deleteDatabase()

        let data = driver.getTableData(databasePath: fixture.path, table: "t", limit: 10, offset: 0)
        XCTAssertTrue(data.rows.isEmpty)
        XCTAssertEqual(data.diagnostic?.code, "store_unavailable")
        XCTAssertEqual(driver.getTables(databasePath: fixture.path), [])
        XCTAssertEqual(
            driver.getTableStructure(databasePath: fixture.path, table: "t").diagnostic?.code,
            "store_unavailable"
        )
    }

    func testDeletedDatabaseAnswersUnknownDatabasePathFromTheRoute() throws {
        try fixture.createDatabase(value: "old")
        DatabaseInspector.shared.initialize()
        DatabaseInspector.shared.setDriver(driver)
        DatabaseInspector.shared.configure(StorageInspectionConfiguration(allowedDatabasePaths: [fixture.path]))
        DatabaseInspector.shared.setEnabled(true)
        defer { DatabaseInspector.shared.reset() }
        let body = try JSONEncoder().encode(SdkDatabasePathRequest(databasePath: fixture.path))
        let handler = SdkDatabaseRouteHandler()
        XCTAssertEqual(handler.handleListTables(body: body).statusCode, 200)

        try fixture.deleteDatabase()

        let response = handler.handleListTables(body: body)
        XCTAssertEqual(response.statusCode, 404)
        XCTAssertEqual(
            try JSONDecoder().decode(SdkDatabaseErrorPayload.self, from: response.body).error,
            "unknown_database_path"
        )
    }

    func testUnchangedDatabaseKeepsItsCachedConnection() throws {
        try fixture.createDatabase(value: "old")
        // TEMP objects live on the connection that created them, so they only survive across calls
        // when the driver reuses the same read-write connection.
        XCTAssertNil(driver.executeSQL(databasePath: fixture.path, query: "CREATE TEMP TABLE scratch (x)").error)
        XCTAssertNil(driver.executeSQL(databasePath: fixture.path, query: "INSERT INTO scratch (x) VALUES (1)").error)
        XCTAssertNil(driver.executeSQL(databasePath: fixture.path, query: "UPDATE t SET v = 'edited'").error)
        XCTAssertNil(driver.executeSQL(databasePath: fixture.path, query: "INSERT INTO scratch (x) VALUES (2)").error)
        XCTAssertEqual(try fixture.values(), ["edited"])
    }
}
