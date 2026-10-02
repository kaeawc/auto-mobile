import Foundation
import os

/// Debug-time SQLite database inspection.
/// iOS equivalent of Android's DatabaseInspector.
public final class DatabaseInspector: Sendable {
    public static let shared = DatabaseInspector()

    private struct State: Sendable {
        var isEnabled = false
        var driver: DatabaseDriver?
        var configuration = StorageInspectionConfiguration()
        var hostMutationAuthorization = false
        var sessionMutationAuthorization: String?
        #if DEBUG
            var mutationToken: String?
        #endif
    }

    private let state = OSAllocatedUnfairLock(initialState: State())

    private init() {}

    func initialize() {
        setDriver(SQLiteDatabaseDriver())
    }

    /// Whether inspection is enabled.
    public var isEnabled: Bool {
        state.withLock { $0.isEnabled }
    }

    /// Enable or disable inspection.
    public func setEnabled(_ enabled: Bool) {
        state.withLock { $0.isEnabled = enabled }
    }

    /// Configure explicit storage registrations and transport limits.
    public func configure(_ configuration: StorageInspectionConfiguration) {
        state.withLock { $0.configuration = configuration }
    }

    /// Register an app-group suite for host-coordinated inspection.
    public func registerAppGroupSuite(_ suiteName: String) {
        state.withLock { _ = $0.configuration.registeredAppGroupSuites.insert(suiteName) }
    }

    /// Register Core Data metadata supplied by the host.
    public func registerCoreDataStore(_ store: CoreDataStoreRegistration) {
        state.withLock { state in
            state.configuration.coreDataStores.removeAll { $0.identifier == store.identifier }
            state.configuration.coreDataStores.append(store)
        }
    }

    /// Authorize the host half of the mutation gate.
    public func authorizeHostMutations(_ authorized: Bool) {
        state.withLock { $0.hostMutationAuthorization = authorized }
    }

    /// Authorize mutations for one active SDK session.
    public func authorizeSessionMutations(sessionId: String?) {
        state.withLock { $0.sessionMutationAuthorization = sessionId }
    }

    #if DEBUG
        /// Require a launch-scoped mutation token for host-authorized writes.
        public func authorizeMutationToken(_ token: String) {
            state.withLock { $0.mutationToken = token.isEmpty ? nil : token }
        }
    #endif

    var inspectionConfiguration: StorageInspectionConfiguration {
        state.withLock { $0.configuration }
    }

    func canMutate(sessionId: String?, currentSessionId: String?, mutationToken: String? = nil) -> Bool {
        state.withLock { state in
            guard state.configuration.allowMutations && state.hostMutationAuthorization else { return false }
            #if DEBUG
                if let mutationToken, let registered = state.mutationToken,
                   !mutationToken.isEmpty, !registered.isEmpty
                {
                    let supplied = Array(mutationToken.utf8)
                    let expected = Array(registered.utf8)
                    var difference = supplied.count ^ expected.count
                    for index in 0 ..< max(supplied.count, expected.count) {
                        difference |= Int(supplied.indices.contains(index) ? supplied[index] : 0)
                            ^ Int(expected.indices.contains(index) ? expected[index] : 0)
                    }
                    if difference == 0 { return true }
                }
            #endif
            return sessionId != nil
                && sessionId == currentSessionId
                && sessionId == state.sessionMutationAuthorization
        }
    }

    /// Get the driver for direct access.
    public func getDriver() -> DatabaseDriver? {
        state.withLock { state in
            guard state.isEnabled else { return nil }
            return state.driver
        }
    }

    // MARK: - Testing Support

    func setDriver(_ driver: DatabaseDriver) {
        let old = state.withLock { state in
            let old = state.driver
            state.driver = driver
            return old
        }
        // A host-supplied driver's deinit may re-enter the inspector.
        withExtendedLifetime(old) {}
    }

    func reset() {
        let old = state.withLock { state in
            let old = state.driver
            state = State()
            return old
        }
        withExtendedLifetime(old) {}
    }
}

// MARK: - DatabaseDriver Protocol

/// Interface for database operations, enabling test faking.
public protocol DatabaseDriver: Sendable {
    /// List available databases.
    func getDatabases() -> [DatabaseDescriptor]

    /// List tables in a database.
    func getTables(databasePath: String) -> [String]

    /// Get table data with pagination.
    func getTableData(databasePath: String, table: String, limit: Int, offset: Int) -> TableDataResult

    /// Get table structure (columns, types, etc.).
    func getTableStructure(databasePath: String, table: String) -> TableStructureResult

    /// Execute a raw SQL query.
    func executeSQL(databasePath: String, query: String) -> SQLExecutionResult
}

// MARK: - Data Types

/// Describes a discovered SQLite database with name, path, and size.
public struct DatabaseDescriptor: Sendable {
    public let name: String
    public let path: String
    public let sizeBytes: Int64

    public init(name: String, path: String, sizeBytes: Int64) {
        self.name = name
        self.path = path
        self.sizeBytes = sizeBytes
    }
}

/// Result of a paginated table data query.
public struct TableDataResult: Sendable {
    public let columns: [String]
    public let rows: [[String?]]
    public let totalRows: Int
    public let diagnostic: StorageDiagnostic?

    public init(columns: [String], rows: [[String?]], totalRows: Int, diagnostic: StorageDiagnostic? = nil) {
        self.columns = columns
        self.rows = rows
        self.totalRows = totalRows
        self.diagnostic = diagnostic
    }
}

/// Result of a table structure query containing column definitions.
public struct TableStructureResult: Sendable {
    public let columns: [ColumnInfo]
    public let diagnostic: StorageDiagnostic?

    public init(columns: [ColumnInfo], diagnostic: StorageDiagnostic? = nil) {
        self.columns = columns
        self.diagnostic = diagnostic
    }
}

/// Metadata about a single database table column.
public struct ColumnInfo: Sendable {
    public let name: String
    public let type: String
    public let isNullable: Bool
    public let isPrimaryKey: Bool
    public let defaultValue: String?

    public init(name: String, type: String, isNullable: Bool, isPrimaryKey: Bool, defaultValue: String?) {
        self.name = name
        self.type = type
        self.isNullable = isNullable
        self.isPrimaryKey = isPrimaryKey
        self.defaultValue = defaultValue
    }
}

/// Result of a raw SQL query execution.
public struct SQLExecutionResult: Sendable {
    public let columns: [String]?
    public let rows: [[String?]]?
    public let rowsAffected: Int
    public let error: String?
    public let diagnostic: StorageDiagnostic?
    public let truncated: Bool

    public init(
        columns: [String]?,
        rows: [[String?]]?,
        rowsAffected: Int,
        error: String? = nil,
        diagnostic: StorageDiagnostic? = nil,
        truncated: Bool = false
    ) {
        self.columns = columns
        self.rows = rows
        self.rowsAffected = rowsAffected
        self.error = error
        self.diagnostic = diagnostic
        self.truncated = truncated
    }
}

// MARK: - Default Implementation

final class DefaultDatabaseDriver: DatabaseDriver, Sendable {
    func getDatabases() -> [DatabaseDescriptor] {
        var databases: [DatabaseDescriptor] = []

        guard let documentsPath = NSSearchPathForDirectoriesInDomains(
            .documentDirectory, .userDomainMask, true
        ).first else {
            return databases
        }

        let libraryPath = NSSearchPathForDirectoriesInDomains(
            .libraryDirectory, .userDomainMask, true
        ).first

        let searchPaths = [documentsPath, libraryPath].compactMap { $0 }
        let fileManager = FileManager.default

        for basePath in searchPaths {
            guard let enumerator = fileManager.enumerator(atPath: basePath) else { continue }
            while let file = enumerator.nextObject() as? String {
                if file.hasSuffix(".sqlite") || file.hasSuffix(".db") || file.hasSuffix(".sqlite3") {
                    let fullPath = (basePath as NSString).appendingPathComponent(file)
                    let attrs = try? fileManager.attributesOfItem(atPath: fullPath)
                    let size = attrs?[.size] as? Int64 ?? 0
                    databases.append(DatabaseDescriptor(
                        name: (file as NSString).lastPathComponent,
                        path: fullPath,
                        sizeBytes: size
                    ))
                }
            }
        }

        return databases
    }

    func getTables(databasePath _: String) -> [String] {
        // SQLite operations would require importing sqlite3 directly.
        // This is a minimal implementation that apps can override.
        return []
    }

    func getTableData(databasePath _: String, table _: String, limit _: Int, offset _: Int) -> TableDataResult {
        return TableDataResult(columns: [], rows: [], totalRows: 0)
    }

    func getTableStructure(databasePath _: String, table _: String) -> TableStructureResult {
        return TableStructureResult(columns: [])
    }

    func executeSQL(databasePath _: String, query _: String) -> SQLExecutionResult {
        return SQLExecutionResult(
            columns: nil,
            rows: nil,
            rowsAffected: 0,
            error: "Not implemented. Provide a custom DatabaseDriver."
        )
    }
}
