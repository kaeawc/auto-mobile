import Foundation

/// Lookups are made at the emit action, after earlier actions in the atomic list.
protocol PrototypeEmitContextInputs {
    func state(_ key: String) -> JSONValue?
    func page(_ id: String) -> Int?
    func data(_ pointer: String) -> JSONValue?
}

struct PrototypeResolvedEmitContext: Equatable {
    let context: [String: JSONValue]
    let contextTruncated: Bool?
}

/// Targeted structural decoding, rather than a second interpreter for the host's spec contract.
/// Dictionaries retain arbitrary names (including __proto__); JSON object wire order is irrelevant.
struct PrototypeEmitContext: Decodable {
    let bindings: [String: JSONValue]

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(JSONValue.self)
        let path = decoder.codingPath.reduce(into: "") { path, key in
            if let index = key.intValue {
                path += "[\(index)]"
            } else {
                path = path.isEmpty ? key.stringValue : PrototypeLimits.dataMemberPath(path, key: key.stringValue)
            }
        }
        bindings = try Self.validate(raw, path: path)
    }

    /// Also called before repeat expansion, so malformed bindings in empty templates cannot vanish.
    static func validate(_ raw: JSONValue, path: String) throws -> [String: JSONValue] {
        guard case let .object(bindings) = raw else { throw violation(path, "Expected object") }
        guard bindings.count <= PrototypeLimits.maxEmitContextEntries else {
            throw violation(path, "Record entry limit exceeded")
        }
        for name in bindings.keys.sorted(by: { $0.utf8.lexicographicallyPrecedes($1.utf8) }) {
            let bindingPath = PrototypeLimits.dataMemberPath(path, key: name)
            guard !name.isEmpty else { throw violation(bindingPath, "Invalid context name") }
            guard case let .object(binding)? = bindings[name] else { throw violation(bindingPath, "Expected object") }
            try validateBinding(binding, path: bindingPath)
        }
        return bindings
    }

    private static func validateBinding(_ binding: [String: JSONValue], path: String) throws {
        // Preserve the shared choice rule's first-option diagnostics for malformed bindings.
        guard binding.count == 1, let kind = binding.keys.first, let value = binding[kind] else {
            if let extra = binding.keys.filter({ $0 != "state" }).min() {
                throw violation(PrototypeLimits.dataMemberPath(path, key: extra), "Unknown property")
            }
            throw violation("\(path).state", "Required property")
        }
        let valid: Bool = switch kind {
        case "state", "page": value.stringValue.map { !$0.isEmpty } ?? false
        case "item": value.stringValue.map(PrototypeRepeat.isFieldName) ?? false
        case "index": value == .bool(true)
        case "data": value.stringValue.map(PrototypeDataPointer.isValid) ?? false
        case "value": validJSON(value, depth: 0)
        default: false
        }
        guard valid else {
            if ["state", "item", "index", "page", "data", "value"].contains(kind) {
                throw violation(PrototypeLimits.dataMemberPath(path, key: kind), "Unknown property")
            }
            throw violation("\(path).state", "Required property")
        }
    }

    private static func validJSON(_ value: JSONValue, depth: Int) -> Bool {
        guard depth <= PrototypeLimits.maxEmitPayloadDepth else { return false }
        switch value {
        case let .number(number): return number.isFinite
        case let .array(items): return items.allSatisfy { validJSON($0, depth: depth + 1) }
        case let .object(fields): return fields.values.allSatisfy { validJSON($0, depth: depth + 1) }
        case .null, .string, .bool: return true
        }
    }

    func resolve(_ inputs: some PrototypeEmitContextInputs) -> PrototypeResolvedEmitContext {
        // Resolve every entry before deciding whether truncation is needed.
        let complete = bindings.mapValues { raw -> JSONValue in
            guard case let .object(binding) = raw else { return .null }
            if let key = binding["state"]?.stringValue { return inputs.state(key) ?? .null }
            if let id = binding["page"]?.stringValue { return inputs.page(id).map { .number(Double($0)) } ?? .null }
            if let pointer = binding["data"]?.stringValue { return inputs.data(pointer) ?? .null }
            return binding["value"] ?? .null
        }
        if Self.fits(complete) { return PrototypeResolvedEmitContext(context: complete, contextTruncated: nil) }
        var prefix: [String: JSONValue] = [:]
        for name in complete.keys.sorted(by: { $0.utf8.lexicographicallyPrecedes($1.utf8) }) {
            prefix[name] = complete[name]
            if !Self.fits(prefix) {
                prefix[name] = nil
                break
            }
        }
        return PrototypeResolvedEmitContext(context: prefix, contextTruncated: true)
    }

    private static func fits(_ context: [String: JSONValue]) -> Bool {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes
        guard let bytes = try? encoder.encode(JSONValue.object(context)) else { return false }
        return bytes.count <= PrototypeLimits.maxEmitPayloadBytes
    }

    static func violation(_ path: String, _ message: String) -> DecodingError {
        .dataCorrupted(.init(codingPath: [], debugDescription: "\(path): \(message)"))
    }
}
