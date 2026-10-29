import Foundation

/// Why a storage inspection request was refused or degraded, as reported by the SDK's database routes.
public struct StorageDiagnostic: Sendable, Codable, Equatable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

/// The error body of a failed database route: a message, plus a diagnostic when the SDK has one.
public struct SdkDatabaseErrorPayload: Codable, Equatable, Sendable {
    public let error: String
    public let diagnostic: StorageDiagnostic?

    public init(error: String, diagnostic: StorageDiagnostic? = nil) {
        self.error = error
        self.diagnostic = diagnostic
    }
}

/// Exact app-owned generic-password scope. Values are never part of this contract.
public struct KeychainItemSelector: Codable, Equatable, Sendable {
    public let itemClass: String
    public let service: String
    public let account: String
    public let accessGroup: String

    public init(itemClass: String, service: String, account: String, accessGroup: String) {
        self.itemClass = itemClass
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
    }
}

public struct KeychainDeleteRequest: Codable, Equatable, Sendable {
    public let appId: String
    public let sessionId: String?
    public let mutationToken: String?
    public let confirm: Bool
    public let selector: KeychainItemSelector

    public init(
        appId: String,
        sessionId: String?,
        mutationToken: String?,
        confirm: Bool,
        selector: KeychainItemSelector
    ) {
        self.appId = appId
        self.sessionId = sessionId
        self.mutationToken = mutationToken
        self.confirm = confirm
        self.selector = selector
    }
}

public struct KeychainDeleteOutcome: Codable, Equatable, Sendable {
    public let outcome: String
    /// Present only after the app confirms deletion of this exact scope.
    public let deletedScope: KeychainItemSelector?

    public init(outcome: String, deletedScope: KeychainItemSelector? = nil) {
        self.outcome = outcome
        self.deletedScope = deletedScope
    }
}

/// Constraints of one registered store that a client must not guess (#5161): whether other
/// processes share it, how the host coordinates that, and whether it can be queried.
public struct StorageStoreState: Codable, Equatable, Sendable {
    /// `user_defaults_suite` or `core_data`.
    public let kind: String
    public let identifier: String
    /// `app_private` or `app_group`.
    public let sharing: String
    public let appGroup: String?
    /// `single_process`, `uncoordinated` or `host_coordinated`.
    public let coordination: String
    /// `supported` or `unsupported`.
    public let query: String
    public let reason: String?

    public init(
        kind: String,
        identifier: String,
        sharing: String,
        appGroup: String?,
        coordination: String,
        query: String,
        reason: String?
    ) {
        self.kind = kind
        self.identifier = identifier
        self.sharing = sharing
        self.appGroup = appGroup
        self.coordination = coordination
        self.query = query
        self.reason = reason
    }
}

/// The app-scoped Keychain policy as a capability (#5161). It never carries a value:
/// inspection is unavailable until a host inspection adapter exists, and deletion lists
/// exactly the allowlisted items the keychain delete route accepts.
public struct KeychainCapability: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    /// Always `storage.keychain`.
    public let capability: String
    /// Always `unavailable` in this version.
    public let inspection: String
    /// `enabled` or `disabled`.
    public let deletion: String
    /// `DISABLED` or `NO_ALLOWLISTED_SCOPES` when deletion is disabled.
    public let reason: String?
    public let deletionScopes: [KeychainItemSelector]

    public init(
        schemaVersion: Int,
        capability: String,
        inspection: String,
        deletion: String,
        reason: String?,
        deletionScopes: [KeychainItemSelector]
    ) {
        self.schemaVersion = schemaVersion
        self.capability = capability
        self.inspection = inspection
        self.deletion = deletion
        self.reason = reason
        self.deletionScopes = deletionScopes
    }
}
