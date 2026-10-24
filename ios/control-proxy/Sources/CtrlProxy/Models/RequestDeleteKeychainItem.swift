import AutoMobileSdkWire
import Foundation

public struct RequestDeleteKeychainItem: Decodable, Sendable, CommandPayload {
    public let requestId: String?
    public let appId: String?
    public let sessionId: String?
    public let mutationToken: String?
    public let confirm: Bool
    public let selector: KeychainItemSelector
}

public struct DeleteKeychainItemResponse: Encodable, Sendable, WebSocketResponsePayload {
    public let type = ResponseType.deleteKeychainItemResult.rawValue
    public let requestId: String?
    public let success: Bool
    public let outcome: String
    public let deletedScope: KeychainItemSelector?
    public let error: String?
    public let totalTimeMs: Int64

    public init(requestId: String?, outcome: KeychainDeleteOutcome, totalTimeMs: Int64, error: String? = nil) {
        self.requestId = requestId
        success = error == nil && outcome.outcome == "deleted"
        self.outcome = outcome.outcome
        deletedScope = outcome.deletedScope
        self.error = error
        self.totalTimeMs = totalTimeMs
    }
}
