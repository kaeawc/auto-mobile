import Foundation

// The network mock and fault rule shapes the runner forwards to the SDK's `/network/mock`,
// `/network/faults` and `/network/error-simulation` routes. The SDK decodes them; the runner decodes
// the host's request and re-encodes the same values, so one declaration serves both.

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

/// A mock rule the device's regex engine refused, with its reason (issue #10101).
public struct RejectedMockRule: Codable, Equatable, Sendable {
    public let mockId: String
    public let reason: String

    public init(mockId: String, reason: String) {
        self.mockId = mockId
        self.reason = reason
    }
}

public struct NetworkErrorSimulationDTO: Codable, Sendable, Equatable {
    public let enabled: Bool
    public let errorType: String?
    public let limit: Int?
    public let expiresAtEpochMs: Int64?
    /// Time left, timed by the device's own monotonic clock; preferred over the host-clock epoch (#10062).
    public let remainingMs: Int64?

    public init(
        enabled: Bool, errorType: String?, limit: Int?, expiresAtEpochMs: Int64?, remainingMs: Int64? = nil
    ) {
        self.enabled = enabled
        self.errorType = errorType
        self.limit = limit
        self.expiresAtEpochMs = expiresAtEpochMs
        self.remainingMs = remainingMs
    }
}

public enum NetworkFaultTransport: String, Codable, Equatable, Sendable {
    case urlSession
    case webSocket
    case nwConnection
    case webView
}

public enum NetworkFaultAction: String, Codable, Equatable, Sendable {
    case response
    case status
    case error
    case latency
    case bandwidth
    case dropBytes
    case closeConnection
    case rejectFrame
}

public struct NetworkFaultRuleDTO: Codable, Equatable, Sendable {
    public let faultId: String
    public let transport: NetworkFaultTransport?
    public let host: String?
    public let port: Int?
    public let scheme: String?
    public let path: String?
    public let method: String?
    public let headers: [String: String]?
    public let origin: String?
    public let connectionId: String?
    public let sessionId: String?
    public let action: NetworkFaultAction
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

    public init(
        faultId: String, transport: NetworkFaultTransport?, host: String?, port: Int?,
        scheme: String?, path: String?, method: String?, headers: [String: String]?,
        origin: String?, connectionId: String?, sessionId: String?, action: NetworkFaultAction,
        statusCode: Int?, responseHeaders: [String: String]?, responseBody: String?,
        contentType: String?, errorType: String?, delayMs: Int?,
        bandwidthBytesPerSecond: Int?, dropBytes: Int?, limit: Int?,
        expiresAtEpochMs: Int64?, scope: String?, dryRun: Bool
    ) {
        self.faultId = faultId; self.transport = transport; self.host = host; self.port = port
        self.scheme = scheme; self.path = path; self.method = method; self.headers = headers
        self.origin = origin; self.connectionId = connectionId; self.sessionId = sessionId
        self.action = action; self.statusCode = statusCode; self.responseHeaders = responseHeaders
        self.responseBody = responseBody; self.contentType = contentType; self.errorType = errorType
        self.delayMs = delayMs; self.bandwidthBytesPerSecond = bandwidthBytesPerSecond
        self.dropBytes = dropBytes; self.limit = limit; self.expiresAtEpochMs = expiresAtEpochMs
        self.scope = scope; self.dryRun = dryRun
    }
}

/// Body of `POST /network/mock`.
public struct SetMockRulesBody: Codable, Sendable {
    public let rules: [NetworkMockRuleDTO]

    public init(rules: [NetworkMockRuleDTO]) {
        self.rules = rules
    }
}

/// Body of `POST /network/faults`.
public struct SetNetworkFaultRulesBody: Codable, Sendable {
    public let rules: [NetworkFaultRuleDTO]

    public init(rules: [NetworkFaultRuleDTO]) {
        self.rules = rules
    }
}

/// The SDK's reply to `POST /network/mock`; `rejected` is absent from an SDK that predates issue #10101.
public struct SetMockRulesReply: Codable, Sendable {
    public let rejected: [RejectedMockRule]?

    public init(rejected: [RejectedMockRule]?) {
        self.rejected = rejected
    }
}
