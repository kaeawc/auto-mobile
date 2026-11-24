import Foundation

/// Inbound contract checks only; no runtime navigation or platform service.
enum PrototypeInboundLinks {
    private static let bindingMaps: Set<String> = ["params", "context", "args", "headers", "query", "form"]

    private static func bindingChildren(_ fields: [String: JSONValue]) -> [JSONValue] {
        fields.flatMap { key, child -> [JSONValue] in
            if bindingMaps.contains(key) { return Array((child.objectFields ?? [:]).values) }
            if key == "payload" { return [] }
            if key == "value", child.objectFields?["link"] == nil { return [] }
            return [child]
        }
    }

    private static func bindings(_ raw: JSONValue?) -> Set<String> {
        if case let .array(items) = raw { return Set(items.flatMap { bindings($0) }) }
        guard let fields = raw?.objectFields else { return [] }
        if fields.count == 1, fields["value"] != nil { return [] }
        if fields.count == 1, let name = fields["link"]?.stringValue { return [name] }
        return Set(bindingChildren(fields).flatMap { bindings($0) })
    }

    private static func entry(_ raw: JSONValue) -> PrototypeLinkMatcher.Entry {
        let fields = raw.objectFields ?? [:]
        return .init(
            path: fields["path"]?.stringValue ?? "",
            query: (fields["query"]?.objectFields ?? [:]).mapValues {
                $0.stringValue ?? $0.objectFields?["type"]?.stringValue ?? ""
            },
            usedCaptures: bindings(fields["actions"])
        )
    }

    private static func types(_ entry: PrototypeLinkMatcher.Entry?) -> [String: String] {
        var types: [String: String] = [:]
        for segment in (entry?.path ?? "").split(separator: "/")
            where segment.hasPrefix("{") && segment.hasSuffix("}")
        {
            types[String(segment.dropFirst().dropLast())] = "string"
        }
        for (name, declaration) in entry?.query ?? [:] {
            let type = declaration.hasSuffix("?") ? String(declaration.dropLast()) : declaration
            types[name] = type == "int" ? "number" : type
        }
        return types
    }

    private static func scope(_ path: String, table: [PrototypeLinkMatcher.Entry]) -> PrototypeLinkMatcher.Entry? {
        guard path.hasPrefix("links["), let end = path.firstIndex(of: "]"),
              let index = Int(path[path.index(path.startIndex, offsetBy: 6) ..< end]),
              table.indices.contains(index) else { return nil }
        return table[index]
    }

    static func validate(_ spec: [String: JSONValue], context: PrototypeContractValidator) throws {
        let table = PrototypeStrictBindings.array(spec["links"]).map(entry)
        if let error = PrototypeLinkMatcher.validateLinkTable(table).first {
            throw PrototypeContractValidator.invalid("links[\(error.index)]", error.message)
        }
        if spec["links"] != nil,
           !PrototypePlatformValidator.capabilities(spec["requires"]).contains("prototype_links_v1")
        { throw PrototypeContractValidator.invalid("requires", "links requires prototype_links_v1") }
        for action in context.actions {
            let types = types(scope(action.path, table: table))
            try validateAction(action, types: types, spec: spec)
            try validateRoutes(action, types: types, context: context)
        }
    }

    private static func validateAction(
        _ action: PrototypeLocatedValue, types: [String: String], spec: [String: JSONValue]
    )
        throws
    {
        if bindings(.object(action.value)).contains(where: { types[$0] == nil }) {
            throw PrototypeContractValidator.invalid(action.path, "Unknown link binding")
        }
        guard action.value["type"] == .string("setState"),
              let written = action.value["value"]?.objectFields?["link"]?.stringValue,
              let stateValue = spec["state"]?.objectFields?[action.value["key"]?.stringValue ?? ""] else { return }
        let stateType: String
        switch stateValue {
        case .string: stateType = "string"
        case .bool: stateType = "boolean"
        default: stateType = "number"
        }
        if types[written] != stateType {
            throw PrototypeContractValidator.invalid(action.path, "Wrong type for link state value")
        }
    }

    private static func validateRoutes(
        _ action: PrototypeLocatedValue, types: [String: String], context: PrototypeContractValidator
    )
        throws
    {
        let stack = context.locatedNodes.first {
            $0.value["type"] == .string("stack") && $0.value["id"] == action.value["stack"]
        }?.value
        let targets = action.value["type"] == .string("setStack")
            ? PrototypeStrictBindings.array(action.value["path"]) : [.object(action.value)]
        for target in targets {
            let navigation = target.objectFields ?? [:]
            let declared = stack?["routes"]?.objectFields?[navigation["screen"]?.stringValue ?? ""]?
                .objectFields?["params"]?.objectFields ?? [:]
            for (name, value) in navigation["params"]?.objectFields ?? [:] {
                guard let binding = value.objectFields?["link"]?.stringValue else { continue }
                if types[binding] != declared[name]?.stringValue {
                    throw PrototypeContractValidator.invalid(action.path, "Wrong type for route param \"\(name)\"")
                }
            }
        }
    }
}
