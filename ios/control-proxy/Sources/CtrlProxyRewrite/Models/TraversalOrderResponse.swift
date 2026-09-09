import Foundation

/// `traversal_order_result` — accessibility elements in VoiceOver traversal
/// (depth-first) order. Mirrors Android's `TraversalOrderResult` (#3924). Ported
/// from the reference `Models.swift`; `Codable, Sendable`. Note: this envelope
/// carries no `timestamp` field (parity with the reference); `totalCount` is
/// derived from `elements.count` in the initializer.
public struct TraversalOrderResponse: Codable, Sendable {
    public let type: String
    public let requestId: String?
    public let success: Bool
    public let elements: [UIElementInfo]
    public let focusedIndex: Int?
    public let totalCount: Int
    public let totalTimeMs: Int64
    public let error: String?

    public init(
        requestId: String? = nil,
        elements: [UIElementInfo] = [],
        focusedIndex: Int? = nil,
        totalTimeMs: Int64,
        error: String? = nil
    ) {
        type = ResponseType.traversalOrderResult.rawValue
        self.requestId = requestId
        success = error == nil
        self.elements = elements
        self.focusedIndex = focusedIndex
        totalCount = elements.count
        self.totalTimeMs = totalTimeMs
        self.error = error
    }
}
