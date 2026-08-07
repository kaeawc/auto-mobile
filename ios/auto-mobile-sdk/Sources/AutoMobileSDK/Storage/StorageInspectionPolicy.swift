import Foundation

/// Host-provided metadata for a Core Data store that can be inspected without
/// opening a second writer connection.
public struct CoreDataStoreRegistration: Sendable, Codable {
    public let identifier: String
    public let modelVersion: String?
    public let entities: [String]

    public init(identifier: String, modelVersion: String? = nil, entities: [String] = []) {
        self.identifier = identifier
        self.modelVersion = modelVersion
        self.entities = entities
    }
}

/// Limits and access boundaries applied to storage inspection routes.
public struct StorageInspectionConfiguration: Sendable {
    public var allowedDatabasePaths: Set<String>
    public var registeredAppGroupSuites: Set<String>
    public var coreDataStores: [CoreDataStoreRegistration]
    public var sensitiveKeys: Set<String>
    public var maxRows: Int
    public var maxBytes: Int
    public var allowMutations: Bool

    public init(
        allowedDatabasePaths: Set<String> = [],
        registeredAppGroupSuites: Set<String> = [],
        coreDataStores: [CoreDataStoreRegistration] = [],
        sensitiveKeys: Set<String> = [],
        maxRows: Int = 500,
        maxBytes: Int = 512 * 1024,
        allowMutations: Bool = false
    ) {
        self.allowedDatabasePaths = allowedDatabasePaths
        self.registeredAppGroupSuites = registeredAppGroupSuites
        self.coreDataStores = coreDataStores
        self.sensitiveKeys = sensitiveKeys
        self.maxRows = max(1, maxRows)
        self.maxBytes = max(1, maxBytes)
        self.allowMutations = allowMutations
    }
}

/// A stable classification for storage failures. The message is intentionally
/// separate so transport consumers can react without parsing SQLite text.
public struct StorageDiagnostic: Sendable, Codable, Equatable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

enum StorageInspectionAccess {
    static let defaultSensitiveKeys: Set<String> = [
        "authorization", "credential", "credentials", "password", "passwd",
        "secret", "token", "access_token", "refresh_token", "api_key",
        "apikey", "private_key", "keychain", "cookie"
    ]

    static func isSensitive(_ column: String, configured: Set<String>) -> Bool {
        let normalized = column.lowercased()
        return defaultSensitiveKeys.contains { normalized.contains($0) }
            || configured.contains { normalized == $0.lowercased() }
    }

    static func redactedRows(
        columns: [String],
        rows: [[String?]],
        configuredKeys: Set<String>
    ) -> [[String?]] {
        rows.map { row in
            row.enumerated().map { index, value in
                guard index < columns.count,
                      value != nil,
                      isSensitive(columns[index], configured: configuredKeys)
                else {
                    return value
                }
                return "[REDACTED]"
            }
        }
    }
}
