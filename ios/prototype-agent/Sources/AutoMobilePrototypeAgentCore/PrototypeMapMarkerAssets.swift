import Foundation

/// The image asset a `map` node's `markers.icon` names (#16491), the twin of TypeScript's
/// `prototypeMapMarkerAsset`: `{"asset": id}` instead of a Material icon name.
enum PrototypeMapMarkerAssets {
    /// The asset id, or nil for an icon name or a per-marker `{alias.field}` template.
    static func asset(_ node: [String: JSONValue]) -> String? {
        guard node["type"] == .string("map"),
              let id = node["markers"]?.objectFields?["icon"]?.objectFields?["asset"]?.stringValue,
              id.range(of: #"\{[^{}]+\}"#, options: .regularExpression) == nil
        else { return nil }
        return id
    }

    /// Throws at the first map whose marker asset is not in a complete uploaded asset inventory.
    static func validateKnown(_ nodes: [PrototypeLocatedValue], assets: Set<String>) throws {
        for node in nodes {
            if let id = asset(node.value), !assets.contains(id) {
                throw PrototypeContractValidator.invalid("\(node.path).markers.icon.asset", "Unknown marker asset")
            }
        }
    }
}
