import AutoMobileSDK
import XCTest

@testable import Playground

/// Pins the iOS Playground database fixture used by manual SQL inspection tests.
final class PlaygroundDatabaseFixtureTests: XCTestCase {
    func testInstallConfiguresInspectionAndSeedsNewDatabase() throws {
        let fileSystem = FakePlaygroundFileSystem()
        let driver = FakeDatabaseDriver()
        let inspector = FakePlaygroundDatabaseInspector()
        let fixture = PlaygroundDatabaseFixture(
            fileSystem: fileSystem,
            inspector: inspector,
            seedDriver: driver
        )

        let databaseURL = try fixture.install()

        XCTAssertEqual(
            inspector.configuration.allowedDatabasePaths,
            [databaseURL.path]
        )
        XCTAssertTrue(inspector.isEnabled)
        XCTAssertEqual(fileSystem.createdDirectories.map(\.path), [databaseURL.deletingLastPathComponent().path])
        XCTAssertEqual(driver.executedQueries.count, 4)
        XCTAssertEqual(driver.executedQueries[0], "BEGIN IMMEDIATE TRANSACTION")
        XCTAssertTrue(driver.executedQueries[1].contains("CREATE TABLE IF NOT EXISTS sessions"))
        XCTAssertTrue(driver.executedQueries[2].contains("ios-playground-seed-001"))
        XCTAssertTrue(driver.executedQueries[2].contains("WHERE NOT EXISTS"))
        XCTAssertEqual(driver.executedQueries[3], "COMMIT")
    }

    func testInstallFailureRollsBackWithoutEnablingInspectionAndCanRetry() throws {
        let fileSystem = FakePlaygroundFileSystem()
        let driver = FakeDatabaseDriver(failingQuery: "INSERT")
        let inspector = FakePlaygroundDatabaseInspector()
        let fixture = PlaygroundDatabaseFixture(
            fileSystem: fileSystem,
            inspector: inspector,
            seedDriver: driver
        )

        XCTAssertThrowsError(try fixture.install()) { error in
            XCTAssertEqual(
                error.localizedDescription,
                "Failed to seed Playground database: seed failed"
            )
        }
        XCTAssertFalse(inspector.isEnabled)
        XCTAssertTrue(inspector.configuration.allowedDatabasePaths.isEmpty)
        XCTAssertEqual(driver.executedQueries.last, "ROLLBACK")

        driver.failingQuery = nil
        _ = try fixture.install()

        XCTAssertTrue(inspector.isEnabled)
        XCTAssertEqual(driver.executedQueries[4], "BEGIN IMMEDIATE TRANSACTION")
        XCTAssertEqual(driver.executedQueries[7], "COMMIT")
    }

    func testInstallWithoutApplicationSupportDoesNotSeedOrEnableInspection() {
        let fileSystem = FakePlaygroundFileSystem(applicationSupportDirectory: nil)
        let driver = FakeDatabaseDriver()
        let inspector = FakePlaygroundDatabaseInspector()
        let fixture = PlaygroundDatabaseFixture(
            fileSystem: fileSystem,
            inspector: inspector,
            seedDriver: driver
        )

        XCTAssertThrowsError(try fixture.install()) { error in
            XCTAssertEqual(error.localizedDescription, "Application Support directory is unavailable")
        }
        XCTAssertTrue(driver.executedQueries.isEmpty)
        XCTAssertFalse(inspector.isEnabled)
        XCTAssertTrue(inspector.configuration.allowedDatabasePaths.isEmpty)
    }

    func testInstallIsIdempotentWithRealSQLiteDriver() throws {
        let applicationSupportURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let fileSystem = RealPlaygroundFileSystem(applicationSupportDirectory: applicationSupportURL)
        let inspector = FakePlaygroundDatabaseInspector()
        let driver = SQLiteDatabaseDriver()
        let fixture = PlaygroundDatabaseFixture(
            fileSystem: fileSystem,
            inspector: inspector,
            seedDriver: driver
        )
        defer {
            driver.closeAll()
            try? FileManager.default.removeItem(at: applicationSupportURL)
        }

        let databaseURL = try fixture.install()
        _ = try fixture.install()
        let tableData = driver.getTableData(
            databasePath: databaseURL.path,
            table: "sessions",
            limit: 10,
            offset: 0
        )

        XCTAssertEqual(tableData.totalRows, 1)
        XCTAssertEqual(tableData.rows.first?[1], "ios-playground-seed-001")
    }
}

private final class FakePlaygroundFileSystem: PlaygroundFileSystem {
    let applicationSupportDirectory: URL?
    var createdDirectories: [URL] = []

    init(
        applicationSupportDirectory: URL? = URL(
            fileURLWithPath: "/tmp/playground-fixture-tests",
            isDirectory: true
        )
    ) {
        self.applicationSupportDirectory = applicationSupportDirectory
    }

    func createDirectory(at url: URL) throws {
        createdDirectories.append(url)
    }
}

private struct RealPlaygroundFileSystem: PlaygroundFileSystem {
    let applicationSupportDirectory: URL?

    func createDirectory(at url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }
}

private final class FakePlaygroundDatabaseInspector: PlaygroundDatabaseInspecting {
    private(set) var configuration = StorageInspectionConfiguration()
    private(set) var isEnabled = false

    func configure(_ configuration: StorageInspectionConfiguration) {
        self.configuration = configuration
    }

    func setEnabled(_ enabled: Bool) {
        isEnabled = enabled
    }
}

private final class FakeDatabaseDriver: DatabaseDriver, @unchecked Sendable {
    var failingQuery: String?
    var executedQueries: [String] = []

    init(failingQuery: String? = nil) {
        self.failingQuery = failingQuery
    }

    func getDatabases() -> [DatabaseDescriptor] {
        []
    }

    func getTables(databasePath _: String) -> [String] {
        []
    }

    func getTableData(databasePath _: String, table _: String, limit _: Int, offset _: Int) -> TableDataResult {
        TableDataResult(columns: [], rows: [], totalRows: 0)
    }

    func getTableStructure(databasePath _: String, table _: String) -> TableStructureResult {
        TableStructureResult(columns: [])
    }

    func executeSQL(databasePath _: String, query: String) -> SQLExecutionResult {
        executedQueries.append(query)
        if let failingQuery, query.contains(failingQuery) {
            return SQLExecutionResult(columns: nil, rows: nil, rowsAffected: 0, error: "seed failed")
        }
        return SQLExecutionResult(columns: nil, rows: nil, rowsAffected: 0)
    }
}
