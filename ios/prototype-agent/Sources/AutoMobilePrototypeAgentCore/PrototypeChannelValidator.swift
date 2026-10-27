import Foundation

/// Reject-only rules for realtime channels (#14261), a Swift twin of `prototypeChannels.ts`: the
/// root `channels` block (URL scheme per kind, forbidden headers, `requires.platform`, the
/// `statusKey` type, `when` forms and the actions a route may run) and `realtime.*` calls naming a
/// declared channel. The contract walk types the fields; this adds what it cannot. Running a
/// channel is the runtime's job (#14268, #14269, #14270): no iOS runtime advertises the gate yet.
enum PrototypeChannelValidator {
    static let module = "realtime"
    private static let hooks = ["onOpen", "onClose", "onError"]
    private static let refusedInRoutes: [String: String] = [
        "request": "A request action cannot run from a channel, so a frame cannot trigger traffic loops",
        "push": "A navigation action cannot run from a channel",
        "pop": "A navigation action cannot run from a channel",
        "popToRoot": "A navigation action cannot run from a channel",
        "replace": "A navigation action cannot run from a channel",
        "setPage": "A navigation action cannot run from a channel",
    ]

    /// The first channel rule the spec breaks: `requires.platform`, then each channel in sorted id
    /// order. `realtime.*` call arguments are checked with the other platform calls.
    static func validate(channels raw: JSONValue?, requires: JSONValue?, state: [String: JSONValue]) throws {
        guard case let .object(channels)? = raw else { return }
        let declared = PrototypeContractValidator.strings(requires?.objectFields?["platform"])
        if !channels.isEmpty, !declared.contains(module) {
            throw fail("channels", "channels require realtime in requires.platform")
        }
        for id in channels.keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) }) {
            try validateChannel(id, channels[id]?.objectFields ?? [:], state: state)
        }
    }

    /// `realtime.*` calls name a declared channel, and `realtime.send` a websocket one.
    static func checkCall(
        _ call: String, args: [String: JSONValue], path: String, channels: [String: JSONValue]
    )
        throws
    {
        guard call.hasPrefix("\(module)."),
              case let .string(name)? = args["channel"]?.objectFields?["value"]
        else { return }
        let at = "\(path).args.channel.value"
        guard let channel = channels[name]?.objectFields else { throw fail(at, "Unknown channel \(name)") }
        if call == "realtime.send", channel["kind"]?.stringValue != "websocket" {
            throw fail(at, "realtime.send needs a websocket channel")
        }
    }

    private static func validateChannel(_ id: String, _ channel: [String: JSONValue], state: [String: JSONValue]) throws {
        let at = PrototypeLimits.dataMemberPath("channels", key: id)
        guard id.range(of: "^[A-Za-z0-9_]+$", options: .regularExpression) != nil else {
            throw fail(at, "A channel id is letters, digits and underscores")
        }
        let kind = channel["kind"]?.stringValue
        if let url = channel["url"]?.stringValue, let message = urlError(kind, url) { throw fail("\(at).url", message) }
        if let protocols = channel["protocols"] {
            guard kind == "websocket" else { throw fail("\(at).protocols", "protocols apply to websocket channels only") }
            if case let .array(items) = protocols {
                for (index, item) in items.enumerated() {
                    guard let text = item.stringValue,
                          text.range(of: "^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+$", options: .regularExpression) != nil
                    else { throw fail("\(at).protocols[\(index)]", "Invalid websocket subprotocol") }
                }
            }
        }
        try PrototypeRequestValidator.entries(channel["headers"], path: "\(at).headers", isHeader: true)
        for name in channel["headers"]?.objectFields?.keys.sorted() ?? [] {
            let lower = name.lowercased()
            if lower.hasPrefix("sec-websocket-") || lower == "last-event-id" {
                throw fail(PrototypeLimits.dataMemberPath("\(at).headers", key: name), "Forbidden channel header")
            }
        }
        try PrototypeRequestValidator.statusKey(channel["statusKey"], path: "\(at).statusKey", state: state)
        try reconnect(channel["reconnect"]?.objectFields, at: at)
        try routes(channel, kind: kind, at: at)
    }

    private static func urlError(_ kind: String?, _ url: String) -> String? {
        let websocket = kind == "websocket"
        let message = websocket
            ? "A websocket channel url must be an absolute ws or wss URL"
            : "An sse channel url must be an absolute http or https URL"
        let schemes = websocket ? ["ws", "wss"] : ["http", "https"]
        if url.contains("{") {
            let prefix = url.prefix { $0 != ":" }.lowercased()
            return schemes.contains(prefix) && url.dropFirst(prefix.count).hasPrefix("://") ? nil : message
        }
        guard let parsed = URL(string: url), let scheme = parsed.scheme?.lowercased(), schemes.contains(scheme),
              parsed.host?.isEmpty == false
        else { return message }
        return nil
    }

    private static func reconnect(_ reconnect: [String: JSONValue]?, at: String) throws {
        let initial = reconnect?["initialDelayMs"]?.numberValue ?? 500
        let maximum = reconnect?["maxDelayMs"]?.numberValue ?? 30000
        if maximum < initial {
            throw fail("\(at).reconnect.maxDelayMs", "maxDelayMs must be at least initialDelayMs")
        }
    }

    private static func routes(_ channel: [String: JSONValue], kind: String?, at: String) throws {
        if case let .array(routes)? = channel["routes"] {
            for (index, entry) in routes.enumerated() {
                let route = entry.objectFields ?? [:]
                let routeAt = "\(at).routes[\(index)]"
                if let when = route["when"]?.objectFields {
                    if when["event"] != nil, kind != "sse" {
                        throw fail("\(routeAt).when.event", "when.event applies to sse channels only")
                    }
                    if when["pointer"] != nil, channel["decode"]?.stringValue == "text" {
                        throw fail(
                            "\(routeAt).when.pointer",
                            "A pointer condition needs decode json; a text frame has no members"
                        )
                    }
                }
                try refused(route["actions"], at: "\(routeAt).actions")
            }
        }
        for hook in hooks { try refused(channel[hook], at: "\(at).\(hook)") }
    }

    /// The first refused action in `actions` or the follow-up lists nested in them.
    private static func refused(_ actions: JSONValue?, at: String) throws {
        guard case let .array(items)? = actions else { return }
        for (index, entry) in items.enumerated() {
            let here = "\(at)[\(index)]"
            let action = entry.objectFields ?? [:]
            if let type = action["type"]?.stringValue, let message = refusedInRoutes[type] { throw fail(here, message) }
            for nested in ["onSuccess", "onError", "actions"] { try refused(action[nested], at: "\(here).\(nested)") }
        }
    }

    private static func fail(_ path: String, _ message: String) -> DecodingError {
        PrototypeLimits.violation(path, message)
    }
}
