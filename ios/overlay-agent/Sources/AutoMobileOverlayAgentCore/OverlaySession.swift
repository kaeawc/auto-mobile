import Foundation

/// Why an overlay went away; the `reason` in the terminal `dismissed` event's payload.
enum OverlayDismissReason: String {
    /// The host dismiss control or a spec `dismiss` action.
    case user
    /// A `dismiss_overlay` request.
    case agent
    /// The last authenticated host connection closed (or an overlay was shown after that edge), so
    /// a crashed daemon leaves no orphan. Same string as Android.
    case disconnect
    /// The idle TTL elapsed (`OverlayIdleTimer`). Same string as Android.
    case ttl
}

/// One `overlay_event` push, before the wall-clock timestamp is attached.
struct OverlayEvent: Equatable {
    let id: String
    let sequence: Int
    let kind: String
    let name: String?
    let payload: JSONValue
    let state: [String: JSONValue]
    let pages: [String: Int]

    /// The wire object, in the shape of `OverlayEvent` in `ctrlProxyProtocol.ts`.
    func wireObject(timestamp: Int) -> [String: Any] {
        [
            "type": "overlay_event",
            "timestamp": timestamp,
            "id": id,
            "sequence": sequence,
            "kind": kind,
            "name": name as Any? ?? NSNull(),
            "payload": payload.foundationObject,
            "state": JSONValue.object(state).foundationObject,
            "pages": pages,
        ]
    }
}

extension JSONValue {
    /// The `JSONSerialization`-compatible form.
    var foundationObject: Any {
        switch self {
        case .null: NSNull()
        case let .bool(value): value
        case let .number(value): value
        case let .string(value): value
        case let .array(values): values.map(\.foundationObject)
        case let .object(values): values.mapValues(\.foundationObject)
        }
    }
}

/// Device-free overlay transitions, mirroring Android's `OverlayRuntime` and the sequence ledger in
/// `OverlayController`. Each mutation returns the events it produced, already sequenced.
struct OverlaySession {
    private(set) var spec: OverlaySpec?
    private(set) var state: [String: JSONValue] = [:]
    private(set) var pages: [String: Int] = [:]
    private(set) var pageCounts: [String: Int] = [:]
    /// Agent-lifetime ledger, per overlay id and monotonic from 1: re-showing an id after a
    /// dismissal or another overlay never rewinds it, because hosts discard lower-or-equal
    /// sequences as duplicates.
    private var sequences: [String: Int] = [:]

    var isShown: Bool {
        spec != nil
    }

    /// A show of the overlay already on screen replaces it in place: its spec state is
    /// authoritative and each pager that survives keeps its page, matched by id and clamped to the
    /// new page count. Any other show, or one with `reset`, starts fresh: the spec's own state and
    /// every pager on its first page. Event sequences are per id and never rewound either way.
    mutating func show(_ spec: OverlaySpec, reset: Bool = false) {
        let previous = !reset && self.spec?.id == spec.id ? pages : [:]
        pageCounts = spec.root.pagerCounts()
        pages = pageCounts.reduce(into: [:]) { result, entry in
            result[entry.key] = min(max(previous[entry.key] ?? 0, 0), max(entry.value - 1, 0))
        }
        state = spec.state ?? [:]
        self.spec = spec
    }

    func holds(_ condition: Condition) -> Bool {
        condition.holds(state)
    }

    // MARK: Interactions

    /// A tap's actions in order; a `dismiss` ends the overlay and drops the remaining actions.
    /// Android's `OverlayRuntime.tap` (#10622): if any `setState`/`toggle`/`increment`/`decrement`
    /// changed state, exactly one `change` event carrying the final state follows the last action;
    /// `emit` actions fire in order with the state as it was at that point. A list that nets no
    /// change emits nothing.
    mutating func run(_ actions: [OverlayAction]) -> [OverlayEvent] {
        let baseline = state
        var touched: [String] = []
        var events: [OverlayEvent] = []
        for action in actions {
            guard isShown else { break }
            switch action.type {
            case "emit":
                events += emit(kind: "emit", name: action.name, payload: action.payload ?? .null)
            case "setPage":
                events += runSetPage(action)
            case "dismiss":
                events += dismiss(reason: .user)
            default:
                if let key = applyStateAction(action), !touched.contains(key) { touched.append(key) }
            }
        }
        guard isShown else { return events }
        return events + emitStateChange(touched.filter { baseline[$0] != state[$0] })
    }

    /// A `setPage` action: `next`/`prev` step from the current page, a number jumps to it.
    private mutating func runSetPage(_ action: OverlayAction) -> [OverlayEvent] {
        guard let pager = action.pager, let current = pages[pager] else { return [] }
        let target = switch action.page {
        case .string("next"): current + 1
        case .string("prev"): current - 1
        default: action.page?.intValue ?? current
        }
        return setPage(pager, target)
    }

    /// Applies one state action and returns the key it wrote, or nil when it was a no-op. A toggle
    /// of a non-boolean, or an increment/decrement of a non-number or to a non-finite value, is a
    /// no-op, as on Android.
    private mutating func applyStateAction(_ action: OverlayAction) -> String? {
        guard let key = action.key else { return nil }
        let next: JSONValue? = switch action.type {
        case "setState": action.value
        case "toggle": state[key]?.boolValue.map { .bool(!$0) }
        case "increment": stepped(state[key], by: action.by ?? 1)
        case "decrement": stepped(state[key], by: -(action.by ?? 1))
        default: nil
        }
        guard let next else { return nil }
        state[key] = next
        return key
    }

    private func stepped(_ value: JSONValue?, by step: Double) -> JSONValue? {
        guard let next = value?.numberValue.map({ $0 + step }), next.isFinite else { return nil }
        return .number(next)
    }

    /// One key keeps the `{key, value}` payload of `change`; several send `{keys, values}`. The
    /// event's `state` always carries the full final state.
    private mutating func emitStateChange(_ keys: [String]) -> [OverlayEvent] {
        guard let first = keys.first else { return [] }
        let payload: JSONValue = if keys.count == 1 {
            .object(["key": .string(first), "value": state[first] ?? .null])
        } else {
            .object([
                "keys": .array(keys.map(JSONValue.string)),
                "values": .object(Dictionary(uniqueKeysWithValues: keys.map { ($0, state[$0] ?? .null) })),
            ])
        }
        return emit(kind: "emit", name: "change", payload: payload)
    }

    /// Several keys written together, reported by one `change` event (see `emitStateChange`).
    mutating func setStates(_ values: [(String, JSONValue)]) -> [OverlayEvent] {
        guard isShown else { return [] }
        let baseline = state
        values.forEach { state[$0.0] = $0.1 }
        return emitStateChange(values.map(\.0).filter { baseline[$0] != state[$0] })
    }

    /// Test-hook tap (see `OverlayTestHooks`): performs in-process what a real tap on the
    /// identified node or composite part (`<tag>.confirm`, `<tag>.<value>`, ...) does: a toggle
    /// flips its key, an option binds its value, a dialog button closes the dialog, anything else
    /// runs its `onTap`.
    mutating func simulateTap(identifier: String) -> Result<[OverlayEvent], OverlayTapFailure> {
        guard isShown, let spec else { return .failure(.notShown) }
        guard let target = spec.root.tapTarget(identifier: identifier, state: state) else {
            return .failure(.notFound)
        }
        guard let events = activate(target) else { return .failure(.notTappable) }
        return .success(events)
    }

    /// Settled pager position; clamped, and silent when the page does not change.
    mutating func setPage(_ pager: String, _ target: Int) -> [OverlayEvent] {
        guard isShown, let pageCount = pageCounts[pager], pageCount >= 1 else { return [] }
        let clamped = min(max(target, 0), pageCount - 1)
        guard pages[pager] != clamped else { return [] }
        pages[pager] = clamped
        return emit(kind: "page_changed", name: pager, payload: .number(Double(clamped)))
    }

    /// A user edit of a bound control: one `emit` named `change` per changed value, matching
    /// Android's `OverlayRuntime.change`.
    mutating func change(key: String, value: JSONValue) -> [OverlayEvent] {
        guard isShown, state[key] != value else { return [] }
        state[key] = value
        return emit(kind: "emit", name: "change", payload: .object(["key": .string(key), "value": value]))
    }

    /// A `switch` or `checkbox` tap flips its bound boolean, then runs the node's own actions. A key
    /// that no longer holds a boolean leaves the control inert.
    mutating func toggle(key: String, then actions: [OverlayAction]) -> [OverlayEvent] {
        guard isShown, case let .bool(stored)? = state[key] else { return [] }
        return change(key: key, value: .bool(!stored)) + run(actions)
    }

    /// A `tabBar`/`bottomNav` selection drives its pager when it has one, else its state key, then
    /// runs the node's `onTap` actions, as Android's selection does.
    mutating func select(
        index: Int,
        pager: String?,
        key: String?,
        then actions: [OverlayAction] = []
    )
        -> [OverlayEvent]
    {
        guard isShown else { return [] }
        var events: [OverlayEvent] = []
        if let pager {
            events = setPage(pager, index)
        } else if let key {
            events = change(key: key, value: .number(Double(index)))
        }
        return events + run(actions)
    }

    /// The terminal event: every dismissal emits exactly one `dismissed`, carrying its reason.
    mutating func dismiss(reason: OverlayDismissReason) -> [OverlayEvent] {
        guard isShown else { return [] }
        let events = emit(kind: "dismissed", name: nil, payload: .object(["reason": .string(reason.rawValue)]))
        spec = nil
        return events
    }

    private mutating func emit(kind: String, name: String?, payload: JSONValue) -> [OverlayEvent] {
        guard let id = spec?.id else { return [] }
        let sequence = (sequences[id] ?? 0) + 1
        sequences[id] = sequence
        return [OverlayEvent(
            id: id,
            sequence: sequence,
            kind: kind,
            name: name,
            payload: payload,
            state: state,
            pages: pages
        )]
    }

    // MARK: Status

    /// Font asset ids the shown spec names. iOS cannot load an uploaded font, so these are always
    /// reported missing and drawn with the system font.
    func fontAssets() -> [String] {
        guard let spec else { return [] }
        var ids = Set<String>()
        spec.root.collectFontAssets(into: &ids)
        return ids.sorted()
    }

    func missingAssets(available: Set<String>) -> [String] {
        guard let spec else { return [] }
        var ids = Set<String>()
        spec.root.collectAssets(into: &ids)
        return ids.subtracting(available).sorted()
    }
}

extension OverlayNode {
    /// Pager ids and their page counts, so `setPage` can clamp without consulting the view tree.
    func pagerCounts() -> [String: Int] {
        var counts: [String: Int] = [:]
        collectPagers(into: &counts)
        return counts
    }
}

/// Why `simulate_tap` did nothing.
enum OverlayTapFailure: Error, Equatable {
    case notShown
    case notFound
    case notTappable
}

/// Debug-only protocol surface for headless tests, where there is no input path into the
/// simulator. Enabled only when the host sets the flag at launch; production `launchApp` never does.
enum OverlayTestHooks {
    static let environmentKey = "AUTOMOBILE_OVERLAY_AGENT_TEST_HOOKS"
    static let gatedRequestTypes: Set<String> = ["simulate_tap"]

    static func isEnabled(environment: [String: String]) -> Bool {
        environment[environmentKey] == "1"
    }

    /// Capabilities to advertise in `hello_result`: the test hooks are listed only when enabled,
    /// because the host client refuses to send a request type the agent does not advertise.
    static func capabilities(enabled: Bool) -> [String] {
        enabled ? OverlayAgentProtocol.capabilities + gatedRequestTypes.sorted() : OverlayAgentProtocol.capabilities
    }

    /// The error to reply with when `requestType` is a test hook and hooks are off; nil otherwise.
    static func rejection(requestType: String, enabled: Bool) -> String? {
        guard gatedRequestTypes.contains(requestType), !enabled else { return nil }
        return "\(requestType) is a test hook; launch the app with \(environmentKey)=1 to enable it"
    }
}
