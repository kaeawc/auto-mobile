import Foundation

/// Metadata for a single inspectable SQLite database in the target app. Ported from
/// the reference `SdkDatabaseClient.swift`; immutable value type, so `Sendable`.
public struct SdkDatabaseInfo: Codable, Equatable, Sendable {
    public let name: String
    public let path: String
    public let sizeBytes: Int64?

    public init(name: String, path: String, sizeBytes: Int64? = nil) {
        self.name = name
        self.path = path
        self.sizeBytes = sizeBytes
    }
}
