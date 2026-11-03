import Foundation

/// Rules for the `webView` node (#14312) that the contract cannot express, the twin of the host's
/// `prototypeWebView.ts`: `webview` in `requires.platform`; allowed origins that name a DNS host, never
/// an IP literal or `localhost`; a literal URL authority that is one of the allowed origins; and
/// navigation, title and back keys that name declared state of the right type. Contract only: no
/// runtime draws a web view.
enum PrototypeWebView {
    private static let webViewCalls: Set<String> = ["webview.back", "webview.reload"]
    private static let stateKeys: [(field: String, boolean: Bool)] = [
        ("navigationStateKey", false), ("titleKey", false), ("canGoBackKey", true),
    ]

    /// The ids of the spec's `webView` nodes, the values a `webview.*` `node` argument may name. Only
    /// node positions are walked, so a webView-shaped value in an action payload is never a page.
    static func ids(_ root: JSONValue) -> Set<String> {
        guard let fields = root.objectFields else { return [] }
        return nodeIds(.init(value: fields, path: "root"))
    }

    private static func nodeIds(_ node: PrototypeLocatedValue) -> Set<String> {
        var found = PrototypeStrictRepeats.children(node.value, path: node.path)
            .reduce(into: Set<String>()) { $0.formUnion(nodeIds($1)) }
        if node.value["type"] == .string("webView"), let id = node.value["id"]?.stringValue {
            found.insert(id)
        }
        return found
    }

    /// `localhost`, a `.localhost` name, or a host a URL parser would read as an IP address: one whose
    /// last label is decimal digits or `0x` hexadecimal.
    static func isPrivateHost(_ host: String) -> Bool {
        if host == "localhost" || host.hasSuffix(".localhost") { return true }
        let last = host.split(separator: ".", omittingEmptySubsequences: false).last.map(String.init) ?? host
        let isDigit: (Character) -> Bool = { ("0" ... "9").contains($0) }
        if !last.isEmpty, last.allSatisfy(isDigit) { return true }
        guard last.hasPrefix("0x") else { return false }
        return last.dropFirst(2).allSatisfy { isDigit($0) || ("a" ... "f").contains($0) }
    }

    /// Throws at the first `webView` node rule a spec breaks.
    static func validateNodes(_ spec: [String: JSONValue], nodes: [PrototypeLocatedValue]) throws {
        let webViews = nodes.filter { $0.value["type"] == .string("webView") }
        guard !webViews.isEmpty else { return }
        let requires = spec["requires"]?.objectFields
        let declared = PrototypeContractValidator.strings(requires?["platform"]).contains("webview")
        let state = spec["state"]?.objectFields ?? [:]
        for webView in webViews {
            try validateNode(webView.value, path: webView.path, declared: declared, state: state)
        }
    }

    private static func validateNode(
        _ node: [String: JSONValue], path: String, declared: Bool, state: [String: JSONValue]
    ) throws {
        guard declared else {
            throw PrototypeLimits.violation(path, "webView requires webview in requires.platform")
        }
        let entries: [JSONValue] = if case let .array(values)? = node["allowedOrigins"] { values } else { [] }
        let origins = entries.compactMap(\.stringValue)
        if let index = origins.firstIndex(where: { isPrivateHost(host(of: $0)) }) {
            throw PrototypeLimits.violation(
                "\(path).allowedOrigins[\(index)]",
                "allowedOrigins must name a DNS host, not localhost or an IP address"
            )
        }
        if let url = node["url"]?.stringValue, let authority = literalAuthority(url),
           !origins.contains("https://\(authority.lowercased())")
        {
            throw PrototypeLimits.violation("\(path).url", "webView url origin must be one of allowedOrigins")
        }
        for (field, boolean) in stateKeys {
            guard let key = node[field]?.stringValue else { continue }
            if !holds(state[key], boolean: boolean) {
                throw PrototypeLimits.violation(
                    "\(path).\(field)", "\(field) must name a declared \(boolean ? "boolean" : "string") state key"
                )
            }
        }
    }

    /// The host of an `https://host[:port]` origin the contract pattern already accepted.
    private static func host(of origin: String) -> String {
        let rest = origin.hasPrefix("https://") ? String(origin.dropFirst("https://".count)) : origin
        return rest.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? rest
    }

    /// The authority of an `https://` URL when it holds no placeholder; otherwise nil. It is read by
    /// Unicode scalar, not `Character`: a combining mark after a delimiter joins it in one grapheme
    /// cluster, and the host and Kotlin validators split on the delimiter alone.
    private static func literalAuthority(_ url: String) -> String? {
        let scheme = "https://".unicodeScalars
        guard url.unicodeScalars.starts(with: scheme) else { return nil }
        let delimiters = "/?#".unicodeScalars
        let scalars = url.unicodeScalars.dropFirst(scheme.count).prefix { !delimiters.contains($0) }
        guard !scalars.contains("{") else { return nil }
        var authority = ""
        authority.unicodeScalars.append(contentsOf: scalars)
        return authority
    }

    private static func holds(_ value: JSONValue?, boolean: Bool) -> Bool {
        switch value {
        case .bool?: return boolean
        case .string?: return !boolean
        default: return false
        }
    }

    /// Throws when a `webview.*` call's literal `node` argument names no `webView` node.
    static func call(_ action: [String: JSONValue], path: String, webViews: Set<String>) throws {
        guard let call = action["call"]?.stringValue, webViewCalls.contains(call) else { return }
        guard let target = action["args"]?.objectFields?["node"]?.objectFields?["value"]?.stringValue,
              !webViews.contains(target)
        else { return }
        throw PrototypeLimits.violation("\(path).args.node.value", "Unknown webView")
    }
}
