import Foundation

enum MCPJSONRPCHelpers {
    static func encodeParams(_ params: [String: Any], failureMessage: String) throws -> Data {
        // Foundation can raise an Objective-C exception for unsupported values, outside Swift's
        // throws mechanism. Validate first so encoding failure remains a recoverable client error.
        guard JSONSerialization.isValidJSONObject(params),
              let data = try? JSONSerialization.data(withJSONObject: params)
        else {
            throw MCPClientError.requestFailed(failureMessage)
        }
        return data
    }

    static func extractTextContent(from result: [String: Any]) throws -> String {
        guard let content = result["content"] as? [[String: Any]] else {
            throw MCPClientError.invalidResponse("Missing content array")
        }
        for item in content {
            if let type = item["type"] as? String, type == "text",
               let text = item["text"] as? String
            {
                return text
            }
        }
        throw MCPClientError.invalidResponse("Missing text content")
    }

    static func extractResourceTextContent(from result: [String: Any]) throws -> String {
        guard let contents = result["contents"] as? [[String: Any]], let first = contents.first else {
            throw MCPClientError.invalidResponse("Missing resource contents")
        }
        if let text = first["text"] as? String {
            return text
        }
        throw MCPClientError.invalidResponse("Missing resource text content")
    }
}
