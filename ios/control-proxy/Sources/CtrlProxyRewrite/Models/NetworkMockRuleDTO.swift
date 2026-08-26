import Foundation

public struct NetworkMockRuleDTO: Codable, Sendable, Equatable {
    public let mockId: String
    public let host: String
    public let path: String
    public let method: String
    public let limit: Int?
    public let remaining: Int?
    public let statusCode: Int
    public let responseHeaders: [String: String]
    public let responseBody: String
    public let contentType: String

    public init(
        mockId: String,
        host: String,
        path: String,
        method: String,
        limit: Int?,
        remaining: Int?,
        statusCode: Int,
        responseHeaders: [String: String],
        responseBody: String,
        contentType: String
    ) {
        self.mockId = mockId
        self.host = host
        self.path = path
        self.method = method
        self.limit = limit
        self.remaining = remaining
        self.statusCode = statusCode
        self.responseHeaders = responseHeaders
        self.responseBody = responseBody
        self.contentType = contentType
    }
}
