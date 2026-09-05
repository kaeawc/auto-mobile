import Foundation

/// Structure of one column returned by the in-app SDK's table-structure inspection.
/// Ported from the reference `SdkDatabaseClient.swift`; immutable value type, so
/// `Sendable`.
public struct SdkColumnInfo: Codable, Equatable, Sendable {
    public let name: String
    public let type: String
    public let nullable: Bool
    public let primaryKey: Bool
    public let defaultValue: String?

    public init(name: String, type: String, nullable: Bool, primaryKey: Bool, defaultValue: String?) {
        self.name = name
        self.type = type
        self.nullable = nullable
        self.primaryKey = primaryKey
        self.defaultValue = defaultValue
    }
}
