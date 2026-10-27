import Foundation

/// Tooltip relationships are checked after components/repeats expand. Strict diagnostics retain authored paths.
enum PrototypeTooltips {
    static func spotlightRect(target: CGRect, spotlight: TooltipSpotlight) -> CGRect {
        target.insetBy(dx: -CGFloat(spotlight.padding ?? 8), dy: -CGFloat(spotlight.padding ?? 8))
    }

    static func validate(_ raw: JSONValue) throws {
        var nodes: [PrototypeLocatedValue] = []
        func collect(_ fields: [String: JSONValue], path: String) {
            nodes.append(.init(value: fields, path: path))
            for child in PrototypeStrictRepeats.children(fields, path: path) {
                collect(child.value, path: child.path)
            }
        }
        collect(raw.objectFields ?? [:], path: "root")
        for node in nodes where ["tooltip", "drawer"].contains(node.value["type"]?.stringValue ?? "") {
            // Reuse the generated structural contract rather than maintaining a second key vocabulary.
            do {
                _ = try PrototypeContractValidator.inspect(.object([
                    "id": .string("prototype"),
                    "window": .object(["placement": .object(["type": .string("fullscreen")])]),
                    "root": .object(node.value),
                ]))
            } catch let PrototypeLoadError.invalidSpec(path, message) {
                throw PrototypeContractValidator.invalid(node.path + path.dropFirst(4), message)
            }
        }
        try validate(nodes: nodes)
    }

    static func validate(nodes: [PrototypeLocatedValue], scopes: [PrototypeStrictRepeats.Scope] = []) throws {
        var counts: [String: Int] = [:]
        for node in nodes {
            guard let id = node.value["id"]?.stringValue else { continue }
            let count = scopes.first { node.path.hasPrefix("\($0.path).children[") }?.items.count ?? 1
            counts[id, default: 0] += count
        }
        for node in nodes where node.value["type"] == .string("tooltip") {
            let fields = node.value
            guard (fields["anchorTo"] != nil) != (fields["anchor"] != nil) else {
                throw PrototypeContractValidator.invalid(
                    "\(node.path).anchorTo",
                    "Exactly one of anchorTo, anchor is required"
                )
            }
            if fields["text"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false {
                throw PrototypeContractValidator.invalid("\(node.path).text", "Invalid string value")
            }
            if let id = fields["anchorTo"]?.stringValue {
                let count = counts[id, default: 0]
                if count != 1 || fields["id"] == .string(id) {
                    let quoted = try String(data: JSONEncoder().encode(id), encoding: .utf8) ?? "\"\(id)\""
                    throw PrototypeContractValidator.invalid(
                        "\(node.path).anchorTo",
                        "\(count > 1 ? "Duplicate" : "Unknown") anchorTo id \(quoted)"
                    )
                }
            }
        }
    }
}

extension PrototypeNode {
    var identity: ObjectIdentifier { ObjectIdentifier(self) }

    func renderedNode(
        id wanted: String,
        state: [String: JSONValue],
        pages: [String: Int],
        stacks: [String: PrototypeStackSnapshot]
    )
        -> PrototypeNode?
    {
        guard visibleWhen?.holds(state) ?? true else { return nil }
        if prototypeModalTypes.contains(type) || type == "bottomSheet",
           !(openWhen?.holds(state) ?? false) { return nil }
        if id == wanted { return self }
        for entry in currentChildEntries(path: "root", pages: pages, stacks: stacks, state: state) {
            if let found = entry.node
                .renderedNode(id: wanted, state: state, pages: pages, stacks: stacks) { return found }
        }
        return nil
    }
}
