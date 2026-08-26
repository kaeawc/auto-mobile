import Foundation

public struct RequestAddHighlight: Decodable, Sendable {
    public var requestId: String?
    public var id: String?
    public var shape: HighlightShape?
}

extension RequestAddHighlight: CommandPayload {}
