import Foundation

/// Secure storage rules (#14321) the contract cannot express, the twin of TypeScript's
/// `prototypeSecureStorage.ts`: `storage.secure` needs the `secureStorage` module, each key is a declared
/// string state key not also in `storage.keys`, a `secureAuth` entry names a secure key and needs the
/// `biometric` module, and no secure key may leave the device through an emit context or through a
/// `request` that does not opt in with `allowSecureInRequest: true`.
enum PrototypeSecureStorageRules {
    static func validateBlock(_ storage: JSONValue?, requires: JSONValue?, state: [String: JSONValue]) throws {
        guard let block = storage?.objectFields else { return }
        let platform = PrototypeContractValidator.strings(requires?.objectFields?["platform"])
        var secure: [JSONValue] = []
        if case let .array(listed)? = block["secure"] {
            secure = listed
            let keys = PrototypeContractValidator.strings(block["keys"])
            try validateList(listed, keys: keys, platform: platform, state: state)
        }
        // secureAuth is checked even without storage.secure: it may only name secure keys.
        let names = secure.compactMap(\.stringValue)
        for name in (block["secureAuth"]?.objectFields ?? [:]).keys.sorted() {
            let path = PrototypeLimits.dataMemberPath("storage.secureAuth", key: name)
            guard names.contains(name) else {
                throw PrototypeContractValidator.invalid(path, "secureAuth names a key that is not in storage.secure")
            }
            guard platform.contains("biometric") else {
                throw PrototypeContractValidator.invalid(
                    path, "Biometric secure keys require biometric in requires.platform"
                )
            }
        }
    }

    private static func validateList(
        _ secure: [JSONValue], keys: [String], platform: [String], state: [String: JSONValue]
    ) throws {
        guard platform.contains("secureStorage") else {
            throw PrototypeContractValidator.invalid(
                "storage.secure", "storage.secure requires secureStorage in requires.platform"
            )
        }
        for (index, entry) in secure.enumerated() {
            if let message = keyError(entry.stringValue, state: state, keys: keys) {
                throw PrototypeContractValidator.invalid("storage.secure[\(index)]", message)
            }
        }
    }

    /// The secure `state:` keys a spec lists, for the emit-context check.
    static func secureKeys(_ storage: JSONValue?) -> [String] {
        PrototypeContractValidator.strings(storage?.objectFields?["secure"])
    }

    static func validateEmit(_ fields: [String: JSONValue], path: String, secure: [String]) throws {
        guard fields["type"] == .string("emit"), !secure.isEmpty,
              let context = fields["context"]?.objectFields else { return }
        for name in context.keys.sorted() {
            guard case let .string(key)? = context[name]?.objectFields?["state"],
                  let leaked = secureKey(for: key, secure: secure) else { continue }
            throw PrototypeContractValidator.invalid(
                PrototypeLimits.dataMemberPath("\(path).context", key: name),
                "Secure storage key \(leaked) cannot be sent in an emit context"
            )
        }
    }

    /// A `request` that sends a secure key without `allowSecureInRequest: true`: a `{state}` binding in a
    /// header, query value or body (a whole body, a form entry or a multipart value), or a `{key}` placeholder
    /// in the URL, a header or a query value. Members are checked in sorted order.
    static func validateRequest(_ fields: [String: JSONValue], path: String, secure: [String]) throws {
        guard fields["type"] == .string("request"), !secure.isEmpty,
              fields["allowSecureInRequest"] != .bool(true) else { return }
        let body = fields["body"]?.objectFields
        func members(_ value: JSONValue?, _ at: String) -> [(JSONValue?, String)] {
            let entries = value?.objectFields ?? [:]
            return entries.keys.sorted().map { (entries[$0], PrototypeLimits.dataMemberPath(at, key: $0)) }
        }
        let parts: [JSONValue] = if case let .array(items)? = body?["multipart"] { items } else { [] }
        let candidates: [(JSONValue?, String)] = [(fields["url"], "\(path).url")]
            + members(fields["headers"], "\(path).headers")
            + members(fields["query"], "\(path).query")
            + [(fields["body"], "\(path).body")]
            + members(body?["form"], "\(path).body.form")
            + parts.enumerated().map { ($1.objectFields?["value"], "\(path).body.multipart[\($0)].value") }
        for (value, at) in candidates {
            let leaked: String? = switch value {
            case let .string(text)?: placeholderKey(text, secure: secure)
            case let .object(binding)?: binding["state"]?.stringValue.flatMap { secureKey(for: $0, secure: secure) }
            default: nil
            }
            if let leaked {
                throw PrototypeContractValidator.invalid(
                    at, "Secure storage key \(leaked) cannot be sent in a request without allowSecureInRequest"
                )
            }
        }
    }

    /// The secure key a `{key}` text placeholder names. A placeholder may hold repeat placeholders, as in
    /// `{tok{row.id}}`, which repeat binding turns into `{token}` before the request reads state, so each
    /// balanced `{...}` group is matched as a template whose inner groups may stand for any text.
    private static func placeholderKey(_ text: String, secure: [String]) -> String? {
        let scalars = Array(text.unicodeScalars)
        var depth = 0
        var start = 0
        for (index, scalar) in scalars.enumerated() {
            if scalar == "{" {
                depth += 1
                if depth == 1 { start = index + 1 }
            } else if scalar == "}", depth > 0 {
                depth -= 1
                guard depth == 0 else { continue }
                var group = String.UnicodeScalarView()
                group.append(contentsOf: scalars[start ..< index])
                if let key = secureKey(for: String(group), secure: secure) { return key }
            }
        }
        return nil
    }

    /// The first secure `state:` key a context state reference can read. A repeat template such as
    /// `token_{item.id}` is expanded per row on the device, so each `{...}` placeholder may stand for
    /// any text there.
    private static func secureKey(for stateKey: String, secure: [String]) -> String? {
        let literals = stateKey
            .replacingOccurrences(of: #"\{[^}]*\}"#, with: "\u{0}", options: .regularExpression)
            .components(separatedBy: "\u{0}")
        return secure.first { entry in
            entry.hasPrefix("state:") && templateMatches(literals, key: String(entry.dropFirst("state:".count)))
        }
    }

    /// Whether `key` fits the literal parts of a template whose gaps match any text. Linear: the first and
    /// last literals anchor the ends and each middle literal is found left to right.
    private static func templateMatches(_ literals: [String], key: String) -> Bool {
        let first = literals.first ?? ""
        guard literals.count > 1 else { return key == first }
        let last = literals.last ?? ""
        let keyChars = Array(key.unicodeScalars)
        let end = keyChars.count - last.unicodeScalars.count
        guard end >= first.unicodeScalars.count, key.hasPrefix(first), key.hasSuffix(last) else { return false }
        var at = first.unicodeScalars.count
        for part in literals.dropFirst().dropLast() {
            let partChars = Array(part.unicodeScalars)
            guard let found = firstIndex(of: partChars, in: keyChars, from: at),
                  found + partChars.count <= end else { return false }
            at = found + partChars.count
        }
        return true
    }

    private static func firstIndex(of part: [Unicode.Scalar], in key: [Unicode.Scalar], from start: Int) -> Int? {
        guard !part.isEmpty else { return start <= key.count ? start : nil }
        guard key.count >= part.count, start <= key.count - part.count else { return nil }
        for index in start ... (key.count - part.count) where Array(key[index ..< index + part.count]) == part {
            return index
        }
        return nil
    }


    private static func keyError(_ entry: String?, state: [String: JSONValue], keys: [String]) -> String? {
        guard let entry, entry.hasPrefix("state:") else { return "Secure storage keys are state:<key>" }
        let key = String(entry.dropFirst("state:".count))
        guard PrototypeContractValidator.matches("stateKey", key) else {
            return "Secure storage keys are state:<key>"
        }
        guard let value = state[key] else { return "Secure storage key \(entry) is not declared in state" }
        guard case .string = value else { return "Secure storage keys must hold a string state value" }
        return keys.contains(entry) ? "Secure storage key \(entry) is also listed in storage.keys" : nil
    }
}
