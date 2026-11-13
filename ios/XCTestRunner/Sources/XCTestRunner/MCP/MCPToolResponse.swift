/// The text payload extracted from an MCP `tools/call` response.
public struct MCPToolResponse: Sendable {
    public let text: String
    public let isError: Bool

    public init(text: String, isError: Bool = false) {
        self.text = text
        self.isError = isError
    }
}
