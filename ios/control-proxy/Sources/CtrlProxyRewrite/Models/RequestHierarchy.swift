import Foundation

public struct RequestHierarchy: Decodable, Sendable {
    public var requestId: String?
    public var disableAllFiltering: Bool?
    /// Epoch milliseconds accepted on `_if_stale` requests for wire compatibility.
    /// The iOS runner still captures fresh; this timestamp does not enable cache reuse.
    public var sinceTimestamp: Int64?
}

extension RequestHierarchy: CommandPayload {}
