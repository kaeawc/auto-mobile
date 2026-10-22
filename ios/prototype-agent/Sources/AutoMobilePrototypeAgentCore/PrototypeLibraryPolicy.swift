import Foundation

/// Import-only policy, kept out of the MCP-direct validator and renderer.
enum PrototypeLibraryPolicy {
    static func validate(_ fields: [String: JSONValue], context: PrototypeContractValidator) throws {
        var repeats = PrototypeStrictRepeats(data: fields["data"]?.objectFields)
        try repeats.templates(fields["root"]?.objectFields ?? [:], path: "root")
        let nodes = context.locatedNodes + repeats.bound(context.locatedNodes)
        let secureKeys = Set(nodes.compactMap { node -> String? in
            guard node.value["type"] == .string("textField"),
                  node.value["secure"] == .bool(true) || node.value["keyboardType"] == .string("password")
            else { return nil }
            return node.value["stateKey"]?.stringValue
        })
        let actions = context.actions + repeats.bound(context.actions, actions: true)
        for action in actions where action.value["type"] == .string("request") {
            if action.value["via"] == .string("host") {
                throw PrototypeLibraryFailure(
                    path: "\(action.path).via", message: "Host requests are unavailable in the library"
                )
            }
            if let url = action.value["url"] {
                try checkTextBinding(url, secureKeys: secureKeys, path: "\(action.path).url")
            }
            for key in ["headers", "query"] {
                for (name, value) in action.value[key]?.objectFields ?? [:] {
                    try checkTextBinding(
                        value, secureKeys: secureKeys,
                        path: PrototypeContractValidator.keyPath("\(action.path).\(key)", name)
                    )
                }
            }
            if let key = action.value["body"]?.objectFields?["state"]?.stringValue, secureKeys.contains(key) {
                throw secretFailure("\(action.path).body")
            }
        }
        let keys = PrototypeContractValidator.strings(fields["storage"]?.objectFields?["keys"])
        for (index, key) in keys.enumerated() {
            if let parsed = PrototypeStorageKey.parse(key), case let .state(name) = parsed, secureKeys.contains(name) {
                throw secretFailure("storage.keys[\(index)]")
            }
        }
    }

    private static func checkTextBinding(_ value: JSONValue, secureKeys: Set<String>, path: String) throws {
        if let text = value.stringValue, secureKeys.contains(where: { text.contains("{\($0)}") }) {
            throw secretFailure(path)
        }
        guard let fields = value.objectFields else { return }
        if let key = fields["state"]?.stringValue, fields.count == 1, secureKeys.contains(key) {
            throw secretFailure(path)
        }
    }

    private static func secretFailure(_ path: String) -> PrototypeLibraryFailure {
        .init(path: path, message: "Secure text field bindings cannot be sent or persisted by library prototypes")
    }
}
