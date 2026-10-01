import Foundation

/// Debug-time SQLite database inspection.
/// iOS equivalent of Android's DatabaseInspector.
public final class DatabaseInspector: @unchecked Sendable {
    public static let shared = DatabaseInspector()

    private let lock = NSLock()
    private var _isEnabled = false
    private var _driver: DatabaseDriver?
    private var _configuration = StorageInspectionConfiguration()
    private var _hostMutationAuthorization = false
    private var _sessionMutationAuthorization: String?
    #if DEBUG
        private var _mutationToken: String?
    #endif

    private init() {}

    func initialize() {
        lock.lock()
        defer { lock.unlock() }
        _driver = SQLiteDatabaseDriver()
    }

    /// Whether inspection is enabled.
    public var isEnabled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _isEnabled
    }

    /// Enable or disable inspection.
    public func setEnabled(_ enabled: Bool) {
        lock.lock()
        _isEnabled = enabled
        lock.unlock()
    }

    /// Configure explicit storage registrations and transport limits.
    public func configure(_ configuration: StorageInspectionConfiguration) {
        lock.lock()
        _configuration = configuration
        lock.unlock()
    }

    /// Register an app-group suite for host-coordinated inspection.
    public func registerAppGroupSuite(_ suiteName: String) {
        lock.lock()
        _configuration.registeredAppGroupSuites.insert(suiteName)
        lock.unlock()
    }

    /// Register Core Data metadata supplied by the host.
    public func registerCoreDataStore(_ store: CoreDataStoreRegistration) {
        lock.lock()
        _configuration.coreDataStores.removeAll { $0.identifier == store.identifier }
        _configuration.coreDataStores.append(store)
        lock.unlock()
    }

    /// Authorize the host half of the mutation gate.
    public func authorizeHostMutations(_ authorized: Bool) {
        lock.lock()
        _hostMutationAuthorization = authorized
        lock.unlock()
    }

    /// Authorize mutations for one active SDK session.
    public func authorizeSessionMutations(sessionId: String?) {
        lock.lock()
        _sessionMutationAuthorization = sessionId
        lock.unlock()
    }

    #if DEBUG
        /// Require a launch-scoped mutation token for host-authorized writes.
        public func authorizeMutationToken(_ token: String) {
            lock.lock()
            _mutationToken = token.isEmpty ? nil : token
            lock.unlock()
        }
    #endif

    var inspectionConfiguration: StorageInspectionConfiguration {
        lock.lock()
        defer { lock.unlock() }
        return _configuration
    }

    func canMutate(sessionId: String?, currentSessionId: String?, mutationToken: String? = nil) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard _configuration.allowMutations && _hostMutationAuthorization else { return false }
        #if DEBUG
            if let mutationToken, let registered = _mutationToken,
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
            && sessionId == _sessionMutationAuthorization
    }

    /// Get the driver for direct access.
    public func getDriver() -> DatabaseDriver? {
        lock.lock()
        defer { lock.unlock() }
        guard _isEnabled else { return nil }
        return _driver
    }

    // MARK: - Testing Support

    func setDriver(_ driver: DatabaseDriver) {
        lock.lock()
        _driver = driver
        lock.unlock()
    }

    func reset() {
        lock.lock()
        _isEnabled = false
        _driver = nil
        _configuration = StorageInspectionConfiguration()
        _hostMutationAuthorization = false
        _sessionMutationAuthorization = nil
        #if DEBUG
            _mutationToken = nil
        #endif
        lock.unlock()
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

final class DefaultDatabaseDriver: DatabaseDriver, @unchecked Sendable {
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
