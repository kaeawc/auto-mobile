import AutoMobileSDK
import Foundation

protocol PlaygroundFileSystem {
    var applicationSupportDirectory: URL? { get }

    func createDirectory(at url: URL) throws
    func fileExists(atPath path: String) -> Bool
}

protocol PlaygroundDatabaseInspecting {
    func configure(_ configuration: StorageInspectionConfiguration)
    func setEnabled(_ enabled: Bool)
    func getDriver() -> DatabaseDriver?
}

struct PlaygroundDatabaseFixture {
    static let databaseFileName = "sessions.sqlite"

    private static let seedStatements = [
        """
        CREATE TABLE sessions (
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
        VALUES ('ios-playground-seed-001', 1704067200000, '0.0.50', 'iPhone Simulator', 'iOS 17.0')
        """,
    ]

    private let fileSystem: any PlaygroundFileSystem
    private let inspector: any PlaygroundDatabaseInspecting

    init(
        fileSystem: any PlaygroundFileSystem = DefaultPlaygroundFileSystem(),
        inspector: any PlaygroundDatabaseInspecting = DefaultPlaygroundDatabaseInspector()
    ) {
        self.fileSystem = fileSystem
        self.inspector = inspector
    }

    var databaseURL: URL? {
        fileSystem.applicationSupportDirectory?
            .appendingPathComponent("Playground", isDirectory: true)
            .appendingPathComponent(Self.databaseFileName, isDirectory: false)
    }

    @discardableResult
    func install() -> URL? {
        guard let databaseURL else { return nil }

        do {
            try fileSystem.createDirectory(at: databaseURL.deletingLastPathComponent())
        } catch {
            return nil
        }

        inspector.configure(StorageInspectionConfiguration(allowedDatabasePaths: [databaseURL.path]))
        inspector.setEnabled(true)

        guard !fileSystem.fileExists(atPath: databaseURL.path),
              let driver = inspector.getDriver()
        else {
            return databaseURL
        }

        for statement in Self.seedStatements {
            let result = driver.executeSQL(databasePath: databaseURL.path, query: statement)
            guard result.error == nil else { break }
        }

        return databaseURL
    }
}

private struct DefaultPlaygroundFileSystem: PlaygroundFileSystem {
    var applicationSupportDirectory: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
    }

    func createDirectory(at url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    func fileExists(atPath path: String) -> Bool {
        FileManager.default.fileExists(atPath: path)
    }
}

private struct DefaultPlaygroundDatabaseInspector: PlaygroundDatabaseInspecting {
    func configure(_ configuration: StorageInspectionConfiguration) {
        DatabaseInspector.shared.configure(configuration)
    }

    func setEnabled(_ enabled: Bool) {
        DatabaseInspector.shared.setEnabled(enabled)
    }

    func getDriver() -> DatabaseDriver? {
        DatabaseInspector.shared.getDriver()
    }
}
