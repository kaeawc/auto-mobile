import Foundation

/// The agent-side backstop for the `request` action (#12529). The host validator
/// (`prototypeRequest.ts`, `prototypeRequestSchema.ts` and the contract walk) is authoritative; this
/// repeats its rules on the authored tree so a spec that skipped it still fails the show with the
/// offending path instead of misbehaving when tapped.
enum PrototypeRequestValidator {
    /// Every key under which a node holds an action list.
    private static let actionLists: Set<String> = ["onTap", "onLongPress", "onDoubleTap", "onSubmit", "onRefresh"]
    private static let methods = Set(PrototypeRequestMethod.allCases.map(\.rawValue))
    private static let bindingKeys: Set<String> = ["state", "data", "value", "item", "index"]
    private static let headerName = try? NSRegularExpression(pattern: "^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+$")
    private static let templatedURL = try? NSRegularExpression(pattern: "^https?://", options: .caseInsensitive)

    private static let forbiddenHeaders: Set<String> = [
        "host", "connection", "upgrade", "transfer-encoding", "content-length", "te", "trailer",
        "keep-alive", "cookie", "origin", "expect",
    ]

    static func isForbiddenHeader(_ name: String) -> Bool {
        let lower = name.lowercased()
        return forbiddenHeaders.contains(lower) || lower.hasPrefix("proxy-")
    }

    /// Throws the first request rule the authored `root` breaks. `state` is the spec's declared state.
    static func validate(_ root: JSONValue, state: [String: JSONValue]) throws {
        try scan(root, path: "root", state: state)
    }

    /// Walks every object and array for action lists, so a part, span or menu item is covered
    /// without a list of the places an action can live.
    private static func scan(_ value: JSONValue, path: String, state: [String: JSONValue]) throws {
        switch value {
        case let .object(fields):
            for key in fields.keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) }) {
                guard let member = fields[key] else { continue }
                let memberPath = PrototypeLimits.dataMemberPath(path, key: key)
                if actionLists.contains(key), case let .array(actions) = member {
                    try validateList(actions, path: memberPath, depth: 1, state: state)
                } else {
                    try scan(member, path: memberPath, state: state)
                }
            }
        case let .array(items):
            for (index, item) in items.enumerated() {
                try scan(item, path: "\(path)[\(index)]", state: state)
            }
        default:
            break
        }
    }

    private static func validateList(
        _ actions: [JSONValue], path: String, depth: Int, state: [String: JSONValue]
    )
        throws
    {
        for (index, entry) in actions.enumerated() {
            guard case let .object(action) = entry else { continue }
            try validateAction(action, path: "\(path)[\(index)]", depth: depth, state: state)
        }
    }

    private static func validateAction(
        _ action: [String: JSONValue], path: String, depth: Int, state: [String: JSONValue]
    )
        throws
    {
        if action["type"] == .string("emit"), action["name"] == .string(PrototypeRequestEvent.name) {
            throw fail("\(path).name", "The emit name \(PrototypeRequestEvent.name) is reserved for request events")
        }
        if action["type"] == .string("startTimer"), case let .array(nested)? = action["actions"] {
            guard depth < PrototypeLimits.maxActionDepth else {
                throw fail("\(path).actions", "Action nesting depth limit exceeded")
            }
            try validateList(nested, path: "\(path).actions", depth: depth + 1, state: state)
        }
        guard action["type"] == .string("request") else { return }
        try validateUnrepeated(action, path: path, state: state)
        for list in ["onSuccess", "onError"] {
            guard let raw = action[list] else { continue }
            guard case let .array(followUps) = raw, (1 ... PrototypeLimits.maxFollowUpActions).contains(followUps.count)
            else { throw fail("\(path).\(list)", "Expected 1 to \(PrototypeLimits.maxFollowUpActions) actions") }
            guard depth < PrototypeLimits.maxActionDepth else {
                throw fail("\(path).\(list)", "Request action nesting depth limit exceeded")
            }
            try validateList(followUps, path: "\(path).\(list)", depth: depth + 1, state: state)
        }
    }

    private static func validateUnrepeated(
        _ action: [String: JSONValue], path: String, state: [String: JSONValue]
    )
        throws
    {
        let method = try method(action, path: path)
        try url(action["url"], path: "\(path).url")
        if let body = action["body"] {
            guard PrototypeRequestMethod(rawValue: method)?.allowsBody == true else {
                throw fail("\(path).body", "A GET or HEAD request cannot have a body")
            }
            try binding(body, path: "\(path).body")
        }
        if let into = action["into"] { try self.into(into, path: "\(path).into") }
        if let via = action["via"], via != .string("host"), via != .string("device") {
            throw fail("\(path).via", "Expected host or device")
        }
        if let timeout = action["timeoutMs"] {
            guard case let .number(value) = timeout, value == value.rounded(),
                  (1 ... Double(PrototypeLimits.maxRequestTimeoutMs)).contains(value)
            else { throw fail(
                "\(path).timeoutMs",
                "Expected an integer from 1 to \(PrototypeLimits.maxRequestTimeoutMs)"
            ) }
        }
        try statusKey(action["statusKey"], path: "\(path).statusKey", state: state)
        try entries(action["headers"], path: "\(path).headers", isHeader: true)
        try entries(action["query"], path: "\(path).query", isHeader: false)
    }

    private static func method(_ action: [String: JSONValue], path: String) throws -> String {
        guard let raw = action["method"] else { return "GET" }
        guard case let .string(method) = raw, methods.contains(method) else {
            throw fail("\(path).method", "Expected GET, POST, PUT, PATCH, DELETE or HEAD")
        }
        return method
    }

    private static func url(_ raw: JSONValue?, path: String) throws {
        guard case let .string(text)? = raw,
              (1 ... PrototypeLimits.maxRequestURLLength).contains(text.utf16.count)
        else {
            throw fail(path, "Expected a URL of 1 to \(PrototypeLimits.maxRequestURLLength) characters")
        }
        if text.contains("{") {
            let range = NSRange(text.startIndex..., in: text)
            if templatedURL?.firstMatch(in: text, range: range) == nil {
                throw fail(path, "A templated request url must start with a literal http:// or https://")
            }
        } else if case .failure = PrototypeRequestURL.resolve(text, query: []) {
            throw fail(path, "A request url must be an absolute http or https URL")
        }
    }

    /// `/data/<pointer>` naming an object member, so `<into>__meta` can sit beside it.
    private static func into(_ raw: JSONValue, path: String) throws {
        let message = "request into is /data/<RFC 6901 pointer> and addresses a member of data"
        guard case let .string(text) = raw else { throw fail(path, message) }
        let bound = text.split(separator: "/", omittingEmptySubsequences: false)
            .map { $0 == "{index}" ? "0" : String($0) }.joined(separator: "/")
        guard let pointer = PrototypeDataWrite.pointer(ofPath: bound) else { throw fail(path, message) }
        let last = pointer.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? ""
        if last == "-" || (!last.isEmpty && last.allSatisfy { $0.isASCII && $0.isNumber }) {
            throw fail(
                path,
                "request into must name an object member, not an array element, so into__meta can be written beside it"
            )
        }
    }

    /// A declared string state key; a key holding a placeholder is bound per repeat row and checked only there.
    private static func statusKey(_ raw: JSONValue?, path: String, state: [String: JSONValue]) throws {
        guard let raw else { return }
        guard case let .string(key) = raw, !key.isEmpty else { throw fail(path, "statusKey must be a state key") }
        guard !key.contains("{") else { return }
        guard let stored = state[key] else { throw fail(path, "statusKey must name a declared state key") }
        guard stored.stringValue != nil else { throw fail(path, "statusKey requires a string state key") }
    }

    private static func entries(_ raw: JSONValue?, path: String, isHeader: Bool) throws {
        guard let raw else { return }
        guard case let .object(fields) = raw, fields.count <= PrototypeLimits.maxRequestEntries else {
            throw fail(path, "Expected an object of at most \(PrototypeLimits.maxRequestEntries) entries")
        }
        var seenHeaders = Set<String>()
        for name in fields.keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) }) {
            let entryPath = PrototypeLimits.dataMemberPath(path, key: name)
            if isHeader, isForbiddenHeader(name) {
                throw fail(entryPath, "Forbidden request header")
            }
            let range = NSRange(name.startIndex..., in: name)
            // Header names are case-insensitive, so `X-Test` and `x-test` are one header given twice.
            if isHeader, !seenHeaders.insert(name.lowercased()).inserted {
                throw fail(entryPath, "Duplicate header name (names are case-insensitive)")
            }
            if name.isEmpty || (isHeader && headerName?.firstMatch(in: name, range: range) == nil) {
                throw fail(entryPath, isHeader ? "Invalid header name" : "Invalid query name")
            }
            let literal = fields[name]?.stringValue ?? fields[name]?.objectFields?["value"]?.stringValue
            if isHeader, let literal, literal.unicodeScalars.contains(where: { $0.value == 13 || $0.value == 10 }) {
                throw fail(entryPath, "CR/LF in header value")
            }
            switch fields[name] {
            case let .string(text)?:
                if text.utf16.count > PrototypeLimits.maxRequestEntryLength {
                    throw fail(entryPath, "Entry is longer than \(PrototypeLimits.maxRequestEntryLength) characters")
                }
            case let .object(form)?:
                try binding(.object(form), path: entryPath)
                if let literal = form["value"], !literal.isScalar {
                    throw fail("\(entryPath).value", "A header or query literal must be a string, number or boolean")
                }
            default:
                throw fail(entryPath, "Expected a string or a value binding")
            }
        }
    }

    /// Exactly one of `state`, `data`, `value`, `item`, `index: true`.
    private static func binding(_ raw: JSONValue, path: String) throws {
        guard case let .object(form) = raw, form.count == 1, let key = form.keys.first,
              bindingKeys.contains(key), key != "index" || form[key] == .bool(true)
        else { throw fail(path, "Expected one value binding: state, data, value, item or index") }
    }

    private static func fail(_ path: String, _ message: String) -> DecodingError {
        PrototypeLimits.violation(path, message)
    }
}
