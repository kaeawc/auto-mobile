import Foundation

public struct SdkTableStructureResult: Codable, Equatable, Sendable {
    public let columns: [SdkColumnInfo]
    public let diagnostic: SdkStorageDiagnostic?

    public init(columns: [SdkColumnInfo], diagnostic: SdkStorageDiagnostic? = nil) {
        self.columns = columns
        self.diagnostic = diagnostic
    }
}
