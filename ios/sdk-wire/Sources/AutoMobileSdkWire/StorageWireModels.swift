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
