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
