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

    /// Ids of node-scoped players: every `videoPlayer` with an inline `source`, keyed by its id.
    /// `{value}` literals and opaque fields (an emit `payload`, `data`, a request `body`) are not
    /// walked, so a videoPlayer-shaped value an action carries never declares a player.
    static func inlinePlayers(_ value: JSONValue) -> Set<String> {
        switch value {
        case let .array(items):
            return items.reduce(into: Set<String>()) { $0.formUnion(inlinePlayers($1)) }
        case let .object(fields):
            if fields.count == 1, fields["value"] != nil { return [] }
            var found = fields.filter { !PrototypeContractValidator.stringOpaqueFields.contains($0.key) }
                .values.reduce(into: Set<String>()) { $0.formUnion(inlinePlayers($1)) }
            if fields["type"] == .string("videoPlayer"), fields["source"] != nil,
               let id = fields["id"]?.stringValue { found.insert(id) }
            return found
        default:
            return []
        }
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
