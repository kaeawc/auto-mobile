import Foundation

/// Notification rules (#14280) the contract cannot express, the twin of TypeScript's
/// `prototypeNotifications.ts`: the root `notifications` block needs `notifications` in
/// `requires.platform` and unique channel ids; a literal `notifications.post` channel names a declared
/// channel and its action ids are unique; `notifications.cancel` names exactly one target; a
/// channel-scoped `/platform` read names a declared channel.
enum PrototypeNotificationRules {
    private static let cancelTargets = ["id", "group", "all"]
    /// Channel-scoped `/platform` keys, read at `/notifications/channels/<id>/<key>`.
    private static let channelStateKeys: Set<String> = ["blocked"]

    /// Whether a `/notifications` read names a module key or a declared channel's key.
    static func validRead(_ tokens: [String], channels: Set<String>, state: Set<String>) -> Bool {
        if tokens.count > 1, tokens[1] == "channels" {
            return tokens.count == 4 && channels.contains(tokens[2]) && channelStateKeys.contains(tokens[3])
        }
        return tokens.count == 2 && state.contains(tokens[1]) && !channelStateKeys.contains(tokens[1])
    }

    static func validateBlock(_ notifications: JSONValue?, requires: JSONValue?) throws {
        guard let block = notifications?.objectFields else { return }
        guard PrototypeContractValidator.strings(requires?.objectFields?["platform"]).contains("notifications") else {
            throw PrototypeContractValidator.invalid(
                "notifications", "The notifications block requires notifications in requires.platform"
            )
        }
        if let index = duplicateIdIndex(block["channels"]) {
            throw PrototypeContractValidator.invalid("notifications.channels[\(index)].id", "Duplicate channel id")
        }
    }

    /// The channel ids a literal `notifications.post` channel may name.
    static func channels(_ notifications: JSONValue?) -> Set<String> {
        guard case let .array(channels)? = notifications?.objectFields?["channels"] else { return [] }
        return Set(channels.compactMap { $0.objectFields?["id"]?.stringValue })
    }

    static func validateCall(_ call: String, args: [String: JSONValue], path: String, channels: Set<String>) throws {
        switch call {
        case "notifications.cancel":
            guard cancelTargets.count(where: { args[$0] != nil }) == 1 else {
                throw PrototypeContractValidator.invalid(
                    "\(path).args", "notifications.cancel takes exactly one of id, group or all"
                )
            }
        case "notifications.post", "notifications.schedule":
            // A bound channel or action list is checked by the runtime once it resolves.
            if case let .string(channel)? = args["channel"]?.objectFields?["value"], !channels.contains(channel) {
                throw PrototypeContractValidator.invalid(
                    "\(path).args.channel.value",
                    "Undeclared notification channel"
                )
            }
            if let index = duplicateIdIndex(args["actions"]?.objectFields?["value"]) {
                throw PrototypeContractValidator.invalid(
                    "\(path).args.actions.value[\(index)].id",
                    "Duplicate action id"
                )
            }
        default:
            return
        }
    }

    /// The index of the first entry whose `id` repeats an earlier entry's.
    private static func duplicateIdIndex(_ list: JSONValue?) -> Int? {
        guard case let .array(entries)? = list else { return nil }
        var seen: [JSONValue?] = []
        for (index, entry) in entries.enumerated() {
            let id = entry.objectFields?["id"]
            if seen.contains(id) { return index }
            seen.append(id)
        }
        return nil
    }
}
