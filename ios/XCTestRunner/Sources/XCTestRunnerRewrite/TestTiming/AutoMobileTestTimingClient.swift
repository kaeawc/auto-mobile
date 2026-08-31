import Foundation

/// Thin wrapper that picks the same transport the executor uses (StreamableHTTP if an MCP URL is set,
/// else the daemon socket) and reads a resource. Used by `TestTimingCache` to fetch timing data.
final class AutoMobileTestTimingClient {
    private let mcpClient: AutoMobileMCPClient

    init(environment: AutoMobileEnvironment) throws {
        if let endpoint = environment.firstNonEmpty([
            "AUTOMOBILE_MCP_URL",
            "AUTOMOBILE_MCP_HTTP_URL",
            "MCP_ENDPOINT",
        ]) {
            let normalizedEndpoint = AutoMobileTestTimingClient.normalizeEndpoint(endpoint)
            guard let endpointURL = URL(string: normalizedEndpoint) else {
                throw MCPClientError.invalidEndpoint(normalizedEndpoint)
            }
            mcpClient = try StreamableHTTPMCPClient(endpoint: endpointURL)
        } else {
            let socketPath = environment.firstNonEmpty([
                "AUTOMOBILE_DAEMON_SOCKET_PATH",
                "AUTO_MOBILE_DAEMON_SOCKET_PATH",
            ]) ?? AutoMobileDaemonSocket.defaultPath
            mcpClient = AutoMobileDaemonClient(socketPath: socketPath)
        }
    }

    func readResource(uri: String, timeout: TimeInterval) throws -> String {
        let response = try mcpClient.readResource(uri: uri, timeout: timeout)
        return response.text
    }

    private static func normalizeEndpoint(_ endpoint: String) -> String {
        let trimmed = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.contains("/auto-mobile/streamable") || trimmed.contains("/auto-mobile/sse") {
            return trimmed
        }
        if trimmed.hasSuffix("/auto-mobile") {
            return "\(trimmed)/streamable"
        }
        return "\(trimmed)/auto-mobile/streamable"
    }
}
