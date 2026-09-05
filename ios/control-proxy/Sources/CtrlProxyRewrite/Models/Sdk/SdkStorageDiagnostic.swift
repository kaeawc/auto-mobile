import Foundation

/// A structured storage/database diagnostic emitted by the in-app SDK. Ported from
/// the reference `SdkDatabaseClient.swift`; an immutable value type, so `Sendable`.
public struct SdkStorageDiagnostic: Codable, Equatable, Sendable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}
