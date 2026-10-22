import Foundation

extension PrototypeLinkify {
    static func validate(root: JSONValue, nodes: [PrototypeLocatedValue]) throws {
        for node in nodes {
            guard let linkify = node.value["linkify"]?.objectFields else { continue }
            if node
                .value["spans"] !=
                nil { throw PrototypeContractValidator.invalid("\(node.path).linkify", "linkify requires text") }
            try scanBindings(linkify["onTap"] ?? .null, path: "\(node.path).linkify.onTap", repeatBindings: true)
        }
        try scanBindings(root, path: "root", repeatBindings: false)
    }

    private static func scanBindings(_ raw: JSONValue, path: String, repeatBindings: Bool) throws {
        if case let .array(items) = raw {
            for (index, child) in items.enumerated() {
                try scanBindings(
                    child,
                    path: "\(path)[\(index)]",
                    repeatBindings: repeatBindings
                )
            }
        } else if let fields = raw.objectFields {
            if fields.count == 1, fields["value"] != nil { return }
            if repeatBindings,
               fields["item"] != nil || fields["index"] !=
               nil { throw PrototypeContractValidator.invalid(path, "Repeat binding in linkify") }
            if !repeatBindings, fields.count == 1,
               fields["match"] !=
               nil { throw PrototypeContractValidator.invalid("\(path).match", "Match outside linkify") }
            for key in PrototypeContractValidator.sorted(fields.keys) {
                if key == "payload" || (!repeatBindings && ["linkify", "repeat"].contains(key)) { continue }
                if key == "screens", let screens = fields[key]?.objectFields {
                    for name in PrototypeContractValidator.sorted(screens.keys) {
                        try scanBindings(
                            screens[name] ?? .null,
                            path: PrototypeStacks.screenPath(path, name: name),
                            repeatBindings: repeatBindings
                        )
                    }
                } else { try scanBindings(
                    fields[key] ?? .null,
                    path: PrototypeContractValidator.keyPath(path, key),
                    repeatBindings: repeatBindings
                ) }
            }
        } else if repeatBindings, let text = raw.stringValue {
            let pattern = #"\{(?:index|[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\}"#
            if text.range(of: pattern, options: .regularExpression) != nil { throw PrototypeContractValidator.invalid(
                path,
                "Repeat placeholder in linkify"
            ) }
        }
    }
}
