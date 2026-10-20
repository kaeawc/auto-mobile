import Foundation

extension PrototypeEvent {
    /// Semantic event categories. This enum may gain cases; include a default branch when switching over it.
    public enum Kind: Equatable, Sendable {
        /// A state change produced by the session, or a wire state/validation change.
        case change
        /// Completion of a request, carried as `emit` named `prototype_request`.
        case request
        /// A device data write, carried as `change` named `/data/...`.
        case dataWrite
        /// The terminal dismissal event.
        case dismissed
        /// An authored emit, including actions run on tap and submit.
        case emitted
        /// An unrecognized kind, retained with its complete wire JSON.
        case generic(String)
    }

    /// The category derived from the session event source, wire kind, and reserved event names.
    public var kind: Kind {
        switch wireKind {
        case "change" where name?.hasPrefix("/data/") == true: .dataWrite
        case "change": .change
        case "emit" where name == PrototypeRequestEvent.name: .request
        case "emit" where isStateChange: .change
        case "emit": .emitted
        case "dismissed": .dismissed
        default: .generic(wireKind)
        }
    }

    /// JSON-encoded payload, suitable for decoding into the app's own Codable type.
    public var payloadJSON: Data { Data(PrototypeJSONText.string(payload).utf8) }

    /// JSON-encoded state snapshot at this event.
    public var stateJSON: Data { Data(PrototypeJSONText.string(.object(state)).utf8) }

    /// Complete original event JSON, including timestamp, navigation, context, and future fields.
    /// Session-created events have a zero timestamp until the model attaches wall-clock time.
    public var wireJSON: Data {
        embeddedWire ?? (try? JSONSerialization.data(
            withJSONObject: wireObject(timestamp: wireTimestamp),
            options: .sortedKeys
        ))
            ?? Data("{}".utf8)
    }

    /// The terminal reason, when this is a recognized dismissal.
    public var dismissReason: PrototypeDismissReason? {
        guard kind == .dismissed, let reason = payload.objectFields?["reason"]?.stringValue else { return nil }
        switch PrototypeSessionDismissReason(rawValue: reason) {
        case .user: return .user
        case .agent, .disconnect, .ttl, nil: return nil
        }
    }

    /// Maps an internal JSON-compatible wire dictionary, retaining unknown kinds and fields.
    /// Wire-only `emit` events remain authored emits: their name cannot prove a state change.
    /// Throws Foundation's JSON error if an internal producer supplies non-JSON values.
    init(wire: [String: Any]) throws {
        let bytes = try JSONSerialization.data(withJSONObject: wire, options: .sortedKeys)
        let fields = try JSONDecoder().decode([String: JSONValue].self, from: bytes)
        self.init(
            id: fields["id"]?.stringValue ?? "", sequence: fields["sequence"]?.intValue ?? 0,
            wireKind: fields["kind"]?.stringValue ?? "", name: fields["name"]?.stringValue,
            payload: fields["payload"] ?? .null, state: fields["state"]?.objectFields ?? [:],
            pages: (fields["pages"]?.objectFields ?? [:]).compactMapValues(\.intValue), stacks: [:]
        )
        embeddedWire = bytes
    }
}
