import Foundation

/// `style.effects` count limits (#15128), the Swift twin of `prototypeEffects.ts`: every declared
/// effect counts against `MAX_PROTOTYPE_EFFECTS`, and those with an `animate` also against
/// `MAX_PROTOTYPE_ANIMATED_EFFECTS`, over the node's own style and every `styleWhen` style.
struct PrototypeEffectUses {
    var total = 0
    var animated = 0

    /// The contract's per-list maximum; a longer list is a structural error the walk reports.
    private static let maxPerList = Int(
        PrototypeContractValidator.definition("style")?.objectFields?["fields"]?.objectFields?["effects"]?
            .objectFields?["rule"]?.objectFields?["max"]?.numberValue ?? 0
    )

    init() {}

    init(node: [String: JSONValue]) {
        if node["type"] == .string("icon"), node["effect"]?.objectFields?["repeat"] != nil {
            animated = 1
        }
        let when = PrototypeStrictBindings.array(node["styleWhen"]).map { $0.objectFields?["style"] }
        for style in [node["style"]] + when {
            let effects = PrototypeStrictBindings.array(style?.objectFields?["effects"]).prefix(Self.maxPerList)
            total += effects.count
            animated += effects.count { $0.objectFields?["animate"] != nil }
        }
    }

    mutating func add(_ other: PrototypeEffectUses) {
        total += other.total
        animated += other.animated
    }
}
