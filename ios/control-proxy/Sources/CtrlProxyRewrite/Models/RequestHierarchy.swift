import Foundation

public struct RequestHierarchy: Decodable, Sendable {
    public var requestId: String?
    public var disableAllFiltering: Bool?
    /// Epoch milliseconds. Only `_if_stale` reuses a capture strictly newer than this.
    /// Absent timestamps preserve the legacy unconditional capture.
    public var sinceTimestamp: Int64?
}

extension RequestHierarchy: CommandPayload {}
