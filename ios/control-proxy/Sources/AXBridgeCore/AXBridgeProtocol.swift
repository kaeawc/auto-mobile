import Foundation

public enum AXBridgeRequestID: Codable, Equatable, Sendable {
    case string(String)
    case integer(Int)

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            self = .string(value)
        } else {
            self = try .integer(container.decode(Int.self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .integer(value): try container.encode(value)
        }
    }
}

public enum AXBridgeCommand: String, Codable, Sendable {
    case invokeAction = "invoke-action"
}

public struct AXBridgeRequest: Codable, Equatable, Sendable {
    public let id: AXBridgeRequestID
    public let command: AXBridgeCommand
    public let actionName: String
    public let elementId: String?
    public let elementDesc: String?

    public init(id: AXBridgeRequestID, actionName: String, elementId: String? = nil, elementDesc: String? = nil) {
        self.id = id
        command = .invokeAction
        self.actionName = actionName
        self.elementId = elementId
        self.elementDesc = elementDesc
    }
}

public struct AXBridgeDecodeError: Error, Equatable, Sendable {
    public let id: AXBridgeRequestID?
    public let error: AXBridgeError

    public init(id: AXBridgeRequestID?, error: AXBridgeError) {
        self.id = id
        self.error = error
    }
}

public struct AXBridgeResponse: Codable, Equatable, Sendable {
    public let id: AXBridgeRequestID?
    public let ok: Bool
    public let error: AXBridgeError?

    public init(id: AXBridgeRequestID?, error: AXBridgeError? = nil) {
        self.id = id
        ok = error == nil
        self.error = error
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        // An undecodable request still gets an explicit null correlation id.
        try container.encode(id, forKey: .id)
        try container.encode(ok, forKey: .ok)
        try container.encodeIfPresent(error, forKey: .error)
    }

    /// Compact JSON followed by exactly one framing newline. Newlines in strings are escaped by Codable.
    public func encodedLine() throws -> String {
        try String(decoding: JSONEncoder().encode(self), as: UTF8.self) + "\n"
    }
}

public enum AXBridgeProtocol {
    private struct Identifier: Decodable {
        let id: AXBridgeRequestID?
    }

    private struct Envelope: Decodable {
        let command: String
    }

    public static func decode(_ line: String) -> Result<AXBridgeRequest, AXBridgeDecodeError> {
        let data = Data(line.utf8)
        let decoder = JSONDecoder()
        let id = (try? decoder.decode(Identifier.self, from: data))?.id
        do {
            let envelope = try decoder.decode(Envelope.self, from: data)
            guard AXBridgeCommand(rawValue: envelope.command) != nil else {
                return .failure(AXBridgeDecodeError(id: id, error: AXBridgeError(
                    code: "unknown_command", message: "Unsupported command: \(envelope.command). Use invoke-action."
                )))
            }
            let request = try decoder.decode(AXBridgeRequest.self, from: data)
            guard !request.actionName.isEmpty,
                  [request.elementId, request.elementDesc].contains(where: { $0?.isEmpty == false })
            else {
                return .failure(AXBridgeDecodeError(id: id, error: AXBridgeError(
                    code: "invalid_request", message: "Provide actionName and a nonempty elementId or elementDesc."
                )))
            }
            return .success(request)
        } catch {
            return .failure(AXBridgeDecodeError(id: id, error: AXBridgeError(
                code: "malformed_request",
                message: "Expected a JSON invoke-action request: \(error.localizedDescription)"
            )))
        }
    }

    public static func response(
        for line: String,
        execute: (AXBridgeRequest) -> Result<Void, AXBridgeError>
    )
        -> AXBridgeResponse
    {
        switch decode(line) {
        case let .failure(failure):
            return AXBridgeResponse(id: failure.id, error: failure.error)
        case let .success(request):
            switch execute(request) {
            case .success: return AXBridgeResponse(id: request.id)
            case let .failure(error): return AXBridgeResponse(id: request.id, error: error)
            }
        }
    }
}
