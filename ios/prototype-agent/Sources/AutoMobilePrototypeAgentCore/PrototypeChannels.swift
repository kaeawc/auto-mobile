import Foundation

/// Contract-only realtime validation. Transports and frame routing are separate runtime slices.
enum PrototypeChannels {
    static func handlers(_ channels: [String: JSONValue]) -> [(JSONValue, String)] {
        var result: [(JSONValue, String)] = []
        for id in channels.keys.sorted() {
            guard let channel = channels[id]?.objectFields else { continue }
            let at = PrototypeLimits.dataMemberPath("channels", key: id)
            for name in ["onOpen", "onClose", "onError"] {
                if let list = channel[name] { result.append((list, "\(at).\(name)")) }
            }
            if case let .array(routes)? = channel["routes"] {
                for (index, route) in routes.enumerated() {
                    if let actions = route
                        .objectFields?["actions"] { result.append((actions, "\(at).routes[\(index)].actions")) }
                }
            }
        }
        return result
    }

    static func validate(_ channels: [String: JSONValue]?, requires: JSONValue?, state: [String: JSONValue]) throws {
        guard let channels else { return }
        guard PrototypeContractValidator.strings(requires?.objectFields?["platform"]).contains("realtime") else {
            throw fail("channels", "Channels require realtime in requires.platform")
        }
        for id in channels.keys.sorted() {
            guard let channel = channels[id]?.objectFields else { continue }
            let at = PrototypeLimits.dataMemberPath("channels", key: id)
            let raw = channel["url"]?.stringValue ?? ""
            let websocket = channel["kind"] == .string("websocket")
            let lower = raw.lowercased()
            if websocket, !lower.hasPrefix("ws:"), !lower.hasPrefix("wss:") {
                throw fail("\(at).url", "A websocket channel url must use ws or wss")
            }
            let url = websocket ? (lower.hasPrefix("wss:") ? "https:" + raw.dropFirst(4) : "http:" + raw.dropFirst(3)) :
                raw
            try PrototypeRequestValidator.url(.string(url), path: "\(at).url", checkLength: false)
            for name in (channel["headers"]?.objectFields ?? [:]).keys.sorted() {
                if name.lowercased().hasPrefix("sec-websocket-") || name.lowercased() == "last-event-id" {
                    throw fail(PrototypeLimits.dataMemberPath("\(at).headers", key: name), "Forbidden channel header")
                }
            }
            try PrototypeRequestValidator.entries(channel["headers"], path: "\(at).headers", isHeader: true)
            if !websocket,
               channel["protocols"] !=
               nil { throw fail("\(at).protocols", "protocols are only available for websocket channels") }
            if let key = channel["statusKey"]?.stringValue {
                guard let value = state[key] else { throw fail(
                    "\(at).statusKey",
                    "statusKey must name a declared state key"
                ) }
                guard value.stringValue != nil else { throw fail(
                    "\(at).statusKey",
                    "statusKey requires a string state key"
                ) }
            }
            if let reconnect = channel["reconnect"]?.objectFields,
               let initial = reconnect["initialDelayMs"]?.numberValue,
               let maximum = reconnect["maxDelayMs"]?.numberValue,
               initial > maximum
            { throw fail(
                "\(at).reconnect.initialDelayMs",
                "initialDelayMs must not exceed maxDelayMs"
            ) }
            if case let .array(routes)? = channel["routes"] {
                for (index, route) in routes.enumerated() {
                    guard case let .array(actions)? = route.objectFields?["actions"] else { continue }
                    for (actionIndex, action) in actions.enumerated() {
                        guard [
                            "setState",
                            "toggle",
                            "increment",
                            "decrement",
                            "setData",
                            "appendData",
                            "prependData",
                            "upsertData",
                            "removeData",
                        ].contains(action.objectFields?["type"]?.stringValue ?? "") else {
                            throw fail(
                                "\(at).routes[\(index)].actions[\(actionIndex)].type",
                                "Channel routes only allow state and data actions"
                            )
                        }
                    }
                }
            }
        }
    }

    static func call(_ action: [String: JSONValue], path: String, channels: [String: JSONValue]) throws {
        guard let call = action["call"]?.stringValue, call.hasPrefix("realtime.") else { return }
        let selector = action["args"]?.objectFields?["channel"]
        let id = selector?.stringValue ?? selector?.objectFields?["value"]?.stringValue
        guard let id, let channel = channels[id]?.objectFields else { throw fail(
            "\(path).args.channel",
            "channel must name a declared channel"
        ) }
        if call == "realtime.send",
           channel["kind"] !=
           .string("websocket") { throw fail("\(path).call", "realtime.send requires a websocket channel") }
    }

    private static func fail(_ path: String, _ message: String) -> PrototypeLoadError {
        PrototypeContractValidator.invalid(path, message)
    }
}

/// Budgets from the shared contract; no transport or flush scheduling is performed here.
enum PrototypeChannelLimits {
    private static func limit(_ name: String) -> Int { PrototypeContractValidator.limit(name) }
    static let maxChannels = limit("MAX_PROTOTYPE_CHANNELS")
    static let maxFrameBytes = limit("MAX_PROTOTYPE_CHANNEL_FRAME_BYTES")
    static let maxSendBytes = limit("MAX_PROTOTYPE_CHANNEL_SEND_BYTES")
    static let maxChannelsOpen = limit("MAX_PROTOTYPE_CHANNELS_OPEN")
    static let flushMs = limit("PROTOTYPE_CHANNEL_FLUSH_MS")
}
