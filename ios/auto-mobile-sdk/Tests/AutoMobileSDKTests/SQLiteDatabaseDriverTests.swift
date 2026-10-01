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

    func testPlaygroundSeedTransactionIsIdempotentOnNewDatabase() throws {
        let directoryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        let databaseURL = directoryURL.appendingPathComponent("sessions.sqlite")
        let seedDriver = SQLiteDatabaseDriver()
        defer {
            seedDriver.closeAll()
            try? FileManager.default.removeItem(at: directoryURL)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: databaseURL.path))

        let statements = [
            "BEGIN IMMEDIATE TRANSACTION",
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                app_version TEXT,
                device_model TEXT,
                os_version TEXT
            )
            """,
            """
            INSERT INTO sessions (session_id, started_at, app_version, device_model, os_version)
            SELECT 'ios-playground-seed-001', 1704067200000, '0.0.50', 'iPhone Simulator', 'iOS 17.0'
            WHERE NOT EXISTS (
                SELECT 1 FROM sessions WHERE session_id = 'ios-playground-seed-001'
            )
            """,
            "COMMIT",
        ]

        for _ in 0 ..< 2 {
            for statement in statements {
                let result = seedDriver.executeSQL(databasePath: databaseURL.path, query: statement)
                XCTAssertNil(result.error, "\(statement): \(result.error ?? "")")
            }
        }

        let tableData = seedDriver.getTableData(databasePath: databaseURL.path, table: "sessions", limit: 10, offset: 0)
        XCTAssertNil(tableData.diagnostic)
        XCTAssertEqual(tableData.totalRows, 1)
        XCTAssertEqual(tableData.rows.first?[1], "ios-playground-seed-001")

        let selection = seedDriver.executeSQL(databasePath: databaseURL.path, query: "SELECT session_id FROM sessions")
        XCTAssertNil(selection.error)
        XCTAssertEqual(selection.rows, [["ios-playground-seed-001"]])
    }

    func testExplicitRollbackUndoesWrite() {
        let statements = [
            "BEGIN",
            "INSERT INTO notes (body) VALUES ('rolled back')",
            "ROLLBACK",
        ]
        for statement in statements {
            let result = driver.executeSQL(databasePath: databaseURL.path, query: statement)
            XCTAssertNil(result.error, "\(statement): \(result.error ?? "")")
        }

        let tableData = driver.getTableData(databasePath: databaseURL.path, table: "notes", limit: 10, offset: 0)
        XCTAssertNil(tableData.diagnostic)
        XCTAssertEqual(tableData.totalRows, 3)
        XCTAssertEqual(tableData.rows.compactMap { $0[1] }, ["alpha", "beta", "gamma"])
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

    func testSyntaxFallbackKeepsReadQueriesOffWriteConnection() {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("db")

        for query in ["SELECT 1", "EXPLAIN SELECT 1", "PRAGMA user_version"] {
            let classification = SQLiteDatabaseDriver.classifySQL(
                databasePath: path.path,
                query: query,
                allowSyntaxFallback: true
            )
            XCTAssertTrue(classification.readOnly, query)
            XCTAssertTrue(classification.returnsRows, query)
            XCTAssertFalse(classification.requiresWriteConnection, query)
        }

        for query in ["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT a", "PRAGMA user_version = 7"] {
            let classification = SQLiteDatabaseDriver.classifySQL(
                databasePath: path.path,
                query: query,
                allowSyntaxFallback: true
            )
            XCTAssertTrue(classification.requiresWriteConnection, query)
        }
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

    func testTransactionControlAndDdlReportZeroRowsAffectedAfterInsert() {
        let statements: [(String, Int)] = [
            ("INSERT INTO notes (body) VALUES ('d')", 1), ("BEGIN", 0),
            ("INSERT INTO notes (body) VALUES ('e')", 1), ("ROLLBACK", 0),
            ("BEGIN", 0), ("COMMIT", 0), ("CREATE TABLE extra (x)", 0), ("PRAGMA user_version = 3", 0),
        ]
        for (query, expected) in statements {
            let result = driver.executeSQL(databasePath: databaseURL.path, query: query)
            XCTAssertNil(result.error, query)
            XCTAssertEqual(result.rowsAffected, expected, query)
        }
    }

    func testDmlReportsTrueRowCounts() {
        let statements: [(String, Int)] = [
            ("UPDATE notes SET body = 'x'", 3), ("UPDATE notes SET body = 'y' WHERE id = 999", 0),
            ("DELETE FROM notes WHERE id = 1", 1), ("INSERT INTO notes (body) VALUES ('a'),('b')", 2),
        ]
        for (query, expected) in statements {
            let result = driver.executeSQL(databasePath: databaseURL.path, query: query)
            XCTAssertNil(result.error, query)
            XCTAssertEqual(result.rowsAffected, expected, query)
        }
    }

    func testTriggerRowsAreNotCounted() {
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(databaseURL.path, &db), SQLITE_OK)
        defer { sqlite3_close(db) }
        XCTAssertEqual(sqlite3_exec(db, "CREATE TABLE audit(n)", nil, nil, nil), SQLITE_OK)
        XCTAssertEqual(sqlite3_exec(db, """
        CREATE TRIGGER notes_audit AFTER INSERT ON notes BEGIN INSERT INTO audit(n) VALUES (NEW.id); END
        """, nil, nil, nil), SQLITE_OK)
        let result = driver.executeSQL(
            databasePath: databaseURL.path, query: "INSERT INTO notes (body) VALUES ('p'),('q'),('r')"
        )
        XCTAssertNil(result.error)
        XCTAssertEqual(result.rowsAffected, 3)
    }

    func testTruncatedInsertReturningReportsFullRowCount() {
        let result = driver.executeSQL(databasePath: databaseURL.path, query: """
        WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i < 600)
        INSERT INTO notes (body) SELECT 'r' FROM c RETURNING id
        """)
        XCTAssertNil(result.error)
        XCTAssertTrue(result.truncated)
        XCTAssertEqual(result.rowsAffected, 600)
        XCTAssertEqual(result.rows?.count, 500)
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

    func testTransactionControlRequiresMutationAuthorizationWithoutOpeningTransaction() throws {
        let queries = ["BEGIN IMMEDIATE TRANSACTION", "COMMIT", "ROLLBACK", "SAVEPOINT a", "RELEASE a"]
        for query in queries {
            let response = try routeResponse(query)
            XCTAssertEqual(response.statusCode, 403, query)
            let payload = try JSONDecoder().decode(SdkDatabaseErrorPayload.self, from: response.body)
            XCTAssertEqual(payload.error, "mutation_not_authorized", query)
        }

        let write = driver.executeSQL(databasePath: databaseURL.path, query: "INSERT INTO notes VALUES (2, 'direct')")
        XCTAssertNil(write.error)
        let selection = driver.executeSQL(databasePath: databaseURL.path, query: "SELECT body FROM notes WHERE id = 2")
        XCTAssertEqual(selection.rows, [["direct"]])

        let begin = driver.executeSQL(databasePath: databaseURL.path, query: "BEGIN")
        XCTAssertNil(begin.error)
        let commit = driver.executeSQL(databasePath: databaseURL.path, query: "COMMIT")
        XCTAssertNil(commit.error)
    }

    func testAuthorizedRouteTransactionCommitsWrite() throws {
        let sessionId = "session-1"
        DatabaseInspector.shared.configure(StorageInspectionConfiguration(
            allowedDatabasePaths: [databaseURL.path],
            allowMutations: true
        ))
        DatabaseInspector.shared.authorizeHostMutations(true)
        DatabaseInspector.shared.authorizeSessionMutations(sessionId: sessionId)
        let handler = SdkDatabaseRouteHandler(currentSessionId: { sessionId })
        defer { _ = driver.executeSQL(databasePath: databaseURL.path, query: "ROLLBACK") }

        for query in [
            "BEGIN IMMEDIATE TRANSACTION",
            "INSERT INTO notes VALUES (2, 'committed')",
            "COMMIT",
        ] {
            let response = try routeResponse(query, sessionId: sessionId, handler: handler)
            XCTAssertEqual(response.statusCode, 200, query)
            let payload = try JSONDecoder().decode(SdkExecuteSqlPayload.self, from: response.body)
            XCTAssertNil(payload.error, query)
        }

        let selection = driver.executeSQL(databasePath: databaseURL.path, query: "SELECT body FROM notes WHERE id = 2")
        XCTAssertEqual(selection.rows, [["committed"]])
    }

    #if DEBUG
        func testLaunchTokenAuthorizesRouteTransactionWithoutSession() throws {
            DatabaseInspector.shared.configure(StorageInspectionConfiguration(
                allowedDatabasePaths: [databaseURL.path],
                allowMutations: true
            ))
            DatabaseInspector.shared.authorizeHostMutations(true)
            DatabaseInspector.shared.authorizeMutationToken("launch-token")
            defer { _ = driver.executeSQL(databasePath: databaseURL.path, query: "ROLLBACK") }

            for (index, token) in ([nil, "wrong"] as [String?]).enumerated() {
                let response = try routeResponse("BEGIN IMMEDIATE TRANSACTION", mutationToken: token)
                XCTAssertEqual(response.statusCode, 403)
                let payload = try JSONDecoder().decode(SdkDatabaseErrorPayload.self, from: response.body)
                XCTAssertEqual(payload.error, "mutation_not_authorized")

                let write = driver.executeSQL(
                    databasePath: databaseURL.path,
                    query: "INSERT INTO notes VALUES (\(index + 2), 'direct')"
                )
                XCTAssertNil(write.error)
                let begin = driver.executeSQL(databasePath: databaseURL.path, query: "BEGIN")
                XCTAssertNil(begin.error)
                let commit = driver.executeSQL(databasePath: databaseURL.path, query: "COMMIT")
                XCTAssertNil(commit.error)
            }

            for query in ["BEGIN IMMEDIATE TRANSACTION", "COMMIT"] {
                let response = try routeResponse(query, mutationToken: "launch-token")
                XCTAssertEqual(response.statusCode, 200, query)
                let payload = try JSONDecoder().decode(SdkExecuteSqlPayload.self, from: response.body)
                XCTAssertNil(payload.error, query)
            }
        }
    #endif

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
            "BEGIN; SELECT body FROM notes",
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

    private func routeResponse(
        _ query: String,
        sessionId: String? = nil,
        mutationToken: String? = nil,
        handler: SdkDatabaseRouteHandler = SdkDatabaseRouteHandler()
    )
        throws -> SdkRouteResponse
    {
        let request = SdkExecuteSqlRequest(
            databasePath: databaseURL.path,
            query: query,
            sessionId: sessionId,
            mutationToken: mutationToken
        )
        let body = try JSONEncoder().encode(request)
        return handler.handleExecuteSql(body: body)
    }
}
