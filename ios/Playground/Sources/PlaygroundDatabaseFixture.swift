import AutoMobileSDK
import Foundation

protocol PlaygroundFileSystem {
    var applicationSupportDirectory: URL? { get }

    func createDirectory(at url: URL) throws
}

protocol PlaygroundDatabaseInspecting {
    func configure(_ configuration: StorageInspectionConfiguration)
    func setEnabled(_ enabled: Bool)
}

enum PlaygroundDatabaseFixtureError: LocalizedError {
    case applicationSupportDirectoryUnavailable
    case sqlExecutionFailed(String)

    var errorDescription: String? {
        switch self {
        case .applicationSupportDirectoryUnavailable:
            "Application Support directory is unavailable"
        case let .sqlExecutionFailed(message):
            "Failed to seed Playground database: \(message)"
        }
    }
}

struct PlaygroundDatabaseFixture {
    static let databaseFileName = "sessions.sqlite"

    private static let seedStatements = [
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
    ]

    private let fileSystem: any PlaygroundFileSystem
    private let inspector: any PlaygroundDatabaseInspecting
    private let seedDriver: any DatabaseDriver

    init(
        fileSystem: any PlaygroundFileSystem = DefaultPlaygroundFileSystem(),
        inspector: any PlaygroundDatabaseInspecting = DefaultPlaygroundDatabaseInspector(),
        seedDriver: any DatabaseDriver = SQLiteDatabaseDriver()
    ) {
        self.fileSystem = fileSystem
        self.inspector = inspector
        self.seedDriver = seedDriver
    }

    var databaseURL: URL? {
        fileSystem.applicationSupportDirectory?
            .appendingPathComponent("Playground", isDirectory: true)
            .appendingPathComponent(Self.databaseFileName, isDirectory: false)
    }

    @discardableResult
    func install() throws -> URL {
        guard let databaseURL else {
            throw PlaygroundDatabaseFixtureError.applicationSupportDirectoryUnavailable
        }
        try fileSystem.createDirectory(at: databaseURL.deletingLastPathComponent())

        try execute("BEGIN IMMEDIATE TRANSACTION", databaseURL: databaseURL)
        var committed = false
        defer {
            if !committed {
                _ = seedDriver.executeSQL(databasePath: databaseURL.path, query: "ROLLBACK")
            }
        }

        for statement in Self.seedStatements {
            try execute(statement, databaseURL: databaseURL)
        }
        try execute("COMMIT", databaseURL: databaseURL)
        committed = true

        inspector.configure(StorageInspectionConfiguration(allowedDatabasePaths: [databaseURL.path]))
        inspector.setEnabled(true)

        return databaseURL
    }

    private func execute(_ statement: String, databaseURL: URL) throws {
        let result = seedDriver.executeSQL(databasePath: databaseURL.path, query: statement)
        if let error = result.error {
            throw PlaygroundDatabaseFixtureError.sqlExecutionFailed(error)
        }
    }
}

private struct DefaultPlaygroundFileSystem: PlaygroundFileSystem {
    var applicationSupportDirectory: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
    }

    func createDirectory(at url: URL) throws {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }
}

private struct DefaultPlaygroundDatabaseInspector: PlaygroundDatabaseInspecting {
    func configure(_ configuration: StorageInspectionConfiguration) {
        DatabaseInspector.shared.configure(configuration)
    }

    func setEnabled(_ enabled: Bool) {
        DatabaseInspector.shared.setEnabled(enabled)
    }
}
