import Foundation

extension PrototypeLinkify {
    static func validate(root: JSONValue, nodes: [PrototypeLocatedValue]) throws {
        for node in nodes {
            guard node.value["linkify"]?.objectFields != nil else { continue }
            if node
                .value["spans"] !=
                nil { throw PrototypeContractValidator.invalid("\(node.path).linkify", "linkify requires text") }
        }
        try scanBindings(root, path: "root")
    }

    private static func scanBindings(_ raw: JSONValue, path: String) throws {
        if case let .array(items) = raw {
            for (index, child) in items.enumerated() {
                try scanBindings(
                    child,
                    path: "\(path)[\(index)]"
                )
            }
        } else if let fields = raw.objectFields {
            if fields.count == 1, fields["value"] != nil { return }
            if fields.count == 1,
               fields["match"] !=
               nil { throw PrototypeContractValidator.invalid("\(path).match", "Match outside linkify") }
            for key in PrototypeContractValidator.sorted(fields.keys) {
                if key == "payload" || ["linkify", "repeat"].contains(key) { continue }
                if key == "screens", let screens = fields[key]?.objectFields {
                    for name in PrototypeContractValidator.sorted(screens.keys) {
                        try scanBindings(
                            screens[name] ?? .null,
                            path: PrototypeStacks.screenPath(path, name: name)
                        )
                    }
                } else { try scanBindings(
                    fields[key] ?? .null,
                    path: PrototypeContractValidator.keyPath(path, key)
                ) }
            }
        }
    }
}
