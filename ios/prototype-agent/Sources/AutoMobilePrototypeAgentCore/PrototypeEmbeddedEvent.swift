import Foundation

extension PrototypeEvent {
    /// Semantic event categories. Tap and submit actions currently deliver authored `emitted`
    /// events; they do not manufacture separate wire events for each interaction.
    public enum Kind: Equatable, Sendable {
        /// A tap event from a wire producer that supplies this kind.
        case tap
        /// A state or validation change (including the existing `emit` named `change`).
        case change
        /// A submit event from a wire producer that supplies this kind.
        case submit
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

    /// The category derived from the real wire kind and reserved event names.
    public var type: Kind {
        switch kind {
        case "tap": .tap
        case "submit": .submit
        case "change" where name?.hasPrefix("/data/") == true: .dataWrite
        case "change": .change
        case "emit" where name == PrototypeRequestEvent.name: .request
        case "emit" where name == "change": .change
        case "emit": .emitted
        case "dismissed": .dismissed
        default: .generic(kind)
        }
    }

    /// JSON-encoded payload, suitable for decoding into the app's own Codable type.
    public var payloadJSON: Data { Data(PrototypeJSONText.string(payload).utf8) }

    /// JSON-encoded state snapshot at this event.
    public var stateJSON: Data { Data(PrototypeJSONText.string(.object(state)).utf8) }

    /// Complete original event JSON, including timestamp, navigation, context, and future fields.
    /// Session-created events have a zero timestamp until the model attaches wall-clock time.
    public var wireJSON: Data {
        embeddedWire ?? (try? JSONSerialization.data(withJSONObject: wireObject(timestamp: 0), options: .sortedKeys))
            ?? Data("{}".utf8)
    }

    /// The terminal reason, when this is a recognized dismissal.
    public var dismissReason: PrototypeDismissReason? {
        guard type == .dismissed, let reason = payload.objectFields?["reason"]?.stringValue else { return nil }
        return PrototypeDismissReason(rawValue: reason)
    }

    /// Maps the model's JSON-compatible wire dictionary, retaining unknown kinds and fields.
    /// Throws Foundation's JSON error if a caller supplies non-JSON values.
    public init(wire: [String: Any]) throws {
        let bytes = try JSONSerialization.data(withJSONObject: wire, options: .sortedKeys)
        let fields = try JSONDecoder().decode([String: JSONValue].self, from: bytes)
        self.init(
            id: fields["id"]?.stringValue ?? "", sequence: fields["sequence"]?.intValue ?? 0,
            kind: fields["kind"]?.stringValue ?? "", name: fields["name"]?.stringValue,
            payload: fields["payload"] ?? .null, state: fields["state"]?.objectFields ?? [:],
            pages: (fields["pages"]?.objectFields ?? [:]).compactMapValues(\.intValue), stacks: [:]
        )
        embeddedWire = bytes
    }
}
