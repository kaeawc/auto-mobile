import Foundation

/// How a store that other processes (app extensions, a widget, another app in the same
/// app group) can open is coordinated. The host declares it; the SDK never infers it.
public enum StoreCoordination: String, Codable, Sendable {
    /// Another process may write while the SDK reads, so a read is a point-in-time snapshot.
    case uncoordinated
    /// The host coordinates cross-process access, for example with file coordination.
    case hostCoordinated = "host_coordinated"
}

/// Host-provided metadata for a Core Data store that can be inspected without
/// opening a second writer connection.
public struct CoreDataStoreRegistration: Sendable, Codable {
    public let identifier: String
    public let modelVersion: String?
    public let entities: [String]
    /// The app group whose container holds the store, when other processes share it.
    public let appGroup: String?
    /// How cross-process access is coordinated; only meaningful with `appGroup`. Nil is
    /// reported as uncoordinated.
    public let coordination: StoreCoordination?

    public init(
        identifier: String,
        modelVersion: String? = nil,
        entities: [String] = [],
        appGroup: String? = nil,
        coordination: StoreCoordination? = nil
    ) {
        self.identifier = identifier
        self.modelVersion = modelVersion
        self.entities = entities
        self.appGroup = appGroup
        self.coordination = coordination
    }
}

/// One exact generic-password item that the host permits test-only deletion of.
public struct KeychainDeletionEntry: Hashable, Sendable {
    public let service: String
    public let account: String
    public let accessGroup: String

    public init(service: String, account: String, accessGroup: String) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
    }
}

/// Limits and access boundaries applied to storage inspection routes.
public struct StorageInspectionConfiguration: Sendable {
    public var allowedDatabasePaths: Set<String>
    public var registeredAppGroupSuites: Set<String>
    /// Registered app-group suites whose cross-process access the host coordinates.
    public var hostCoordinatedAppGroupSuites: Set<String>
    public var coreDataStores: [CoreDataStoreRegistration]
    public var sensitiveKeys: Set<String>
    public var maxRows: Int
    public var maxBytes: Int
    public var allowKeychainDeletion: Bool
    public var allowedKeychainDeletionEntries: Set<KeychainDeletionEntry>
    public var allowMutations: Bool

    public init(
        allowedDatabasePaths: Set<String> = [],
        registeredAppGroupSuites: Set<String> = [],
        coreDataStores: [CoreDataStoreRegistration] = [],
        sensitiveKeys: Set<String> = [],
        maxRows: Int = 500,
        maxBytes: Int = 512 * 1024,
        allowMutations: Bool = false,
        allowKeychainDeletion: Bool = false,
        allowedKeychainDeletionEntries: Set<KeychainDeletionEntry> = [],
        hostCoordinatedAppGroupSuites: Set<String> = []
    ) {
        self.allowedDatabasePaths = allowedDatabasePaths
        self.registeredAppGroupSuites = registeredAppGroupSuites
        self.hostCoordinatedAppGroupSuites = hostCoordinatedAppGroupSuites
        self.coreDataStores = coreDataStores
        self.sensitiveKeys = sensitiveKeys
        self.maxRows = max(1, maxRows)
        self.maxBytes = max(1, maxBytes)
        self.allowKeychainDeletion = allowKeychainDeletion
        self.allowedKeychainDeletionEntries = allowedKeychainDeletionEntries
        self.allowMutations = allowMutations
    }
}

/// A stable classification for storage failures. The message is intentionally
/// separate so transport consumers can react without parsing SQLite text.
enum StorageInspectionAccess {
    static let defaultSensitiveKeys: Set<String> = [
        "authorization", "credential", "credentials", "password", "passwd",
        "secret", "token", "access_token", "refresh_token", "api_key",
        "apikey", "private_key", "keychain", "cookie",
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
    )
        -> [[String?]]
    {
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
