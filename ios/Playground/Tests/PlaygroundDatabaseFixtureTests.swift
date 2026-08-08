import AutoMobileSDK
import XCTest

@testable import Playground

/// Pins the iOS Playground database fixture used by manual SQL inspection tests.
final class PlaygroundDatabaseFixtureTests: XCTestCase {
    func testInstallConfiguresInspectionAndSeedsNewDatabase() throws {
        let fileSystem = FakePlaygroundFileSystem()
        let driver = FakeDatabaseDriver()
        let inspector = FakePlaygroundDatabaseInspector(driver: driver)
        let fixture = PlaygroundDatabaseFixture(fileSystem: fileSystem, inspector: inspector)

        let databaseURL = try XCTUnwrap(fixture.install())

        XCTAssertEqual(
            inspector.configuration.allowedDatabasePaths,
            [databaseURL.path]
        )
        XCTAssertTrue(inspector.isEnabled)
        XCTAssertEqual(fileSystem.createdDirectories.map(\.path), [databaseURL.deletingLastPathComponent().path])
        XCTAssertEqual(driver.executedQueries.count, 2)
        XCTAssertTrue(driver.executedQueries[0].contains("CREATE TABLE sessions"))
        XCTAssertTrue(driver.executedQueries[1].contains("ios-playground-seed-001"))
        XCTAssertTrue(driver.executedQueries[1].contains("iPhone Simulator"))
    }

    func testInstallDoesNotReseedExistingDatabase() throws {
        let fileSystem = FakePlaygroundFileSystem()
        let driver = FakeDatabaseDriver()
        let inspector = FakePlaygroundDatabaseInspector(driver: driver)
        let fixture = PlaygroundDatabaseFixture(fileSystem: fileSystem, inspector: inspector)
        let expectedURL = try XCTUnwrap(fixture.databaseURL)
        fileSystem.existingPaths.insert(expectedURL.path)

        let databaseURL = try XCTUnwrap(fixture.install())

        XCTAssertEqual(databaseURL, expectedURL)
        XCTAssertTrue(inspector.isEnabled)
        XCTAssertTrue(driver.executedQueries.isEmpty)
    }
}

private final class FakePlaygroundFileSystem: PlaygroundFileSystem {
    let applicationSupportDirectory: URL? = URL(fileURLWithPath: "/tmp/playground-fixture-tests", isDirectory: true)
    var existingPaths = Set<String>()
    var createdDirectories: [URL] = []

    func createDirectory(at url: URL) throws {
        createdDirectories.append(url)
    }

    func fileExists(atPath path: String) -> Bool {
        existingPaths.contains(path)
    }
}

private final class FakePlaygroundDatabaseInspector: PlaygroundDatabaseInspecting {
    let driver: DatabaseDriver
    private(set) var configuration = StorageInspectionConfiguration()
    private(set) var isEnabled = false

    init(driver: DatabaseDriver) {
        self.driver = driver
    }

    func configure(_ configuration: StorageInspectionConfiguration) {
        self.configuration = configuration
    }

    func setEnabled(_ enabled: Bool) {
        isEnabled = enabled
    }

    func getDriver() -> DatabaseDriver? {
        driver
    }
}

private final class FakeDatabaseDriver: DatabaseDriver, @unchecked Sendable {
    var executedQueries: [String] = []

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
        return SQLExecutionResult(columns: nil, rows: nil, rowsAffected: 0)
    }
}
