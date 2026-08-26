import Foundation

public struct NetworkFaultRuleDTO: Codable, Sendable, Equatable {
    public let faultId: String
    public let transport: String?
    public let host: String?
    public let port: Int?
    public let scheme: String?
    public let path: String?
    public let method: String?
    public let headers: [String: String]?
    public let origin: String?
    public let connectionId: String?
    public let sessionId: String?
    public let action: String
    public let statusCode: Int?
    public let responseHeaders: [String: String]?
    public let responseBody: String?
    public let contentType: String?
    public let errorType: String?
    public let delayMs: Int?
    public let bandwidthBytesPerSecond: Int?
    public let dropBytes: Int?
    public let limit: Int?
    public let expiresAtEpochMs: Int64?
    public let scope: String?
    public let dryRun: Bool
}
