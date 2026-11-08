import Foundation

/// Data decoders for the `cast` platform module's events (#14239), the Swift twin of
/// `src/features/prototype/prototypeCastEvents.ts`. All three replay
/// `test/fixtures/prototype-spec/cast/events.json`. Every event's data is a closed object.
enum PrototypeCastEvents {
    static let events = [
        "routesChanged", "sessionStarting", "sessionStarted", "sessionEnded", "sessionFailed", "remoteVolume",
    ]

    /// Why a session failed. `media_not_castable`: the player source is not an absolute http(s) URL.
    static let failureReasons = ["media_not_castable", "play_services_unavailable", "network", "receiver"]

    /// A decoded `cast.*` event: its short name and its validated data.
    struct Event: Equatable, Sendable {
        let name: String
        let data: [String: JSONValue]
    }

    private typealias Field = @Sendable (JSONValue) -> Bool

    private struct Shape: Sendable {
        let required: [String: Field]
        var optional: [String: Field] = [:]
    }

    private static let states: Set = ["unavailable", "noDevices", "notConnected", "connecting", "connected"]
    private static let protocols: Set = ["googleCast", "airplay"]

    private static func string(_ range: ClosedRange<Int>) -> Field {
        { value in value.stringValue.map { range.contains($0.utf16.count) } ?? false }
    }

    private static func oneOf(_ values: Set<String>) -> Field {
        { value in value.stringValue.map { values.contains($0) } ?? false }
    }

    private static let count: Field = { value in
        value.numberValue.map { $0.isFinite && $0 >= 0 && $0.rounded(.towardZero) == $0 } ?? false
    }

    private static let fraction: Field = { value in value.numberValue.map { (0 ... 1).contains($0) } ?? false }

    private static let player = string(1 ... 64)
    private static let session: [String: Field] = [
        "player": player, "protocol": oneOf(protocols), "deviceName": string(0 ... 256),
    ]

    private static let shapes: [String: Shape] = [
        "routesChanged": Shape(required: ["state": oneOf(states), "routeCount": count]),
        "sessionStarting": Shape(required: session),
        "sessionStarted": Shape(required: session.merging(["positionMs": count]) { $1 }),
        "sessionEnded": Shape(required: session.merging(["positionMs": count]) { $1 }),
        "sessionFailed": Shape(
            required: ["player": player, "reason": oneOf(Set(failureReasons))],
            optional: ["protocol": oneOf(protocols)]
        ),
        "remoteVolume": Shape(required: ["volume": fraction]),
    ]

    /// Decode a delivered platform event's `data` for a qualified `cast.<event>` name, or nil for
    /// another module's event, an unknown cast event or data of the wrong shape.
    static func decode(_ event: String, _ data: JSONValue) -> Event? {
        let prefix = "cast."
        guard event.hasPrefix(prefix), let shape = shapes[String(event.dropFirst(prefix.count))],
              let fields = data.objectFields
        else { return nil }
        let known = fields.keys.allSatisfy { shape.required[$0] != nil || shape.optional[$0] != nil }
            && shape.required.allSatisfy { key, field in fields[key].map(field) ?? false }
            && shape.optional.allSatisfy { key, field in fields[key].map(field) ?? true }
        return known ? Event(name: String(event.dropFirst(prefix.count)), data: fields) : nil
    }
}
