import Foundation

/// Canonical normalizer for a user-supplied AutoMobile MCP endpoint into the StreamableHTTP route
/// (`…/auto-mobile/streamable`). Shared by `AutoMobileTestCase` and `AutoMobileTestTimingClient` so
/// both transports resolve an endpoint identically (one canonical primitive per concern).
enum MCPEndpoint {
    /// Append the `auto-mobile/streamable` route to `endpoint`, operating on the parsed URL path so
    /// existing query items are preserved and a trailing slash or an already-`/auto-mobile` suffix does
    /// not produce a duplicated or misplaced segment. A string that does not parse as a URL is returned
    /// trimmed, letting the caller's own `URL(string:)` guard reject it exactly as before.
    static func normalize(_ endpoint: String) -> String {
        let trimmed = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed) else {
            return trimmed
        }
        let path = components.path
        // Already a full MCP route — leave untouched. Checked on the path (not the whole string) so a
        // stray "streamable" inside a query no longer forces passthrough.
        if path.contains("/auto-mobile/streamable") || path.contains("/auto-mobile/sse") {
            return trimmed
        }
        var basePath = path
        while basePath.hasSuffix("/") {
            basePath.removeLast()
        }
        components.path = basePath.hasSuffix("/auto-mobile")
            ? "\(basePath)/streamable"
            : "\(basePath)/auto-mobile/streamable"
        return components.string ?? trimmed
    }
}
