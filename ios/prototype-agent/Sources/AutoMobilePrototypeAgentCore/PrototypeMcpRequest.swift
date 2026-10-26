import Foundation

/// Twin of protoViewerContract.ts. The scheme carries identifiers only, never spec bytes.
enum PrototypeMcpRequest: Hashable, Sendable {
    case importBundle(request: String, label: String?)
    case open(request: String, libraryId: String)
    case unsupported(request: String, reason: String)

    var request: String {
        switch self {
        case let .importBundle(request, _), let .open(request, _), let .unsupported(request, _): request
        }
    }

    /// Nil for foreign URLs or unusable request ids. Callers still consume malformed MCP URLs.
    static func parse(_ url: URL) -> Self? {
        guard url.scheme?.lowercased() == "automobile-proto",
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return nil }
        let items = parts.queryItems ?? []
        guard let request = items.first(where: { $0.name == "request" })?.value,
              validRequestId(request)
        else { return nil }
        guard Set(items.map(\.name)).count == items.count else {
            return .unsupported(request: request, reason: "Duplicate query keys")
        }
        guard parts.user == nil, parts.password == nil, parts.port == nil,
              parts.path.isEmpty, parts.fragment == nil,
              Set(items.map(\.name)).isSubset(of: ["request", "label", "id"])
        else { return .unsupported(request: request, reason: "Unsupported MCP URL") }
        switch parts.host {
        case "import": return .importBundle(request: request, label: items.first(where: { $0.name == "label" })?.value)
        case "open":
            guard let id = items.first(where: { $0.name == "id" })?.value else {
                return .unsupported(request: request, reason: "open needs a library id")
            }
            return .open(request: request, libraryId: id)
        default: return .unsupported(request: request, reason: "Unknown MCP action; update ProtoViewer")
        }
    }

    static func validRequestId(_ request: String) -> Bool {
        (1 ... 64).contains(request.utf8.count) && request.utf8.allSatisfy {
            (65 ... 90).contains($0) || (97 ... 122).contains($0) || (48 ... 57).contains($0) || $0 == 95 || $0 == 45
        }
    }

    static func validLabel(_ label: String) -> Bool {
        let label = label.trimmingCharacters(in: .whitespacesAndNewlines)
        return (1 ... 120).contains(label.utf16.count) && !label.unicodeScalars.contains {
            switch $0.properties.generalCategory {
            case .control, .format, .lineSeparator, .paragraphSeparator: true
            default: false
            }
        }
    }
}
