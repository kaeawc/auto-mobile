import Foundation

/// Column structure of a single inspected table returned by the in-app SDK. Ported
/// from the reference `SdkDatabaseClient.swift`; immutable value type, so `Sendable`.
public struct SdkTableStructureResult: Codable, Equatable, Sendable {
    public let columns: [SdkColumnInfo]
    public let diagnostic: SdkStorageDiagnostic?

    public init(columns: [SdkColumnInfo], diagnostic: SdkStorageDiagnostic? = nil) {
        self.columns = columns
        self.diagnostic = diagnostic
    }
}
