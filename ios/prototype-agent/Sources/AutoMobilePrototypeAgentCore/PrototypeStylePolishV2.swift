import Foundation

/// Cross-field validation and capability detection over authored nodes.
enum PrototypeStylePolishV2 {
    static let capability = PrototypeAgentProtocol.stylePolishV2Capability

    static func styles(_ node: [String: JSONValue]) -> [[String: JSONValue]] {
        let conditional: [JSONValue]
        if case let .array(entries)? = node["styleWhen"] { conditional = entries } else { conditional = [] }
        return [node["style"]?.objectFields].compactMap { $0 } + conditional
            .compactMap { $0.objectFields?["style"]?.objectFields }
    }

    static func required(_ node: [String: JSONValue]) -> Bool {
        node["fadeEdges"] != nil || node["filter"] != nil || styles(node).contains {
            $0["shadows"] != nil || $0["cornerStyle"] != nil || $0["border"]?.objectFields?["gradient"] != nil
        }
    }

    static func themedColors(_ node: [String: JSONValue]) -> Bool {
        if node["filter"]?.objectFields?["tint"]?.objectFields != nil { return true }
        if themedBorder(node) { return true }
        if styles(node).contains(where: { $0["glass"]?.objectFields?["tint"]?.objectFields != nil }) { return true }
        return styles(node).contains { style in
            guard case let .array(shadows)? = style["shadows"] else { return false }
            return shadows.contains { $0.objectFields?["color"]?.objectFields != nil }
        }
    }

    static func themedBorder(_ node: [String: JSONValue]) -> Bool {
        styles(node).contains { style in
            guard case let .array(stops)? = style["border"]?.objectFields?["gradient"]?.objectFields?["stops"]
            else { return false }
            return stops.contains { stop in
                guard let color = stop.objectFields?["color"] else { return false }
                return color.objectFields != nil || color.stringValue.map { !$0.hasPrefix("#") } == true
            }
        }
    }

    static func validateObject(_ data: [String: JSONValue], kind: String, path: String) throws {
        if kind == "style", data["shadows"] != nil, data["elevation"] != nil || data["shadowColor"] != nil {
            throw PrototypeContractValidator.invalid(
                "\(path).shadows",
                "shadows cannot be combined with elevation or shadowColor"
            )
        }
        if data.isEmpty, ["fadeEdges", "imageFilter"].contains(kind) {
            throw PrototypeContractValidator.invalid(
                path,
                kind == "fadeEdges" ? "At least one fade edge is required" :
                    "At least one image filter field is required"
            )
        }
    }
}
