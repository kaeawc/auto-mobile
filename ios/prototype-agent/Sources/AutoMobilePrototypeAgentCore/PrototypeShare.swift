import Foundation

struct PrototypeShareError: Error, Equatable {
    enum Code: String { case invalidArgs = "invalid_args" }
    let code = Code.invalidArgs
    let path: String
    let message: String
}

enum PrototypeShareResolution: Equatable {
    case resolved(payload: [String: JSONValue], summary: [String: JSONValue])
    case failure(PrototypeShareError)
    var json: JSONValue {
        switch self {
        case let .resolved(payload, summary): .object([
                "ok": .bool(true),
                "payload": .object(payload),
                "summary": .object(summary),
            ])
        case let .failure(error): .object([
                "ok": .bool(false),
                "error": .object(["code": .string(error.code.rawValue), "path": .string(error.path),
                                  "message": .string(error.message)]),
            ])
        }
    }
}

/// Pure contract reference. System sheet dispatch and fake mode are implemented separately.
enum PrototypeShare {
    static let maxTextBytes = PrototypeContractValidator.limit("MAX_PROTOTYPE_SHARE_TEXT_BYTES")
    static let maxImages = PrototypeContractValidator.limit("MAX_PROTOTYPE_SHARE_IMAGES")
    static let maxFiles = PrototypeContractValidator.limit("MAX_PROTOTYPE_SHARE_FILES")
    private static let names: Set<String> = ["contact", "files", "images", "subject", "text", "url"]
    private static let contactNames: Set<String> = ["email", "name", "note", "org", "phone", "url"]
    struct Violation: Error { let path: String; let message: String }
    private static func sorted(_ keys: some Sequence<String>) -> [String] {
        keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
    }

    private static func forbidden(_ scalar: Unicode.Scalar) -> Bool {
        scalar.value <= 31 || (127 ... 160).contains(scalar.value) ||
            (0x2028 ... 0x202E).contains(scalar.value) || (0x2066 ... 0x2069).contains(scalar.value)
    }

    private static func validURL(_ value: String, dynamic: Bool = false) -> Bool {
        // All delimiters are scalars: a combining mark cannot hide punctuation in a grapheme.
        let lower = String(value.unicodeScalars.prefix(8)).lowercased()
        let start: Int
        if lower.utf8.starts(with: "https://".utf8) { start = 8 }
        else if lower.utf8.starts(with: "http://".utf8) { start = 7 }
        else { return false }
        if value.unicodeScalars.contains(where: { forbidden($0) || $0 == " " || $0 == "\\" }) { return false }
        let candidate = dynamic ? bindText(value, [:], mask: true, maskValue: "1") : value
        let authority = String(
            String
                .UnicodeScalarView(
                    candidate.unicodeScalars.dropFirst(start)
                        .prefix { !"/?#".unicodeScalars.contains($0) }
                )
        )
        guard !authority.isEmpty,
              !authority.unicodeScalars.contains(where: { "@{}<>^|%".unicodeScalars.contains($0) })
        else { return false }
        let port: String?
        if authority.unicodeScalars.first == "[" {
            let scalars = authority.unicodeScalars
            guard let end = scalars.firstIndex(of: "]") else { return false }
            let address = String(scalars[scalars.index(after: scalars.startIndex) ..< end])
            let halves = address.components(separatedBy: "::")
            let groups = halves.flatMap { $0.isEmpty ? [] : $0.components(separatedBy: ":") }
            guard halves.count <= 2,
                  !groups
                  .contains(where: {
                      $0.isEmpty || $0.utf8.count > 4 || $0.unicodeScalars
                          .contains(where: { !"0123456789abcdefABCDEF".unicodeScalars.contains($0) })
                  }),
                  halves.count == 1 ? groups.count == 8 : groups.count < 8 else { return false }
            let tail = scalars[scalars.index(after: end)...]
            guard tail.isEmpty || tail.first == ":" else { return false }
            port = tail.isEmpty ? nil : String(String.UnicodeScalarView(tail.dropFirst()))
        } else {
            let parts = authority.components(separatedBy: ":")
            guard parts.count <= 2, !parts[0].isEmpty,
                  !parts[0].unicodeScalars.contains(where: { "[]".unicodeScalars.contains($0) }) else { return false }
            port = parts.count > 1 ? parts[1] : nil
        }
        guard let port, !port.isEmpty else { return true }
        return port.utf8.count <= 5 && port.utf8
            .allSatisfy { (48 ... 57).contains($0) } && (Int(port) ?? 65536) <= 65535
    }

    private static func textError(_ value: JSONValue?, _ path: String) -> Violation? {
        guard let text = value?.stringValue else { return .init(path: path, message: "Expected share string") }
        return text.utf8
            .count > maxTextBytes ? .init(path: path, message: "Share string exceeds 65536 UTF-8 bytes") : nil
    }

    private static func assetID(_ value: JSONValue?) -> String? {
        if let text = value?.stringValue { return text }
        guard let form = value?.objectFields, form.count == 1 else { return nil }
        return form["asset"]?.stringValue
    }

    private static func assetError(
        _ value: JSONValue?,
        _ path: String,
        _ dynamic: Bool,
        _ assets: Set<String>?
    )
        -> Violation?
    {
        if dynamic, let form = value?.objectFields, form.count == 1,
           let pointer = form["data"]?.stringValue, PrototypeDataPointer.isValid(pointer) { return nil }
        guard let id = assetID(value), !id.isEmpty,
              !id.unicodeScalars.contains(where: { "{}".unicodeScalars.contains($0) })
        else {
            return .init(path: path, message: "Expected uploaded asset id or data binding")
        }
        return assets.map { !$0.contains(id) } == true ? .init(path: path, message: "Unknown share asset") : nil
    }

    private static func valueError(
        _ name: String,
        _ value: JSONValue?,
        _ path: String,
        _ dynamic: Bool,
        _ assets: Set<String>?
    )
        -> Violation?
    {
        if ["text", "subject", "url"].contains(name) {
            if let error = textError(value, path) { return error }
            return name == "url" && value?.stringValue?
                .isEmpty != true && !validURL(value?.stringValue ?? "", dynamic: dynamic) ?
                .init(path: path, message: "Share URL must be absolute http(s) with a literal scheme") :
                nil
        }
        if name == "contact" {
            guard let form = value?.objectFields else { return .init(
                path: path,
                message: "Expected share contact object"
            ) }
            for key in sorted(Set(form.keys).union(["name"])) {
                let at = PrototypeLimits.dataMemberPath(path, key: key)
                guard contactNames.contains(key) else { return .init(path: at, message: "Unknown contact field") }
                guard form[key] != nil else { return .init(path: at, message: "Required contact name") }
                if let error = textError(form[key], at) { return error }
                if key == "name",
                   PrototypeContractValidator
                   .matches("blankText", form[key]?.stringValue ?? "")
                {
                    return .init(path: at, message: "Required contact name")
                }
                if key == "url",
                   !validURL(form[key]?.stringValue ?? "", dynamic: dynamic)
                {
                    return .init(
                        path: at,
                        message: "Share URL must be absolute http(s) with a literal scheme"
                    )
                }
            }
            return nil
        }
        guard case let .array(array)? = value else { return .init(path: path, message: "Expected share array") }
        let max = name == "images" ? maxImages : maxFiles
        guard (1 ... max).contains(array.count) else { return .init(
            path: path,
            message: "Share \(name) must contain 1 to \(max) items"
        ) }
        for (index, entry) in array.enumerated() {
            let at = "\(path)[\(index)]"
            if name == "images" {
                if let error = assetError(entry, at, dynamic, assets) { return error }
                continue
            }
            guard let file = entry.objectFields else { return .init(path: at, message: "Expected share file object") }
            for key in sorted(Set(file.keys).union(["asset", "mimeType", "name"])) {
                let field = PrototypeLimits.dataMemberPath(at, key: key)
                guard ["asset", "mimeType", "name"].contains(key)
                else { return .init(path: field, message: "Unknown file field") }
                if key == "asset" {
                    if let error = assetError(file[key], field, false, assets) { return error }
                } else if key == "mimeType" {
                    if dynamic, let text = file[key]?.stringValue, bindText(text, [:], mask: true) != text { continue }
                    guard let mime = file[key]?.stringValue, mime.range(
                        of: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+/[!#$%&'*+.^_`|~0-9A-Za-z-]+$(?![\\s\\S])",
                        options: .regularExpression
                    ) != nil else {
                        return .init(path: field, message: "Share mimeType must be a type/subtype token")
                    }
                } else {
                    let fileName = file[key]?.stringValue.map { dynamic ? bindText($0, [:], mask: true) : $0 }
                    guard let text = fileName, !text.isEmpty, text.unicodeScalars.first != ".",
                          text.utf8.count <= 128,
                          !text.unicodeScalars
                          .contains(where: {
                              $0 == "/" || $0 == "\\" || forbidden($0)
                          })
                    else {
                        return .init(
                            path: field,
                            message: "Share file name must be 1 to 128 UTF-8 bytes, with no leading dot, separators or controls"
                        )
                    }
                }
            }
        }
        return nil
    }

    static func argumentsError(
        _ args: [String: JSONValue],
        path: String,
        assets: Set<String>? = nil,
        resolved: Bool = false
    )
        -> Violation?
    {
        for name in sorted(args.keys) {
            let at = PrototypeLimits.dataMemberPath(path, key: name)
            guard names.contains(name) else { return .init(
                path: at,
                message: name == "title" ? "Unknown argument: use subject" : "Unknown argument"
            ) }
            let binding = args[name]?.objectFields
            if !resolved, binding?["value"] == nil { continue }
            if let error = valueError(
                name,
                resolved ? args[name] : binding?["value"],
                resolved ? at : "\(at).value",
                !resolved,
                assets
            ) { return error }
        }
        guard ["text", "url", "images", "files", "contact"].contains(where: { name in
            guard let raw = args[name] else { return false }
            let binding = raw.objectFields
            if !resolved, binding?["value"] == nil { return true }
            let value = resolved ? raw : binding?["value"]
            return value?.stringValue.map { !PrototypeContractValidator.matches("blankText", $0) } ?? true
        }) else { return .init(path: path, message: "Share requires text, url, images, files or contact") }
        return nil
    }

    private static func scalar(_ value: JSONValue?) -> String? {
        guard let value else { return nil }
        switch value {
        case .string, .bool: return value.displayString
        case let .number(number): return PrototypeScalarText.render(number)
        default: return nil
        }
    }

    /// One forward scan. Replaced values are never interpreted as templates again.
    private static func bindText(
        _ text: String,
        _ inputs: [String: JSONValue],
        mask: Bool = false,
        maskValue: String = "x"
    )
        -> String
    {
        let chars = Array(text.unicodeScalars)
        var result = String.UnicodeScalarView()
        var index = 0
        while index < chars.count {
            if chars[index] == "{" {
                var end = index + 1
                while end < chars.count, chars[end] != "{", chars[end] != "}" { end += 1 }
                if end < chars.count, chars[end] == "}" {
                    let token = String(String.UnicodeScalarView(chars[(index + 1) ..< end]))
                    var replacement: String?
                    if mask, PrototypeRepeat.isFieldName(token) ||
                        (
                            token.components(separatedBy: ".").count == 2 && token.components(separatedBy: ".")
                                .allSatisfy(PrototypeRepeat.isFieldName)
                        ) ||
                        (token.hasPrefix("data:") && PrototypeDataPointer.isValid(String(token.dropFirst(5))))
                    {
                        replacement = maskValue
                    } else if token.hasPrefix("data:"), PrototypeDataPointer.isValid(String(token.dropFirst(5))) {
                        replacement = scalar(PrototypeDataPointer.resolve(
                            inputs["data"]?.objectFields,
                            pointer: String(token.dropFirst(5))
                        )) ?? ""
                    } else if token == "index" { replacement = scalar(inputs["index"]) }
                    else if token.hasPrefix("item."), PrototypeRepeat.isFieldName(String(token.dropFirst(5))) {
                        replacement = scalar(inputs["item"]?.objectFields?[String(token.dropFirst(5))])
                    } else if PrototypeRepeat
                        .isFieldName(token) { replacement = scalar(inputs["state"]?.objectFields?[token]) }
                    if let replacement {
                        result.append(contentsOf: replacement.unicodeScalars); index = end + 1; continue
                    }
                    result.append(contentsOf: chars[index ... end]); index = end + 1; continue
                }
                // Consume failed spans too, so a long unterminated template remains linear.
                result.append(contentsOf: chars[index ..< end]); index = end; continue
            }
            result.append(chars[index]); index += 1
        }
        return String(result)
    }

    private static func bindStrings(_ value: JSONValue, _ inputs: [String: JSONValue]) -> JSONValue {
        switch value {
        case let .string(text): .string(bindText(text, inputs))
        case let .array(array): .array(array.map { bindStrings($0, inputs) })
        case let .object(fields): .object(fields.mapValues { bindStrings($0, inputs) })
        default: value
        }
    }

    private static func vCard(_ contact: [String: JSONValue]) -> String {
        func escape(_ text: String) -> String {
            text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\r\n", with: "\n")
                .replacingOccurrences(of: "\r", with: "\n").replacingOccurrences(of: "\n", with: "\\n")
                .replacingOccurrences(of: ",", with: "\\,").replacingOccurrences(of: ";", with: "\\;")
        }
        let name = escape(contact["name"]?.stringValue ?? "")
        var lines = ["BEGIN:VCARD", "VERSION:3.0", "FN:\(name)", "N:\(name);;;;"]
        for (field, label) in [("phone", "TEL"), ("email", "EMAIL"), ("org", "ORG"), ("url", "URL"), ("note", "NOTE")] {
            if let value = contact[field]?
                .stringValue { lines.append("\(label):\(field == "url" ? value : escape(value))") }
        }
        lines.append("END:VCARD")
        return lines.map { line in
            var out = "", column = 0
            for scalar in line.unicodeScalars {
                let char = String(scalar), size = String(scalar).utf8.count
                if column + size > 75 { out += "\r\n "; column = 1 }
                out += char; column += size
            }
            return out
        }.joined(separator: "\r\n") + "\r\n"
    }

    static func resolvePrototypeShare(
        _ args: [String: JSONValue],
        inputs: [String: JSONValue]
    )
        -> PrototypeShareResolution
    {
        func failure(_ error: Violation) -> PrototypeShareResolution { .failure(.init(
            path: error.path,
            message: error.message
        )) }
        if let error = argumentsError(args, path: "args") { return failure(error) }
        var resolved: [String: JSONValue] = [:]
        for name in sorted(args.keys) {
            let binding = args[name]?.objectFields ?? [:]
            var raw: JSONValue?
            if let value = binding["value"] { raw = value }
            else if let key = binding["state"]?.stringValue { raw = inputs["state"]?.objectFields?[key] }
            else if let pointer = binding["data"]?
                .stringValue { raw = PrototypeDataPointer.resolve(inputs["data"]?.objectFields, pointer: pointer) }
            else if let key = binding["item"]?.stringValue { raw = inputs["item"]?.objectFields?[key] }
            else if binding["index"] == .bool(true) { raw = inputs["index"] }
            else if let pointer = binding["platform"]?
                .stringValue
            {
                raw = PrototypeDataPointer.resolve(inputs["platform"]?.objectFields, pointer: pointer)
            } else if let pointer = binding["event"]?
                .stringValue
            {
                raw = PrototypeDataPointer.resolve(inputs["event"]?.objectFields, pointer: pointer)
            }
            guard let raw else { return failure(.init(path: "args.\(name)", message: "Share binding is missing")) }
            var value = bindStrings(raw, inputs)
            if name == "images", case let .array(array) = value {
                value = .array(array.map { entry in
                    guard let pointer = entry.objectFields?["data"]?.stringValue else { return entry }
                    return PrototypeDataPointer.resolve(inputs["data"]?.objectFields, pointer: pointer) ?? .null
                })
            }
            resolved[name] = value
        }
        let assets = inputs["assets"]?.objectFields ?? [:]
        if let error = argumentsError(resolved, path: "args", assets: Set(assets.keys), resolved: true) {
            return failure(error)
        }
        for name in ["images", "files"] {
            let entries: [JSONValue] = if case let .array(array)? = resolved[name] { array } else { [] }
            for (index, entry) in entries.enumerated() {
                guard let id = assetID(name == "files" ? entry.objectFields?["asset"] : entry),
                      case let .number(size)? = assets[id]?.objectFields?["bytes"], size.isFinite,
                      size >= 0, size <= 9_007_199_254_740_991, size == size.rounded()
                else {
                    return failure(.init(
                        path: "args.\(name)[\(index)]" + (name == "files" ? ".asset" : ""),
                        message: "Share asset must have non-negative integer bytes"
                    ))
                }
            }
        }
        let imageValues: [JSONValue] = if case let .array(array)? = resolved["images"] { array } else { [] }
        let images = imageValues.compactMap { assetID($0).map(JSONValue.string) }
        let fileValues: [JSONValue] = if case let .array(array)? = resolved["files"] { array } else { [] }
        let files = fileValues.compactMap { value -> JSONValue? in
            guard var file = value.objectFields, let id = assetID(file["asset"]) else { return nil }
            file["asset"] = .string(id); file["bytes"] = assets[id]?.objectFields?["bytes"] ?? .number(0)
            return .object(file)
        }
        var payload: [String: JSONValue] = ["images": .array(images), "files": .array(files)]
        var items: [String: JSONValue] = [
            "images": .number(Double(images.count)),
            "files": .array(files.map { .object(($0.objectFields ?? [:]).filter { $0.key != "asset" }) }),
            "contact": .bool(resolved["contact"] != nil),
        ]
        for name in ["text", "url", "subject"] {
            if let value = resolved[name]?.stringValue {
                payload[name] = .string(value)
                items[name] =
                    .string(
                        name == "text" ? String(String.UnicodeScalarView(value.unicodeScalars.prefix(2048))) :
                            value
                    )
            }
        }
        if let contact = resolved["contact"]?.objectFields { payload["vCard"] = .string(vCard(contact)) }
        var summary: [String: JSONValue] = ["outcome": inputs["outcome"] ?? .string("unknown"), "items": .object(items)]
        if let target = inputs["target"] { summary["target"] = target }
        return .resolved(payload: payload, summary: summary)
    }
}
