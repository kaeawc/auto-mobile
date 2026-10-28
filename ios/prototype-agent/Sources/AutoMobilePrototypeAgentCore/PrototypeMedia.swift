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
