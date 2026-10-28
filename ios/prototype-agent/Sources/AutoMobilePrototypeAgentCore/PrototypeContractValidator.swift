import Foundation

/// Interprets the host's structural contract before embedded specs reach the permissive decoder.
/// Cross-node and host environment checks remain the host's responsibility.
struct PrototypeContractValidator {
    private struct Contract: Decodable {
        let motionTokens: [String: [String: [String: PrototypeMotionToken]]]
        let patterns: [String: String]
        let stringFields: [String]
        let stringOpaqueFields: [String]
        let checkControls: [String: [String]]
        let definitions: [String: JSONValue]
        let limits: [String: Int]
        let platformModules: [String: JSONValue]
    }

    private static let contract = try? JSONDecoder().decode(
        Contract.self, from: Data(prototypeSpecContractData.utf8)
    )
    static func motionToken(scheme: String, role: String, tempo: String) -> PrototypeMotionToken {
        guard let token = contract?.motionTokens[scheme]?[role]?[tempo] else {
            preconditionFailure("Embedded motion token is unavailable")
        }
        return token
    }

    static var platformModules: [String: JSONValue] {
        guard let contract else { preconditionFailure("Embedded structural contract is unavailable") }
        return contract.platformModules
    }

    private static let patterns = contract?.patterns.compactMapValues { try? NSRegularExpression(pattern: $0) } ?? [:]

    static func matches(_ name: String, _ text: String) -> Bool {
        patterns[name]?.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    static let stringFieldOrder = contract?.stringFields ?? []
    static let stringFields = Set(stringFieldOrder)
    static let stringOpaqueFields = Set(contract?.stringOpaqueFields ?? [])

    static func limit(_ name: String) -> Int { contract?.limits[name] ?? 0 }
    static func definition(_ name: String) -> JSONValue? { contract?.definitions[name] }
    static let checkPatternMaxLength = Int(
        contract?.definitions["check"]?.objectFields?["fields"]?
            .objectFields?["pattern"]?.objectFields?["rule"]?.objectFields?["max"]?.numberValue ?? 0
    )
    static func checkFits(_ kind: String, _ control: String) -> Bool {
        contract?.checkControls[kind]?.contains(control) ?? true
    }

    let definitions: [String: JSONValue]
    let limits: [String: Int]
    var locatedNodes: [PrototypeLocatedValue] = []
    var actions: [PrototypeLocatedValue] = []
    var nodes = 0
    var images = 0
    var effects = PrototypeEffectUses()
    var keyframeNodes = 0
    var referenceDepth: [String: Int] = [:]

    static func validateRequestBody(_ value: JSONValue, path: String) throws {
        guard let contract,
              let rule = contract.definitions["action"]?.objectFields?["variants"]?.objectFields?["request"]?
              .objectFields?["fields"]?.objectFields?["body"]?.objectFields?["rule"]
        else {
            throw invalid(path, "Embedded request body contract is unavailable")
        }
        var validator = Self(definitions: contract.definitions, limits: contract.limits)
        try validator.walk(value, rule: rule, path: path, depth: 0)
    }

    static func validate(data: Data) throws { _ = try inspect(data: data) }

    static func inspect(data: Data) throws -> (JSONValue, PrototypeContractValidator) {
        guard data.count <= PrototypeLimits.maxSpecBytes * 4 else {
            throw invalid("$", "Spec byte limit exceeded")
        }
        guard !data.isEmpty,
              String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != true
        else {
            throw invalid("$", "Prototype file is empty; expected JSON")
        }
        let value: JSONValue
        do { value = try JSONDecoder().decode(JSONValue.self, from: data) }
        catch { throw invalid("$", error.localizedDescription) }
        return try (value, inspect(value))
    }

    /// Accessory nodes are structurally checked but neither renderer draws them.
    mutating func dropIgnoredAccessories() {
        let ignored = locatedNodes.filter {
            $0.value["ios"]?.objectFields?["bottomAccessory"]?.objectFields != nil
        }.map { "\($0.path).ios.bottomAccessory" }
        func ignoredEntry(_ entry: PrototypeLocatedValue) -> Bool {
            ignored.contains { entry.path == $0 || entry.path.hasPrefix($0 + ".") || entry.path.hasPrefix($0 + "[") }
        }
        locatedNodes.removeAll(where: ignoredEntry)
        actions.removeAll(where: ignoredEntry)
    }

    /// Types of the actions in the contract's action slots. Arbitrary JSON, such as a channel route's
    /// equality literal, may carry the same type string, so a gate that must not over-match reads these.
    static func locatedActionTypes(_ spec: JSONValue) -> Set<String> {
        guard let contract, let rule = contract.definitions["spec"] else { return [] }
        var validator = Self(definitions: contract.definitions, limits: contract.limits)
        // A spec the walk rejects fails validation anyway; the actions located before that still count.
        _ = try? validator.walk(spec, rule: rule, path: "", depth: 0)
        validator.dropIgnoredAccessories()
        return Set(validator.actions.compactMap { $0.value["type"]?.stringValue })
    }

    static func inspect(_ value: JSONValue) throws -> PrototypeContractValidator {
        guard let contract, let spec = contract.definitions["spec"] else {
            throw invalid("$", "Embedded structural contract is unavailable")
        }
        var validator = Self(definitions: contract.definitions, limits: contract.limits)
        if let fields = value.objectFields, let root = fields["root"] {
            try PrototypeLazyList.validateLimits(root: root, data: fields["data"]?.objectFields)
        }
        try validator.walk(value, rule: spec, path: "", depth: 0)
        validator.dropIgnoredAccessories()
        try PrototypeKeyframes.validate(nodes: validator.locatedNodes, spec: value.objectFields ?? [:])
        return validator
    }

    /// Interpret a module state rule with the same definitions and limits as the spec walk.
    static func validateValue(_ value: JSONValue, rule: JSONValue, path: String) throws {
        guard let contract else { throw invalid(path, "Embedded structural contract is unavailable") }
        var validator = Self(definitions: contract.definitions, limits: contract.limits)
        try validator.walk(value, rule: rule, path: path, depth: 0)
    }

    static func invalid(_ path: String, _ message: String) -> PrototypeLoadError {
        .invalidSpec(path: path.isEmpty ? "$" : path, message: message)
    }

    static func keyPath(_ path: String, _ key: String) -> String {
        let joined = PrototypeLimits.dataMemberPath(path.isEmpty ? "$" : path, key: key)
        return path.isEmpty && joined.hasPrefix("$.") ? String(joined.dropFirst(2)) : joined
    }

    static func sorted(_ keys: some Sequence<String>) -> [String] {
        keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
    }

    mutating func walk(_ value: JSONValue, rule: JSONValue, path: String, depth: Int) throws {
        guard let fields = rule.objectFields, let kind = fields["kind"]?.stringValue else {
            throw Self.invalid(path, "Invalid embedded contract rule")
        }
        switch kind {
        case "ref": try reference(value, rule: fields, path: path, depth: depth)
        case "tagged": try tagged(value, rule: fields, path: path, depth: depth)
        case "object": try object(value, rule: fields, path: path, depth: depth)
        case "array": try array(value, rule: fields, path: path, depth: depth)
        case "map", "screenMap", "record": try map(value, rule: fields, path: path, depth: depth)
        case "choice": try choice(value, rule: fields, path: path, depth: depth)
        case "data": try Self.data(value)
        case "strings": try PrototypeStrings.validateTables(value)
        default:
            guard Self.primitive(value, rule: fields) else {
                throw Self.invalid(path, "Invalid \(kind == "boundKey" ? "key" : kind) value")
            }
        }
    }

    private mutating func tagged(_ value: JSONValue, rule: [String: JSONValue], path: String, depth: Int) throws {
        guard let object = value.objectFields else { throw Self.invalid(path, "Expected object") }
        guard let type = object["type"]?.stringValue,
              let variant = rule["variants"]?.objectFields?[type]
        else { throw Self.invalid(Self.keyPath(path, "type"), "Unknown or missing discriminator") }
        try walk(value, rule: variant, path: path, depth: depth)
    }

    mutating func reference(_ value: JSONValue, rule: [String: JSONValue], path: String, depth: Int) throws {
        guard let name = rule["name"]?.stringValue, let target = definitions[name] else {
            throw Self.invalid(path, "Unknown embedded contract reference")
        }
        let depthLimits = [
            "container": limits["MAX_PROTOTYPE_SELECTOR_DEPTH"],
            "condition": limits["MAX_PROTOTYPE_CONDITION_DEPTH"],
            "action": limits["MAX_PROTOTYPE_ACTION_DEPTH"],
        ].compactMapValues { $0 }
        let messages = [
            "container": "Selector depth limit exceeded",
            "condition": "Condition depth limit exceeded",
            "action": "Action nesting limit exceeded",
        ]
        referenceDepth[name, default: 0] += 1
        defer { referenceDepth[name, default: 0] -= 1 }
        if let limit = depthLimits[name], referenceDepth[name, default: 0] > limit {
            throw Self.invalid(path, messages[name] ?? "Reference depth limit exceeded")
        }
        if name == "action", let fields = value.objectFields { actions.append(.init(value: fields, path: path)) }
        if name == "item" {
            images += Self.imageUses(value.objectFields?["image"])
            if images >
                (limits["MAX_PROTOTYPE_IMAGES"] ?? 0) { throw Self.invalid("\(path).image", "Image limit exceeded") }
        }
        if name == "node" {
            if let fields = value.objectFields, fields["onAppear"] != nil,
               path != "root", fields["visibleWhen"] == nil
            {
                throw Self.invalid("\(path).onAppear", "onAppear requires visibleWhen or the root")
            }
            guard let node = value.objectFields else { throw Self.invalid(path, "Expected object") }
            locatedNodes.append(.init(value: node, path: path))
            nodes += 1
            if nodes > PrototypeLimits.maxNodes { throw Self.invalid(path, "Node limit exceeded") }
            if depth + 1 > PrototypeLimits.maxDepth { throw Self.invalid(path, "Tree depth limit exceeded") }
            if node["type"] == .string("image") { images += max(1, Self.imageUses(node["asset"])) }
            if images > (limits["MAX_PROTOTYPE_IMAGES"] ?? 0) { throw Self.invalid(path, "Image limit exceeded") }
            if node["keyframes"] != nil { keyframeNodes += 1 }
            if keyframeNodes > (limits["MAX_PROTOTYPE_KEYFRAME_NODES"] ?? 0) {
                throw Self.invalid("\(path).keyframes", "Keyframe node limit exceeded")
            }
            effects.add(PrototypeEffectUses(node: node))
            if effects.total > (limits["MAX_PROTOTYPE_EFFECTS"] ?? 0) {
                throw Self.invalid(path, "Effect limit exceeded")
            }
            if effects.animated > (limits["MAX_PROTOTYPE_ANIMATED_EFFECTS"] ?? 0) {
                throw Self.invalid(path, "Animated effect limit exceeded")
            }
        }
        try walk(value, rule: target, path: path, depth: depth + (name == "node" ? 1 : 0))
    }

    private static func imageUses(_ value: JSONValue?) -> Int {
        if case .string? = value { return 1 }
        guard let fields = value?.objectFields else { return 0 }
        let values = [fields["light"]?.stringValue, fields["dark"]?.stringValue].compactMap { $0 }
        return Set(values.map { Array($0.utf16) }).count
    }
}
