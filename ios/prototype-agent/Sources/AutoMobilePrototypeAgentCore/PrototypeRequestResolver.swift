import Foundation

/// Resolves a `request` action's bindings at the moment it runs: the Swift twin of
/// `resolvePrototypeRequest` (`src/features/prototype/prototypeRequest.ts`). `item` and `index`
/// are bound by repeat expansion before an action runs, so a binding that still names one fails
/// the request as `invalid_request`.
struct PrototypeResolvedRequest: Equatable {
    let method: PrototypeRequestMethod
    let url: String
    let headers: [String: String]
    let body: JSONValue?
}

enum PrototypeRequestResolver {
    /// `action.url` after text placeholders, before the query. Kept apart so a failed request can
    /// still report the URL it tried.
    static func urlText(_ action: PrototypeAction, inputs: some PrototypeEmitContextInputs) -> String {
        bindText(action.url ?? "", inputs: inputs)
    }

    static func resolve(
        _ action: PrototypeAction, urlText: String, inputs: some PrototypeEmitContextInputs
    )
        -> Result<PrototypeResolvedRequest, PrototypeRequestError>
    {
        guard urlText.utf16.count <= PrototypeLimits.maxSubstitutedTextLength else {
            return .failure(.init(
                .invalidURL,
                "The URL is longer than \(PrototypeLimits.maxSubstitutedTextLength) characters"
            ))
        }
        var headers: [String: String] = [:]
        var query: [(name: String, value: String)] = []
        for (field, entries) in [("headers", action.headers), ("query", action.query)] {
            // JSON objects are unordered in Swift, so every runtime uses sorted key order (UTF-16 code
            // units, like JS `sort()`) for a canonical query.
            for name in (entries ?? [:]).keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) }) {
                switch entryText(entries?[name], what: "\(field).\(name)", inputs: inputs) {
                case let .success(text):
                    if field == "headers" {
                        if headers.keys.contains(where: { $0.lowercased() == name.lowercased() }) {
                            return .failure(.init(.invalidRequest, "headers.\(name): duplicate header name"))
                        }
                        headers[name] = text
                    } else {
                        query.append((name, text))
                    }
                case let .failure(error):
                    return .failure(error)
                }
            }
        }
        var body: JSONValue?
        if let binding = action.body {
            switch PrototypeDataWrite.resolveValue(binding, inputs: inputs) {
            case let .success(value): body = value
            case let .failure(failure):
                return .failure(.init(.invalidRequest, "body: \(failure.message)"))
            }
        }
        let url: String
        switch PrototypeRequestURL.resolve(urlText, query: query) {
        case let .success(resolved): url = resolved
        case let .failure(error): return .failure(error)
        }
        let method = action.method.flatMap(PrototypeRequestMethod.init(rawValue:)) ?? .get
        return .success(PrototypeResolvedRequest(method: method, url: url, headers: headers, body: body))
    }

    /// One header or query entry as text: a literal string with placeholders, or a binding that
    /// must resolve to a string, number or boolean.
    private static func entryText(
        _ raw: JSONValue?, what: String, inputs: some PrototypeEmitContextInputs
    )
        -> Result<String, PrototypeRequestError>
    {
        if case let .string(literal)? = raw { return .success(bindText(literal, inputs: inputs)) }
        guard let raw else { return .failure(.init(.invalidRequest, "\(what) is missing")) }
        switch PrototypeDataWrite.resolveValue(raw, inputs: inputs) {
        case let .failure(failure):
            return .failure(.init(.invalidRequest, "\(what): \(failure.message)"))
        case let .success(value):
            guard value.isScalar, PrototypeDataValues.isScalar(value) else {
                return .failure(.init(.invalidRequest, "\(what) must resolve to a string, number or boolean"))
            }
            return .success(value.displayString)
        }
    }

    // MARK: Text placeholders

    /// `{key}` (state) and `{data:/pointer}` in one left-to-right pass, so a substituted value is
    /// never scanned again. A missing state key stays as written, a missing or non-scalar data
    /// pointer is empty (`interpolatePrototypeText` and `PrototypeDataText`). `{page}` and
    /// `{pageCount}` resolve only inside a pager, so they stay literal here.
    static func bindText(_ text: String, inputs: some PrototypeEmitContextInputs) -> String {
        let scalars = Array(text.unicodeScalars)
        var out = String.UnicodeScalarView()
        var index = 0
        while index < scalars.count {
            guard scalars[index] == "{", let close = scalars[index...].firstIndex(of: "}"),
                  let value = substitution(scalars[(index + 1) ..< close], inputs: inputs)
            else {
                out.append(scalars[index])
                index += 1
                continue
            }
            out.append(contentsOf: value.unicodeScalars)
            index = close + 1
        }
        return String(out)
    }

    private static func substitution(
        _ token: ArraySlice<Unicode.Scalar>, inputs: some PrototypeEmitContextInputs
    )
        -> String?
    {
        let name = String(String.UnicodeScalarView(token))
        if name.hasPrefix("data:") {
            let pointer = String(name.dropFirst("data:".count))
            guard PrototypeDataPointer.isValid(pointer) else { return nil }
            guard let value = inputs.data(pointer), PrototypeDataValues.isScalar(value) else { return "" }
            return value.displayString
        }
        guard isKey(token), name != "page", name != "pageCount" else { return nil }
        return inputs.state(name)?.displayString
    }

    private static func isKey(_ token: ArraySlice<Unicode.Scalar>) -> Bool {
        func start(_ scalar: Unicode.Scalar) -> Bool {
            ("A" ... "Z").contains(scalar) || ("a" ... "z").contains(scalar) || scalar == "_"
        }
        guard let first = token.first, start(first) else { return false }
        return token.allSatisfy { start($0) || ("0" ... "9").contains($0) }
    }
}

// MARK: URL

/// The resolved request URL: the Swift twin of `new URL(url)` plus `searchParams.set` for the
/// parts a request needs. It lowercases the scheme and host, drops a default port, percent-encodes
/// what a URL cannot hold and, when `query` has entries, sets each name on the raw query pieces (the
/// first occurrence replaced in place, later ones removed, new names appended), form-encoding only
/// the pieces it sets.
/// Dot-segments in the path are not collapsed.
enum PrototypeRequestURL {
    static func resolve(
        _ text: String, query: [(name: String, value: String)]
    )
        -> Result<String, PrototypeRequestError>
    {
        guard let separator = text.range(of: "://") else {
            return .failure(.init(.invalidURL, "Not an absolute URL: \(text)"))
        }
        let scheme = text[..<separator.lowerBound].lowercased()
        guard scheme == "http" || scheme == "https" else {
            return .failure(.init(.invalidURL, "Only http and https URLs are supported, got \(scheme):"))
        }
        var rest = String(text[separator.upperBound...])
        var fragment: String?
        if let hash = rest.firstIndex(of: "#") {
            fragment = String(rest[rest.index(after: hash)...])
            rest = String(rest[..<hash])
        }
        var rawQuery: String?
        if let mark = rest.firstIndex(of: "?") {
            rawQuery = String(rest[rest.index(after: mark)...])
            rest = String(rest[..<mark])
        }
        let authorityEnd = rest.firstIndex(of: "/") ?? rest.endIndex
        let authority = String(rest[..<authorityEnd])
        let path = String(rest[authorityEnd...])
        guard let host = normalizedAuthority(authority, scheme: scheme) else {
            return .failure(.init(.invalidURL, "Not an absolute URL: \(text)"))
        }
        var url = "\(scheme)://\(host)\(path.isEmpty ? "/" : encode(path, allowed: .urlPathAllowed))"
        if !query.isEmpty {
            url += "?" + settingQuery(query, in: rawQuery.map { encode($0, allowed: .urlQueryAllowed) } ?? "")
        } else if let rawQuery {
            url += "?" + encode(rawQuery, allowed: .urlQueryAllowed)
        }
        if let fragment { url += "#" + encode(fragment, allowed: .urlFragmentAllowed) }
        return .success(url)
    }

    /// `user:pass@host:port` with a lowercased host and no default port; nil when the host is
    /// empty or holds a character no host can.
    private static func normalizedAuthority(_ authority: String, scheme: String) -> String? {
        var userInfo = ""
        var hostPort = authority
        if let at = authority.lastIndex(of: "@") {
            userInfo = encode(
                String(authority[..<at]),
                allowed: CharacterSet.urlUserAllowed.union(CharacterSet(charactersIn: ":"))
            ) + "@"
            hostPort = String(authority[authority.index(after: at)...])
        }
        var host = hostPort
        var port: String?
        if !hostPort.hasPrefix("["), let colon = hostPort.lastIndex(of: ":") {
            host = String(hostPort[..<colon])
            port = String(hostPort[hostPort.index(after: colon)...])
        } else if hostPort.hasPrefix("["), let close = hostPort.firstIndex(of: "]") {
            host = String(hostPort[...close])
            let after = hostPort[hostPort.index(after: close)...]
            if after.hasPrefix(":") { port = String(after.dropFirst()) }
        }
        let forbidden = CharacterSet.whitespacesAndNewlines.union(.controlCharacters)
            .union(CharacterSet(charactersIn: "<>^|\\%"))
        guard !host.isEmpty, host.unicodeScalars.allSatisfy({ !forbidden.contains($0) }) else { return nil }
        var suffix = ""
        if let port, !port.isEmpty {
            guard port.allSatisfy(\.isASCII), port.allSatisfy(\.isNumber), let number = Int(port),
                  number <= 65535 else { return nil }
            let isDefault = (scheme == "http" && number == 80) || (scheme == "https" && number == 443)
            if !isDefault { suffix = ":\(number)" }
        }
        return userInfo + host.lowercased() + suffix
    }

    /// Percent-encodes what `allowed` (plus an existing `%`) does not cover, as UTF-8.
    static func encode(_ text: String, allowed: CharacterSet) -> String {
        var out = ""
        for byte in text.utf8 {
            let scalar = Unicode.Scalar(byte)
            if byte < 0x80, allowed.contains(scalar) || scalar == "%" {
                out.unicodeScalars.append(scalar)
            } else {
                out += String(format: "%%%02X", UInt32(byte))
            }
        }
        return out
    }

    private static func decode(_ component: String) -> String {
        let plusAsSpace = component.replacingOccurrences(of: "+", with: " ")
        return plusAsSpace.removingPercentEncoding ?? plusAsSpace
    }

    /// Sets each entry (the caller passes them in sorted key order) on the raw `&`-separated pieces:
    /// a key's first existing piece is replaced in place and its later duplicates removed, an absent
    /// key is appended. Only set pieces are form-encoded; every other piece keeps its exact spelling
    /// (`flag`, `%20`). `percentEncodedQuery`-style raw pieces, as on the host and Android.
    private static func settingQuery(_ entries: [(name: String, value: String)], in rawQuery: String) -> String {
        var pieces = rawQuery.split(separator: "&", omittingEmptySubsequences: true).map(String.init)
        for entry in entries {
            let encoded = "\(formComponent(entry.name))=\(formComponent(entry.value))"
            let isNamed = { (piece: String) in decode(String(piece.prefix { $0 != "=" })) == entry.name }
            guard let first = pieces.firstIndex(where: isNamed) else {
                pieces.append(encoded)
                continue
            }
            pieces[first] = encoded
            var cursor = pieces.index(after: first)
            while cursor < pieces.endIndex {
                if isNamed(pieces[cursor]) { pieces.remove(at: cursor) } else { cursor += 1 }
            }
        }
        return pieces.joined(separator: "&")
    }

    private static func formComponent(_ text: String) -> String {
        var out = ""
        for byte in text.utf8 {
            let scalar = Unicode.Scalar(byte)
            if byte < 0x80, CharacterSet.alphanumerics.contains(scalar) || "*-._".unicodeScalars.contains(scalar) {
                out.unicodeScalars.append(scalar)
            } else if byte == 0x20 {
                out += "+"
            } else {
                out += String(format: "%%%02X", UInt32(byte))
            }
        }
        return out
    }
}
