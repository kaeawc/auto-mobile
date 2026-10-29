import Foundation

/// Rules for a media player's `queue` (#14249) that the contract cannot express, the twin of the host's
/// `prototypeMediaQueue.ts`: a player has exactly one of `source` or `queue`, the queue points at a
/// declared `/data` array, and each item is a `mediaQueueItem` with a unique `id`.
enum PrototypeMediaQueue {
    private static let itemRule: JSONValue = .object(["kind": .string("ref"), "name": .string("mediaQueueItem")])

    /// Whether any declared player has a queue, which needs `prototype_platform_media_queue_v1`.
    static func queued(_ spec: [String: JSONValue]) -> Bool {
        let players = spec["media"]?.objectFields?["players"]?.objectFields ?? [:]
        return players.values.contains { $0.objectFields?["queue"] != nil }
    }

    /// Throws at the first queue rule a spec's `media.players` break, visiting ids in sorted order.
    static func validate(_ spec: [String: JSONValue]) throws {
        let players = spec["media"]?.objectFields?["players"]?.objectFields ?? [:]
        for id in PrototypeContractValidator.sorted(players.keys) {
            guard let player = players[id]?.objectFields else { continue }
            let path = PrototypeContractValidator.keyPath("media.players", id)
            guard (player["source"] == nil) != (player["queue"] == nil) else {
                throw PrototypeLimits.violation(path, "A media player needs exactly one of source or queue")
            }
            guard let queue = player["queue"] else { continue }
            try validateQueue(queue.stringValue, data: spec["data"]?.objectFields, path: "\(path).queue")
        }
    }

    private static func validateQueue(_ queue: String?, data: [String: JSONValue]?, path: String) throws {
        guard let queue, queue.hasPrefix("/data/"),
              case let .array(items)? = PrototypeDataPointer.resolve(data, pointer: String(queue.dropFirst(5)))
        else { throw PrototypeLimits.violation(path, "queue must point to a /data array") }
        let base = PrototypeDataPointer.tokens(String(queue.dropFirst(5)))
            .reduce("data") { PrototypeContractValidator.keyPath($0, $1) }
        // Exact UTF-16 code units, as the host and Kotlin compare: a Swift String set would merge
        // canonically equivalent ids such as "\u{e9}" and "e\u{301}".
        var seen: Set<[UInt16]> = []
        for (index, item) in items.enumerated() {
            let at = "\(base)[\(index)]"
            try PrototypeContractValidator.validateValue(item, rule: itemRule, path: at)
            if let itemId = item.objectFields?["id"]?.stringValue, !seen.insert(Array(itemId.utf16)).inserted {
                throw PrototypeLimits.violation("\(at).id", "Duplicate queue item id")
            }
        }
    }
}
