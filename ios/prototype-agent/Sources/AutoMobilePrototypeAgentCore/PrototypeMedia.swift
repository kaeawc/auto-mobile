import Foundation

/// Rules for the root `media` block and the `media` platform module (#14253) that the contract
/// cannot express, the twin of the host's `prototypeMedia.ts`: the block needs `media` in
/// `requires.platform`, `/platform/media` reads name a declared player and one of its state keys,
/// and a literal `player` argument names a declared player. Contract only: no runtime plays media.
enum PrototypeMedia {
    /// The ids of the players declared in the root `media.players` block.
    static func players(_ media: JSONValue?) -> Set<String> {
        guard let declared = media?.objectFields?["players"]?.objectFields else { return [] }
        return Set(declared.keys)
    }

    static func validate(_ media: JSONValue?, requires: JSONValue?) throws {
        guard media != nil else { return }
        guard PrototypeContractValidator.strings(requires?.objectFields?["platform"]).contains("media") else {
            throw PrototypeLimits.violation("media", "Media players require media in requires.platform")
        }
    }

    /// Ids of node-scoped players: every `videoPlayer` with an inline `source`, keyed by its id. Only
    /// node positions are walked (the host's `prototypeNodeChildren`), so a videoPlayer-shaped value
    /// in an action payload never declares a player, and a screen of any name is still visited.
    static func inlinePlayers(_ root: JSONValue) -> Set<String> {
        guard let fields = root.objectFields else { return [] }
        return nodePlayers(.init(value: fields, path: "root"))
    }

    private static func nodePlayers(_ node: PrototypeLocatedValue) -> Set<String> {
        var found = PrototypeStrictRepeats.children(node.value, path: node.path)
            .reduce(into: Set<String>()) { $0.formUnion(nodePlayers($1)) }
        if node.value["type"] == .string("videoPlayer"), node.value["source"] != nil,
           let id = node.value["id"]?.stringValue { found.insert(id) }
        return found
    }

    /// Throws at the first `videoPlayer` node rule a spec breaks.
    static func validateNodes(_ spec: [String: JSONValue], nodes: [PrototypeLocatedValue]) throws {
        let declared = players(spec["media"])
        let media = PrototypeContractValidator.strings(spec["requires"]?.objectFields?["platform"]).contains("media")
        let state = spec["state"]?.objectFields ?? [:]
        for node in nodes where node.value["type"] == .string("videoPlayer") {
            try validateNode(node.value, path: node.path, declared: declared, media: media, state: state)
        }
    }

    /// Throws at the first `castButton` node rule a spec breaks (#14239): it needs `cast` in
    /// `requires.platform` and its `player` names a declared or inline media player.
    static func validateCastButtons(_ spec: [String: JSONValue], nodes: [PrototypeLocatedValue]) throws {
        let cast = PrototypeContractValidator.strings(spec["requires"]?.objectFields?["platform"]).contains("cast")
        let known = players(spec["media"]).union(spec["root"].map(inlinePlayers) ?? [])
        for node in nodes where node.value["type"] == .string("castButton") {
            guard cast else {
                throw PrototypeLimits.violation(node.path, "castButton requires cast in requires.platform")
            }
            if let player = node.value["player"]?.stringValue, !known.contains(player) {
                throw PrototypeLimits.violation("\(node.path).player", "Unknown media player")
            }
        }
    }

    private static func validateNode(
        _ node: [String: JSONValue], path: String, declared: Set<String>, media: Bool, state: [String: JSONValue]
    ) throws {
        guard media else { throw PrototypeLimits.violation(path, "videoPlayer requires media in requires.platform") }
        guard (node["player"] == nil) != (node["source"] == nil) else {
            throw PrototypeLimits.violation(path, "A videoPlayer needs exactly one of player or source")
        }
        if let player = node["player"]?.stringValue, !declared.contains(player) {
            throw PrototypeLimits.violation("\(path).player", "Unknown media player")
        }
        if node["source"] != nil {
            guard let id = node["id"]?.stringValue, PrototypeContractValidator.matches("stateKey", id) else {
                throw PrototypeLimits.violation(path, "An inline videoPlayer needs an id that is a state key")
            }
            if declared.contains(id) {
                throw PrototypeLimits.violation(
                    "\(path).id", "An inline videoPlayer id cannot repeat a declared player"
                )
            }
        }
        if let key = node["positionKey"]?.stringValue {
            guard case .number? = state[key] else {
                throw PrototypeLimits.violation(
                    "\(path).positionKey", "positionKey must name a declared number state key"
                )
            }
        }
        try validateFeedFields(node, path: path)
    }

    /// `visibleThreshold` and `resumePosition` tune `autoplay: "whenVisible"` only (#14258).
    private static func validateFeedFields(_ node: [String: JSONValue], path: String) throws {
        guard node["autoplay"] != .string("whenVisible") else { return }
        if let field = ["visibleThreshold", "resumePosition"].first(where: { node[$0] != nil }) {
            throw PrototypeLimits.violation("\(path).\(field)", "\(field) needs autoplay whenVisible")
        }
    }

    /// A `/media/players/<id>/<key>` read of a declared player's state key.
    static func validRead(_ tokens: [String], players: Set<String>, state: Set<String>) -> Bool {
        tokens.count == 4 && tokens[1] == "players" && players.contains(tokens[2]) && state.contains(tokens[3])
    }

    /// Throws when a `media.*` call's literal `player` argument names no declared player.
    static func call(_ action: [String: JSONValue], path: String, players: Set<String>) throws {
        guard let call = action["call"]?.stringValue, call.hasPrefix("media.") else { return }
        guard let player = action["args"]?.objectFields?["player"]?.objectFields?["value"]?.stringValue,
              !players.contains(player)
        else { return }
        throw PrototypeLimits.violation("\(path).args.player.value", "Unknown media player")
    }
}
