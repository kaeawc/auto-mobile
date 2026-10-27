import Foundation

/// Glass has no simulated material tier: unsupported operating systems refuse its capability.
enum PrototypeGlass {
    static func edgeFades(effect: String?, axis: String?, authored: FadeEdges?) -> FadeEdges? {
        guard let effect else { return authored }
        if let authored { return authored }
        if effect == "none" { return nil }
        let length = effect == "hard" ? 8.0 : 24.0
        return axis == "horizontal"
            ? FadeEdges(top: nil, bottom: nil, start: length, end: length)
            : FadeEdges(top: length, bottom: length, start: nil, end: nil)
    }

    static func capabilities(_ node: [String: JSONValue]) -> Set<String> {
        var result = Set<String>()
        let keys = ["glassGroup", "glassUnion", "glassTransition", "backgroundExtension"]
        if PrototypeStylePolishV2.styles(node).contains(where: { $0["surface"] != nil || $0["glass"] != nil }) ||
            keys.contains(where: { node["ios"]?.objectFields?[$0] != nil })
        {
            result.insert("prototype_glass_v1")
        }
        if node["type"] == .string("scroll"), node["edgeEffect"] != nil {
            result.insert("prototype_scroll_edge_effect_v1")
        }
        return result
    }

    static func sharedGroup(_ node: PrototypeLocatedValue, nodes: [PrototypeLocatedValue]) -> String? {
        guard node.value["shared"] != nil,
              node.value["style"]?.objectFields?["surface"] == .string("glass") else { return nil }
        return nodes.last { node.path.hasPrefix("\($0.path).") && $0.value["ios"]?.objectFields?["glassGroup"] != nil }?
            .path
    }

    static func needsNamespace(_ node: [String: JSONValue]) -> Bool {
        if node["android"] != nil { return true }
        guard let ios = node["ios"]?.objectFields else { return false }
        return ios.isEmpty || ios.keys
            .contains { !["glassGroup", "glassUnion", "glassTransition", "backgroundExtension"].contains($0) }
    }

    static func validateObject(_ data: [String: JSONValue], kind: String, path: String) throws {
        if kind == "style", data["glass"] != nil, data["surface"] != .string("glass") {
            throw PrototypeContractValidator.invalid(
                "\(path).glass",
                path.contains(".styleWhen[")
                    ? "styleWhen glass requires surface: \"glass\" in the same style" :
                    "glass requires surface: \"glass\""
            )
        }
        guard let ios = data["ios"]?.objectFields else { return }
        if path == "window" || path == "theme" {
            for key in ["glassGroup", "glassUnion", "glassTransition", "backgroundExtension"] where ios[key] != nil {
                throw PrototypeContractValidator.invalid("\(path).ios.\(key)", "\(key) is only valid on a node")
            }
        }
        let containers = ["column", "row", "box", "flow", "grid", "list", "listItem"]
        if ios["glassGroup"] != nil, !containers.contains(data["type"]?.stringValue ?? "") {
            throw PrototypeContractValidator.invalid("\(path).ios.glassGroup", "glassGroup requires a container node")
        }
        for key in ["glassUnion", "glassTransition"] where ios[key] != nil &&
            data["style"]?.objectFields?["surface"] != .string("glass")
        {
            throw PrototypeContractValidator.invalid("\(path).ios.\(key)", "\(key) requires a glass surface")
        }
        if ios["backgroundExtension"] != nil, data["type"] != .string("image") {
            throw PrototypeContractValidator.invalid(
                "\(path).ios.backgroundExtension",
                "backgroundExtension requires an image node"
            )
        }
    }
}
