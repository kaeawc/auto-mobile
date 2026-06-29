@testable import AutoMobileSDK
import SQLite3
import XCTest

final class UserDefaultsInspectorTests: XCTestCase {
    override func tearDown() {
        UserDefaultsInspector.shared.reset()
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
